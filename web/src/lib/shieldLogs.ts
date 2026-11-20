import { spendShieldAbi } from "@aevum-kit/aevum";
import { parseEventLogs, type Address, type Hex, type Log, type PublicClient } from "viem";

/**
 * All SpendShield events since `fromBlock`, fast.
 *
 * Aevum's RPC serves at most 1,000 blocks per eth_getLogs call and the chain grows ~75k blocks a
 * day, so scanning from the deploy block over RPC gets slower every day. The Aevum explorer
 * (Blockscout) answers the whole range in one request, so:
 *   1. the explorer for everything it has indexed (paged, 1,000 logs per page),
 *   2. plus the RPC for the newest 1,000 blocks, so a transaction confirmed seconds ago shows up
 *      before the explorer indexes it,
 *   3. or, if the explorer is unreachable, the RPC in parallel 1,000-block chunks.
 */
export async function getShieldLogs(client: PublicClient, shield: Address, fromBlock: bigint, explorerUrl?: string) {
  const head = await client.getBlockNumber();
  const recentFrom = head > 999n ? head - 999n : 0n;
  let logs: Log[] = [];

  try {
    if (!explorerUrl) throw new Error("no explorer");
    logs = await fromExplorer(explorerUrl, shield, fromBlock);
  } catch {
    logs = await fromRpc(client, shield, fromBlock, head);
  }
  // Newest blocks straight from the chain, merged without duplicates.
  const recent = await client.getLogs({ address: shield, fromBlock: recentFrom > fromBlock ? recentFrom : fromBlock, toBlock: head });
  const seen = new Set(logs.map(key));
  for (const l of recent) if (!seen.has(key(l))) logs.push(l);

  logs.sort((a, b) => Number((a.blockNumber ?? 0n) - (b.blockNumber ?? 0n)) || (a.logIndex ?? 0) - (b.logIndex ?? 0));
  return { head, events: parseEventLogs({ abi: spendShieldAbi, logs }) };
}

const key = (l: Log) => `${l.transactionHash}-${l.logIndex}`;

interface ExplorerLog {
  address: Address;
  topics: (Hex | null)[];
  data: Hex;
  blockNumber: Hex;
  logIndex: Hex;
  transactionHash: Hex;
  transactionIndex: Hex;
}

async function fromExplorer(explorerUrl: string, shield: Address, fromBlock: bigint): Promise<Log[]> {
  const out: Log[] = [];
  let from = fromBlock;
  for (let page = 0; page < 50; page++) {
    const url = `${explorerUrl}/api?module=logs&action=getLogs&fromBlock=${from}&toBlock=latest&address=${shield}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`explorer ${res.status}`);
    const body = (await res.json()) as { status: string; message: string; result: ExplorerLog[] | string };
    if (!Array.isArray(body.result)) {
      if (/no logs/i.test(body.message)) break;
      throw new Error(`explorer: ${body.message}`);
    }
    for (const r of body.result) {
      out.push({
        address: r.address,
        topics: r.topics.filter((t): t is Hex => Boolean(t)) as [Hex, ...Hex[]],
        data: r.data,
        blockNumber: BigInt(r.blockNumber),
        logIndex: Number(r.logIndex),
        transactionHash: r.transactionHash,
        transactionIndex: Number(r.transactionIndex),
        blockHash: null,
        removed: false,
      } as unknown as Log);
    }
    if (body.result.length < 1000) break;
    // A full page: continue from the last block (duplicates are dropped below).
    from = BigInt(body.result[body.result.length - 1].blockNumber);
  }
  const seen = new Set<string>();
  return out.filter((l) => (seen.has(key(l)) ? false : (seen.add(key(l)), true)));
}

async function fromRpc(client: PublicClient, shield: Address, fromBlock: bigint, head: bigint): Promise<Log[]> {
  const ranges: [bigint, bigint][] = [];
  for (let s = fromBlock; s <= head; s += 1000n) ranges.push([s, s + 999n > head ? head : s + 999n]);
  const out: Log[] = [];
  const parallel = 8;
  for (let i = 0; i < ranges.length; i += parallel) {
    const batch = await Promise.all(ranges.slice(i, i + parallel).map(([a, b]) => client.getLogs({ address: shield, fromBlock: a, toBlock: b })));
    for (const logs of batch) out.push(...logs);
  }
  return out;
}
