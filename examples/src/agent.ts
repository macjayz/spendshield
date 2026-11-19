/**
 * A demo AI agent that buys data from a pay-per-call API, spending its owner's tUSD8 through
 * SpendShield. It never holds the money, and it can only spend what the owner's policy allows.
 *
 *   for each task:
 *     1. GET the API. It answers 402 with a quote (merchant, amount, ref).
 *     2. Ask SpendShield.check(...) whether the policy allows it. No gas, no guessing.
 *     3. OK            → sign AgentPayment; the relayer (or the agent itself) submits it.
 *        over the cap  → file an approval request for the owner, and wait if WAIT_FOR_APPROVAL=1.
 *        anything else → explain why and move on.
 *     4. Retry the API with the payment proof, get the data.
 *
 *   pnpm example agent
 *   TASKS=market-data,premium-report WAIT_FOR_APPROVAL=1 pnpm example agent
 */
import { createWalletClient, formatUnits, http, isAddress, isHex, type Address, type Hash, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  agentPaymentTypedData,
  approvalRequestTypedData,
  aevumTestnet,
  needsApproval,
  REASON_TEXT,
  reasonOf,
  spendShieldAbi,
  txUrl,
} from "@aevum-kit/aevum";
import { connect, requiredAddress, requiredKey } from "./env";

const { client, chain, rpcUrl } = await connect();
const shield = requiredAddress("SHIELD_ADDRESS");
const owner = requiredAddress("OWNER_ADDRESS");
const agent = privateKeyToAccount(requiredKey("AGENT_KEY"));
const relayerKey = process.env.RELAYER_KEY?.trim();
// With a relayer the agent needs no gas at all: it only signs. Without one it sends its own transactions.
const submitter = createWalletClient({
  account: relayerKey ? privateKeyToAccount(requiredKey("RELAYER_KEY")) : agent,
  chain,
  transport: http(rpcUrl),
});
const api = (process.env.MERCHANT_API?.trim() || "http://localhost:3000/api/paid").replace(/\/+$/, "");
const tasks = (process.env.TASKS?.trim() || "market-data,weather,market-data,premium-report").split(",").map((t) => t.trim());
const waitForApproval = process.env.WAIT_FOR_APPROVAL === "1";
const explorer = chain.id === aevumTestnet.id;

interface Quote {
  chainId: number;
  shield: Address;
  merchant: Address;
  amount: string;
  amountFormatted: string;
  ref: Hex;
}

const log = (icon: string, msg: string) => console.log(`${icon}  ${msg}`);
const show = (hash: Hash) => (explorer ? txUrl(hash) : hash);

log("🤖", `Agent ${agent.address}`);
log("🏦", `Spending from owner ${owner} via SpendShield ${shield} on chain ${chain.id}`);
log("⛽", relayerKey ? `Gasless: relayer ${submitter.account.address} submits` : "Agent pays its own gas");
const left = await client.readContract({ address: shield, abi: spendShieldAbi, functionName: "remaining", args: [owner, agent.address] });
log("💰", `Budget left this period: ${formatUnits(left, 6)} tUSD8\n`);

for (const [i, task] of tasks.entries()) {
  console.log(`── Task ${i + 1}/${tasks.length}: ${task}`);
  try {
    await runTask(task);
  } catch (e) {
    log("❌", e instanceof Error ? e.message : String(e));
  }
  console.log();
}
const after = await client.readContract({ address: shield, abi: spendShieldAbi, functionName: "remaining", args: [owner, agent.address] });
log("💰", `Budget left this period: ${formatUnits(after, 6)} tUSD8`);

async function runTask(resource: string) {
  const url = `${api}/${resource}?chainId=${chain.id}`;
  const first = await fetch(url);
  if (first.ok) return log("📦", JSON.stringify((await first.json()).data));
  if (first.status !== 402) throw new Error(`API answered ${first.status}: ${(await first.json().catch(() => ({}))).error ?? ""}`);

  const quote = ((await first.json()) as { accepts: Quote }).accepts;
  // Never pay into a contract or chain we weren't configured for, whatever the API says.
  if (quote.chainId !== chain.id || quote.shield.toLowerCase() !== shield.toLowerCase()) throw new Error("Quote points at a different chain or contract. Refusing.");
  if (!isAddress(quote.merchant) || !isHex(quote.ref)) throw new Error("Malformed quote. Refusing.");
  const amount = BigInt(quote.amount);
  log("🧾", `Quote: ${quote.amountFormatted} to ${quote.merchant}`);

  const code = await client.readContract({
    address: shield,
    abi: spendShieldAbi,
    functionName: "check",
    args: [owner, agent.address, quote.merchant, amount, quote.ref],
  });
  const reason = reasonOf(code);
  log(reason === "OK" ? "✅" : "🛑", `Policy: ${REASON_TEXT[reason]}`);

  let proof: string;
  if (reason === "OK") {
    proof = `tx:${await pay(quote, amount)}`;
  } else if (needsApproval(reason)) {
    const id = await requestApproval(quote, amount);
    if (!waitForApproval) return log("⏸️", `Asked the owner (request #${id}). Approve it in the web app, then rerun with WAIT_FOR_APPROVAL=1.`);
    if (!(await waitFor(id))) return log("🚫", `Request #${id} was not approved.`);
    proof = `request:${id}`;
  } else {
    return;
  }

  const res = await fetch(url, { headers: { "X-Payment": proof } });
  const body = (await res.json()) as { data?: unknown; error?: string };
  if (!res.ok) throw new Error(`API refused the payment: ${body.error}`);
  log("📦", JSON.stringify(body.data));
}

async function epoch() {
  return (await client.readContract({ address: shield, abi: spendShieldAbi, functionName: "sessionOf", args: [owner, agent.address] })).epoch;
}

async function pay(q: Quote, amount: bigint): Promise<Hash> {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const signature = await agent.signTypedData(
    agentPaymentTypedData(chain.id, shield, { owner, merchant: q.merchant, amount, ref: q.ref, epoch: await epoch(), deadline }),
  );
  const call = {
    account: submitter.account,
    address: shield,
    abi: spendShieldAbi,
    functionName: "payWithSig",
    args: [owner, agent.address, q.merchant, amount, q.ref, deadline, signature],
  } as const;
  await client.simulateContract(call); // a policy change since check() fails here, for free
  const hash = await submitter.writeContract({ ...call, type: "legacy" });
  const r = await client.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`Payment reverted: ${show(hash)}`);
  log("💸", `Paid ${q.amountFormatted}: ${show(hash)}`);
  return hash;
}

async function requestApproval(q: Quote, amount: bigint): Promise<bigint> {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const signature = await agent.signTypedData(
    approvalRequestTypedData(chain.id, shield, { owner, merchant: q.merchant, amount, ref: q.ref, epoch: await epoch(), deadline }),
  );
  const call = {
    account: submitter.account,
    address: shield,
    abi: spendShieldAbi,
    functionName: "requestApprovalWithSig",
    args: [owner, agent.address, q.merchant, amount, q.ref, 3600, deadline, signature],
  } as const;
  const { result: id } = await client.simulateContract(call);
  const hash = await submitter.writeContract({ ...call, type: "legacy" });
  await client.waitForTransactionReceipt({ hash });
  log("🙋", `Asked the owner to approve ${q.amountFormatted} (request #${id}): ${show(hash)}`);
  return id;
}

async function waitFor(id: bigint): Promise<boolean> {
  log("⏳", "Waiting up to 10 minutes for the owner…");
  for (let i = 0; i < 120; i++) {
    const q = await client.readContract({ address: shield, abi: spendShieldAbi, functionName: "requestOf", args: [id] });
    if (q.status === 2) return log("👍", "Owner approved."), true;
    if (q.status === 3) return false;
    await new Promise((r) => setTimeout(r, 5000));
  }
  return false;
}
