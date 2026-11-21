/**
 * SpendShield with a smart-account agent on Aevum: Kernel v3.1 + EntryPoint v0.7 + QDay's bundler.
 *
 * The agent is no longer a plain key. It's an ERC-4337 smart account, the kind QDay plans to move to
 * quantum-safe signatures, and SpendShield works with it unchanged:
 *
 *   1. The owner gives the smart account a session (caps, budget, the shop only, an expiry).
 *   2. The smart account buys live data from the shop, paying SpendShield itself in a UserOperation
 *      sent through bundler.qday.info.
 *   3. A hijacked UserOperation to an attacker is refused by the bundler's simulation, because
 *      SpendShield reverts. It never reaches a block and costs nothing.
 *   4. The smart account signs a payment (ERC-1271) and a relayer submits it: the gasless path.
 *   5. The owner revokes the session, and the smart account's next payment is refused.
 *
 *   pnpm example smart-agent
 *
 * Env (examples/.env): RPC_URL, SHIELD_ADDRESS, MERCHANT_API, RELAYER_KEY (also tops up the smart
 * account's gas), SMART_OWNER_KEY (owner whose vault pays; needs tUSD8 deposited), and optionally
 * SMART_AGENT_KEY (the key behind the smart account; defaults to AGENT_KEY), BUNDLER_URL.
 */
import { createKernelAccount, createKernelAccountClient } from "@zerodev/sdk";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { createWalletClient, encodeFunctionData, formatEther, formatUnits, http, keccak256, parseEther, parseUnits, toHex, type Address, type Hash, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { agentPaymentTypedData, aevumTestnet, REASON_TEXT, reasonOf, spendShieldAbi, txUrl } from "@aevum-kit/aevum";
import { connect, requiredAddress, requiredKey } from "./env";

const { client, chain, rpcUrl } = await connect();
const shield = requiredAddress("SHIELD_ADDRESS");
const owner = privateKeyToAccount(requiredKey("SMART_OWNER_KEY"));
const signer = privateKeyToAccount(process.env.SMART_AGENT_KEY?.trim() ? requiredKey("SMART_AGENT_KEY") : requiredKey("AGENT_KEY"));
const relayer = privateKeyToAccount(requiredKey("RELAYER_KEY"));
const bundlerUrl = process.env.BUNDLER_URL?.trim() || "https://bundler.qday.info";
const api = (process.env.MERCHANT_API?.trim() || "https://spendshield-psi.vercel.app/api/paid").replace(/\/+$/, "");
const ATTACKER = "0xbad0000000000000000000000000000000000bad" as Address;
const link = (h: Hash) => (chain.id === aevumTestnet.id ? txUrl(h) : h);
const tusd8 = (v: bigint) => `${formatUnits(v, 6)} tUSD8`;
const ownerWallet = createWalletClient({ account: owner, chain, transport: http(rpcUrl) });
const relayerWallet = createWalletClient({ account: relayer, chain, transport: http(rpcUrl) });

// ── the agent as a Kernel v3.1 smart account ──────────────────────────────────────────────
const entryPoint = getEntryPoint("0.7");
const validator = await signerToEcdsaValidator(client, { signer, entryPoint, kernelVersion: KERNEL_V3_1 });
// Aevum has KernelFactory v3.1 but not ZeroDev's meta-factory, so deploy through the factory directly.
const agent = await createKernelAccount(client, { plugins: { sudo: validator }, entryPoint, kernelVersion: KERNEL_V3_1, useMetaFactory: false });
const bundler = createKernelAccountClient({
  account: agent,
  chain,
  client,
  bundlerTransport: http(bundlerUrl),
  userOperation: {
    // Fees from the node itself; QDay's bundler has no vendor gas-price RPC.
    estimateFeesPerGas: async () => {
      const fee = (await client.getGasPrice()) * 2n + 1_000_000_000n;
      return { maxFeePerGas: fee, maxPriorityFeePerGas: fee };
    },
  },
});
console.log(`🤖 Agent smart account (Kernel v3.1): ${agent.address}`);
console.log(`   Signer key ${signer.address} · bundler ${bundlerUrl} · EntryPoint ${entryPoint.address}\n`);

// Gas for the account's own UserOperations (no tUSD8 paymaster on Aevum yet).
if ((await client.getBalance({ address: agent.address })) < parseEther("0.004")) {
  const h = await relayerWallet.sendTransaction({ to: agent.address, value: parseEther("0.01"), type: "legacy" });
  await client.waitForTransactionReceipt({ hash: h });
  console.log(`⛽ Topped up the smart account with 0.01 tQDAY for its own gas: ${link(h)}`);
}
// Bundlers refuse UserOperations that deploy through an unstaked factory (ERC-7562), so deploy with a plain call.
if (!(await agent.isDeployed())) {
  const { factory, factoryData } = await agent.getFactoryArgs();
  const h = await relayerWallet.sendTransaction({ to: factory!, data: factoryData!, type: "legacy" });
  await client.waitForTransactionReceipt({ hash: h });
  console.log(`🏗️  Deployed the smart account through KernelFactory v3.1: ${link(h)}`);
}

// ── helpers ───────────────────────────────────────────────────────────────────────────────
async function quote(item: string) {
  const res = await fetch(`${api}/${item}?chainId=${chain.id}`);
  const body = await res.json();
  if (res.status !== 402) throw new Error(`Expected a 402 quote for ${item}, got ${res.status}: ${JSON.stringify(body)}`);
  return { merchant: body.accepts.merchant as Address, amount: BigInt(body.accepts.amount), ref: body.accepts.ref as Hex };
}
const check = async (merchant: Address, amount: bigint, ref: Hex) =>
  reasonOf(await client.readContract({ address: shield, abi: spendShieldAbi, functionName: "check", args: [owner.address, agent.address, merchant, amount, ref] }));
/** The smart account pays SpendShield itself: msg.sender is the agent. */
const payCall = (merchant: Address, amount: bigint, ref: Hex) =>
  agent.encodeCalls([{ to: shield, value: 0n, data: encodeFunctionData({ abi: spendShieldAbi, functionName: "pay", args: [owner.address, merchant, amount, ref] }) }]);
async function sendOp(callData: Hex) {
  const op = await bundler.sendUserOperation({ callData });
  const r = await bundler.waitForUserOperationReceipt({ hash: op });
  return { op, ok: r.success, tx: r.receipt.transactionHash };
}

let ok = true;

// ── 1. owner grants the smart account a session ───────────────────────────────────────────
const first = await quote("weather");
const now = (await client.getBlock()).timestamp;
{
  const h = await ownerWallet.writeContract({
    address: shield,
    abi: spendShieldAbi,
    functionName: "grantSession",
    args: [
      agent.address,
      { maxPerPayment: parseUnits("0.10", 6), budgetPerPeriod: parseUnits("0.30", 6), period: 86400, expiresAt: now + 86400n, anyMerchant: false },
      [first.merchant],
    ],
    type: "legacy",
  });
  await client.waitForTransactionReceipt({ hash: h });
  console.log(`🔑 Owner granted the smart account a session: 0.10 per payment, 0.30 a day, the shop only, 1 day\n   ${link(h)}\n`);
}

// ── 2. the smart account buys live data, paying through the bundler ──────────────────────
{
  const reason = await check(first.merchant, first.amount, first.ref);
  console.log(`🛡️  SpendShield check: ${reason}`);
  const { op, ok: paid, tx } = await sendOp(await payCall(first.merchant, first.amount, first.ref));
  ok &&= paid;
  console.log(`${paid ? "💸" : "✗"} UserOperation ${op.slice(0, 12)}… paid ${tusd8(first.amount)} to the shop through QDay's bundler\n   ${link(tx)}`);
  for (let i = 0; i < 4; i++) {
    const res = await fetch(`${api}/weather?chainId=${chain.id}`, { headers: { "X-Payment": `tx:${tx}` } });
    if (res.ok) {
      const { data } = await res.json();
      console.log(`📦 Shop handed over the data: ${data.city} ${data.tempC}°C, ${data.sky}\n`);
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// ── 3. a hijacked UserOperation: pay the attacker ─────────────────────────────────────────
{
  const amount = parseUnits("4.5", 6);
  const ref = keccak256(toHex(`urgent-migration-${Date.now()}`));
  const reason = await check(ATTACKER, amount, ref);
  try {
    await bundler.sendUserOperation({ callData: await payCall(ATTACKER, amount, ref) });
    ok = false;
    console.log("✗ The bundler accepted a UserOperation paying the attacker. That should never happen.");
  } catch (e) {
    console.log(`⛔ Hijacked UserOperation (4.5 tUSD8 to ${ATTACKER}) refused by the bundler's simulation.`);
    console.log(`   SpendShield says ${reason}: ${REASON_TEXT[reason]} It never reached a block and cost nothing.`);
    console.log(`   (${(e as Error).message.split("\n")[0].slice(0, 140)})\n`);
  }
}

// ── 4. gasless path: the smart account signs (ERC-1271), a relayer submits ───────────────
{
  const q = await quote("weather");
  const epoch = (await client.readContract({ address: shield, abi: spendShieldAbi, functionName: "sessionOf", args: [owner.address, agent.address] })).epoch;
  const deadline = now + 3600n;
  const signature = await agent.signTypedData(agentPaymentTypedData(chain.id, shield, { owner: owner.address, merchant: q.merchant, amount: q.amount, ref: q.ref, epoch, deadline }));
  const h = await relayerWallet.writeContract({
    address: shield,
    abi: spendShieldAbi,
    functionName: "payWithSig",
    args: [owner.address, agent.address, q.merchant, q.amount, q.ref, deadline, signature],
    type: "legacy",
  });
  const r = await client.waitForTransactionReceipt({ hash: h });
  ok &&= r.status === "success";
  console.log(`${r.status === "success" ? "✍️ " : "✗"} Smart account signed a payment (ERC-1271), the relayer submitted it: ${tusd8(q.amount)}\n   ${link(h)}\n`);
}

// ── 5. the owner revokes; the smart account can't pay anymore ────────────────────────────
{
  const h = await ownerWallet.writeContract({ address: shield, abi: spendShieldAbi, functionName: "revokeSession", args: [agent.address], type: "legacy" });
  await client.waitForTransactionReceipt({ hash: h });
  console.log(`🧯 Owner revoked the smart account's session: ${link(h)}`);
  const q = await quote("weather");
  const reason = await check(q.merchant, q.amount, q.ref);
  try {
    await bundler.sendUserOperation({ callData: await payCall(q.merchant, q.amount, q.ref) });
    ok = false;
    console.log("✗ A revoked smart account still paid. That should never happen.");
  } catch {
    console.log(`⛔ Its next payment is refused before it reaches a block: ${reason} (${REASON_TEXT[reason]})\n`);
  }
}

const gasLeft = await client.getBalance({ address: agent.address });
console.log(`${ok ? "✅ All checks passed." : "❌ Something didn't behave as expected (see above)."} Smart account gas left: ${formatEther(gasLeft)} tQDAY`);
process.exit(ok ? 0 : 1);
