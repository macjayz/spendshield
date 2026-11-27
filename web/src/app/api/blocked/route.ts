import { createPublicClient, decodeFunctionData, formatUnits, http, type Address, type Hex, type PublicClient } from "viem";
import { links, REASON_TEXT, reasonOf, spendShieldAbi, TUSD8_DECIMALS, txUrl, type Reason } from "@aevum-kit/aevum";
import { getShieldLogs } from "@/lib/shieldLogs";
import { defaultNetwork } from "@/lib/env";

/**
 * Every payment SpendShield has refused on Aevum, counted live.
 *
 * A refused payment reverts, so it leaves no event. The explorer still lists it as a failed
 * transaction to the contract, and decodes SpendShield's `PaymentRejected(uint8 reason)`:
 *   1. txlist for the contract, keep the failed pay / payWithSig calls,
 *   2. decode who tried to pay whom and how much from the calldata,
 *   3. read the reason from the explorer (cached for a day: a mined revert never changes),
 *   4. and, as proof, sum what SpendShield ever paid the attacker address from its AgentPaid events.
 */
export const runtime = "nodejs";

const ATTACKER = "0xbad0000000000000000000000000000000000bad";
const TTL_MS = 60_000;
let cache: { at: number; body: unknown } | undefined;

type ExplorerTx = { hash: Hex; blockNumber: string; timeStamp: string; isError: string; from: Address; input: Hex };

export async function GET() {
  const net = defaultNetwork;
  const shield = net.shield;
  if (!shield || !net.hasExplorer) return Response.json({ error: "The blocked-payment counter isn't available on this network." }, { status: 503 });
  if (cache && Date.now() - cache.at < TTL_MS) return json(cache.body);

  try {
    const from = net.shieldBlock ?? 0n;
    const txs: ExplorerTx[] = [];
    for (let page = 1; page <= 10; page++) {
      const r = await fetch(
        `${links.explorer}/api?module=account&action=txlist&address=${shield}&startblock=${from}&sort=desc&page=${page}&offset=1000`,
        { signal: AbortSignal.timeout(20_000), cache: "no-store" },
      );
      const body = (await r.json()) as { result?: ExplorerTx[] };
      const batch = Array.isArray(body.result) ? body.result : [];
      txs.push(...batch);
      if (batch.length < 1000) break;
    }

    const failed = txs
      .filter((t) => t.isError === "1")
      .map((t) => {
        try {
          const call = decodeFunctionData({ abi: spendShieldAbi, data: t.input });
          if (call.functionName === "payWithSig") {
            const [, agent, merchant, amount] = call.args as unknown as [Address, Address, Address, bigint];
            return { t, agent, merchant, amount };
          }
          if (call.functionName === "pay") {
            const [, merchant, amount] = call.args as unknown as [Address, Address, bigint];
            return { t, agent: t.from, merchant, amount };
          }
        } catch {
          /* not a SpendShield call we know */
        }
        return null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    const withReason = await mapLimit(failed, 6, async (f) => {
      const d = (await fetch(`${links.explorer}/api/v2/transactions/${f.t.hash}`, {
        signal: AbortSignal.timeout(15_000),
        next: { revalidate: 86_400 },
      })
        .then((r) => r.json())
        .catch(() => null)) as { revert_reason?: { parameters?: { value?: string }[] } } | null;
      const code = d?.revert_reason?.parameters?.[0]?.value;
      return { ...f, reason: code !== undefined ? reasonOf(Number(code)) : null };
    });
    // Count only payments SpendShield itself refused (PaymentRejected), not e.g. a stale signature.
    const blocked = withReason.filter((b): b is typeof b & { reason: Reason } => b.reason !== null && b.reason !== "OK");

    const byReason: Partial<Record<Reason, number>> = {};
    let stopped = 0n;
    for (const b of blocked) {
      byReason[b.reason] = (byReason[b.reason] ?? 0) + 1;
      stopped += b.amount;
    }

    const client = createPublicClient({ chain: net.chain, transport: http() }) as PublicClient;
    const { events } = await getShieldLogs(client, shield, from, links.explorer);
    let toAttacker = 0n;
    for (const e of events) {
      if (e.eventName === "AgentPaid" && (e.args as { merchant: Address }).merchant.toLowerCase() === ATTACKER) toAttacker += (e.args as { amount: bigint }).amount;
    }

    const body = {
      blocked: blocked.length,
      stopped: formatUnits(stopped, TUSD8_DECIMALS),
      attackerAttempts: blocked.filter((b) => b.merchant.toLowerCase() === ATTACKER).length,
      paidToAttacker: formatUnits(toAttacker, TUSD8_DECIMALS),
      byReason,
      latest: blocked.slice(0, 6).map((b) => ({
        hash: b.t.hash,
        url: txUrl(b.t.hash),
        time: Number(b.t.timeStamp),
        agent: b.agent,
        merchant: b.merchant,
        toAttacker: b.merchant.toLowerCase() === ATTACKER,
        amount: formatUnits(b.amount, TUSD8_DECIMALS),
        reason: b.reason,
        text: REASON_TEXT[b.reason],
      })),
    };
    cache = { at: Date.now(), body };
    return json(body);
  } catch (e) {
    if (cache) return json(cache.body); // stale beats nothing
    return Response.json({ error: e instanceof Error ? e.message.split("\n")[0] : String(e) }, { status: 502 });
  }
}

function json(body: unknown) {
  return Response.json(body, { headers: { "cache-control": "public, s-maxage=60, stale-while-revalidate=300" } });
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const n = i++;
        out[n] = await fn(items[n]!);
      }
    }),
  );
  return out;
}
