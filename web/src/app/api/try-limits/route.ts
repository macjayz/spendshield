import { createPublicClient, formatUnits, http, isAddress, isHex, keccak256, parseUnits, toHex, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { needsApproval, REASON_TEXT, reasonOf, spendShieldAbi, TUSD8_DECIMALS, type Reason } from "@aevum-kit/aevum";
import { defaultNetwork } from "@/lib/env";

/**
 * "Try your limits": ask the real SpendShield contract, live and for free, whether the demo agent
 * could make a payment. `check()` is a read-only call, so nothing is signed, sent or paid.
 *
 *   GET /api/try-limits                     → the demo agent's real budget + a worked example
 *   GET /api/try-limits?amount=0.2&to=shop  → what the contract would do with that payment
 *
 * `to` is "shop" (the approved data shop), "attacker" (the address from the poisoned headline)
 * or any 0x address. Same server env as the live demo: LIVE_DEMO_OWNER, LIVE_DEMO_AGENT_KEY,
 * MERCHANT_ADDRESS.
 */
export const runtime = "nodejs";

const ATTACKER = "0xbad0000000000000000000000000000000000bad" as Address;
const PER_IP = 40;
const WINDOW_MS = 60_000;
const recent = new Map<string, number[]>();

type Target = { id: string; label: string; address: Address };

function setup() {
  const net = defaultNetwork;
  const shield = net.shield;
  const owner = process.env.LIVE_DEMO_OWNER?.trim();
  const shop = process.env.MERCHANT_ADDRESS?.trim();
  const raw = process.env.LIVE_DEMO_AGENT_KEY?.trim();
  const k = (raw?.startsWith("0x") ? raw : `0x${raw ?? ""}`) as Hex;
  if (!shield || !owner || !isAddress(owner) || !shop || !isAddress(shop) || !raw || !isHex(k) || k.length !== 66) return undefined;
  const agent = privateKeyToAccount(k).address;
  const client = createPublicClient({ chain: net.chain, transport: http() }) as PublicClient;
  const targets: Target[] = [
    { id: "shop", label: "The data shop (approved)", address: shop as Address },
    { id: "attacker", label: "The attacker from the poisoned headline", address: ATTACKER },
  ];
  return { net, shield, owner: owner as Address, agent, client, targets };
}

const fmt = (v: bigint) => formatUnits(v, TUSD8_DECIMALS);

export async function GET(req: Request) {
  const s = setup();
  if (!s) return Response.json({ error: "Try-your-limits isn't configured on this server." }, { status: 503 });

  const ip = (req.headers.get(process.env.TRUSTED_IP_HEADER?.trim() || "x-forwarded-for") ?? "local").split(",")[0]!.trim();
  const now = Date.now();
  const mine = (recent.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (mine.length >= PER_IP) return Response.json({ error: "Too many checks. Wait a minute and try again." }, { status: 429 });
  mine.push(now);
  recent.set(ip, mine);

  const { shield, owner, agent, client, targets } = s;
  // A fresh ref each time, so the check never trips the "already paid" rule.
  const ref = () => keccak256(toHex(`try-${now}-${Math.random()}`));
  const check = async (to: Address, amount: bigint): Promise<Reason> =>
    reasonOf(await client.readContract({ address: shield, abi: spendShieldAbi, functionName: "check", args: [owner, agent, to, amount, ref()] }));
  const verdict = (reason: Reason) => ({ reason, allowed: reason === "OK", text: REASON_TEXT[reason], needsApproval: needsApproval(reason) });

  const url = new URL(req.url);
  const amountParam = url.searchParams.get("amount");
  const toParam = url.searchParams.get("to");

  try {
    if (amountParam !== null || toParam !== null) {
      if (!amountParam || !/^\d+(\.\d{1,6})?$/.test(amountParam)) return Response.json({ error: "Enter an amount like 0.05 (up to 6 decimals)." }, { status: 400 });
      const amount = parseUnits(amountParam, TUSD8_DECIMALS);
      const target = targets.find((t) => t.id === toParam);
      const to = target?.address ?? (toParam && isAddress(toParam) ? (toParam as Address) : undefined);
      if (!to) return Response.json({ error: "Pick the shop, the attacker, or paste a 0x address." }, { status: 400 });
      return Response.json({ amount: amountParam, to, label: target?.label, ...verdict(await check(to, amount)) }, { headers: { "cache-control": "no-store" } });
    }

    const [session, left, frozen] = await Promise.all([
      client.readContract({ address: shield, abi: spendShieldAbi, functionName: "sessionOf", args: [owner, agent] }),
      client.readContract({ address: shield, abi: spendShieldAbi, functionName: "remaining", args: [owner, agent] }),
      client.readContract({ address: shield, abi: spendShieldAbi, functionName: "frozen", args: [owner] }),
    ]);
    const p = session.policy;
    const shop = targets[0]!.address;
    const cap = p.maxPerPayment;
    // Worked example, built from the live policy rather than hard-coded numbers.
    const cases = [
      { label: "The agent buys today's news from the approved shop", to: shop, amount: 30_000n },
      { label: "A poisoned headline asks for a big payment to the same shop", to: shop, amount: cap * 3n > 0n ? cap * 3n : 4_500_000n },
      { label: "It asks for a small payment to the attacker", to: ATTACKER, amount: 100_000n },
    ];
    const example = await Promise.all(
      cases.map(async (c) => ({ label: c.label, to: c.to, amount: fmt(c.amount), ...verdict(await check(c.to, c.amount)) })),
    );
    return Response.json(
      {
        owner,
        agent,
        shield,
        frozen,
        active: session.active,
        policy: {
          maxPerPayment: fmt(p.maxPerPayment),
          budgetPerPeriod: fmt(p.budgetPerPeriod),
          periodHours: Number(p.period) / 3600,
          expiresAt: Number(p.expiresAt),
          anyMerchant: p.anyMerchant,
        },
        remaining: fmt(left),
        targets,
        example,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message.split("\n")[0] : String(e) }, { status: 502 });
  }
}
