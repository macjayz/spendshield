"use client";

import { addressUrl, erc20Abi, links, PERIODS, spendShieldAbi, TUSD8_ADDRESS, txUrl } from "@aevum-kit/aevum";
import { getShieldLogs } from "@/lib/shieldLogs";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { formatUnits, isAddress, parseUnits, type Address, type Hash, type PublicClient } from "viem";
import { useAccount, useConfig, usePublicClient, useReadContract } from "wagmi";
import { readContract, simulateContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { explain } from "@/lib/errors";
import { useNetwork } from "@/lib/network";
import { short } from "@/lib/order";

const DECIMALS = 6;
const fmt = (v: bigint | undefined) => (v === undefined ? "…" : Number(formatUnits(v, DECIMALS)).toLocaleString("en-US", { maximumFractionDigits: 6 }));
const STATUS = ["—", "Pending", "Approved", "Rejected"] as const;

export default function ShieldPage() {
  const { net } = useNetwork();
  const chainId = net.chain.id;
  const shield = net.shield;
  const config = useConfig();
  const qc = useQueryClient();
  const client = usePublicClient({ chainId }) as PublicClient | undefined;
  const { address: me, isConnected, chainId: walletChain } = useAccount();
  const ready = Boolean(shield && me && isConnected && walletChain === chainId);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ label: string; hash: Hash } | null>(null);

  // ------------------------------------------------------------ reads
  const token = useReadContract({ address: shield, abi: spendShieldAbi, functionName: "token", chainId, query: { enabled: Boolean(shield) } });
  const tokenAddr = (token.data ?? TUSD8_ADDRESS) as Address;
  const wallet = useReadContract({ address: tokenAddr, abi: erc20Abi, functionName: "balanceOf", args: me ? [me] : undefined, chainId, query: { enabled: ready } });
  const vault = useReadContract({ address: shield, abi: spendShieldAbi, functionName: "balanceOf", args: me ? [me] : undefined, chainId, query: { enabled: ready } });
  const frozen = useReadContract({ address: shield, abi: spendShieldAbi, functionName: "frozen", args: me ? [me] : undefined, chainId, query: { enabled: ready } });

  // Public, no wallet needed: what every vault's agents have done, so visitors see it working first.
  const network = useQuery({
    queryKey: ["shield-network", chainId, shield],
    enabled: Boolean(client && shield),
    refetchInterval: 20_000,
    queryFn: async () => {
      const [{ events }, tvl] = await Promise.all([
        getShieldLogs(client!, shield!, net.shieldBlock ?? 0n, net.hasExplorer ? links.explorer : undefined),
        client!.readContract({ address: tokenAddr, abi: erc20Abi, functionName: "balanceOf", args: [shield!] }),
      ]);
      const paid = events.filter((e) => e.eventName === "AgentPaid") as Extract<(typeof events)[number], { eventName: "AgentPaid" }>[];
      const volume = paid.reduce((sum, l) => sum + (l.args.amount ?? 0n), 0n);
      return {
        tvl,
        volume,
        count: paid.length,
        agents: new Set(paid.map((l) => l.args.agent)).size,
        owners: new Set(paid.map((l) => l.args.owner)).size,
        latest: [...paid].reverse().slice(0, 6),
      };
    },
  });

  const history = useQuery({
    queryKey: ["shield-history", chainId, shield, me],
    enabled: Boolean(client && ready),
    refetchInterval: 15_000,
    queryFn: async () => {
      // Everything since SpendShield was deployed (explorer + newest blocks from the chain).
      const from = net.shieldBlock ?? 0n;
      const { head, events } = await getShieldLogs(client!, shield!, from, net.hasExplorer ? links.explorer : undefined);
      type Ev = (typeof events)[number];
      const mine = <N extends Ev["eventName"]>(name: N) =>
        events.filter((e) => e.eventName === name && (e.args as { owner?: string }).owner?.toLowerCase() === me!.toLowerCase()) as Extract<Ev, { eventName: N }>[];
      const grants = mine("SessionGranted");
      const asks = mine("ApprovalRequested");
      const paid = mine("AgentPaid");

      const agents = [...new Set(grants.map((g) => g.args.agent as Address))];
      const sessions = await Promise.all(
        agents.map(async (agent) => {
          const [s, left] = await Promise.all([
            client!.readContract({ address: shield!, abi: spendShieldAbi, functionName: "sessionOf", args: [me!, agent] }),
            client!.readContract({ address: shield!, abi: spendShieldAbi, functionName: "remaining", args: [me!, agent] }),
          ]);
          return { agent, s, left };
        }),
      );
      const requests = await Promise.all(
        asks.map(async (a) => ({
          id: a.args.id!,
          hash: a.transactionHash,
          q: await client!.readContract({ address: shield!, abi: spendShieldAbi, functionName: "requestOf", args: [a.args.id!] }),
        })),
      );
      // Pending requests first, each group in the order the agent asked (#1, #2, …), so row order matches the numbers.
      const now = BigInt(Math.floor(Date.now() / 1000));
      const open = (r: (typeof requests)[number]) => r.q.status === 1 && r.q.expiresAt > now;
      requests.sort((a, b) => Number(open(b)) - Number(open(a)) || Number(a.id - b.id));
      return { sessions, requests, paid: [...paid].reverse(), from, head };
    },
  });

  // Links like /shield#request-3 (from the Telegram alert) scroll to that request once it has loaded.
  const [focusId, setFocusId] = useState<string | null>(null);
  useEffect(() => {
    const read = () => setFocusId(/^#request-(\d+)$/.exec(window.location.hash)?.[1] ?? null);
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  useEffect(() => {
    if (focusId && history.data) document.getElementById(`request-${focusId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusId, history.data]);

  function refresh() {
    void qc.invalidateQueries();
  }

  /** Simulate (free, shows the revert reason), send, wait. */
  async function send(label: string, fn: () => Promise<Hash>) {
    setBusy(label);
    setError(null);
    setDone(null);
    try {
      const hash = await fn();
      const r = await waitForTransactionReceipt(config, { hash, chainId });
      if (r.status !== "success") throw new Error("The transaction reverted.");
      setDone({ label, hash });
      refresh();
    } catch (e) {
      setError(explainShield(e));
    } finally {
      setBusy(null);
    }
  }

  async function call(functionName: string, args: readonly unknown[]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { request } = await simulateContract(config, { account: me!, address: shield!, abi: spendShieldAbi, functionName, args, chainId } as any);
    return writeContract(config, request);
  }

  // ------------------------------------------------------------ forms
  const [amount, setAmount] = useState("1");
  const [agent, setAgent] = useState("");
  const [perTx, setPerTx] = useState("0.1");
  const [budget, setBudget] = useState("0.5");
  const [period, setPeriod] = useState<keyof typeof PERIODS>("day");
  const [days, setDays] = useState("7");
  const [anyMerchant, setAnyMerchant] = useState(false);
  const [merchants, setMerchants] = useState("");

  const merchantList = merchants.split(/[\s,]+/).filter(Boolean);
  const badMerchant = merchantList.find((m) => !isAddress(m));
  const grantProblem = !isAddress(agent)
    ? "Enter the agent's address."
    : agent.toLowerCase() === me?.toLowerCase()
      ? "Use a separate address for the agent, not your own wallet."
      : badMerchant
        ? `Not an address: ${badMerchant}`
        : !anyMerchant && merchantList.length === 0
          ? "Add at least one merchant, or allow any merchant."
          : Number(budget) < Number(perTx)
            ? "The period budget must be at least the per-payment cap."
            : Number(perTx) <= 0 || !(Number(days) > 0)
              ? "Caps and duration must be above zero."
              : null;

  async function deposit() {
    const value = parseUnits(amount, DECIMALS);
    await send("Deposit", async () => {
      const allowance = await readContract(config, { address: tokenAddr, abi: erc20Abi, functionName: "allowance", args: [me!, shield!], chainId });
      if (allowance < value) {
        setBusy("Approve tUSD8 (exact amount)");
        const h = await writeContract(config, { address: tokenAddr, abi: erc20Abi, functionName: "approve", args: [shield!, value], chainId });
        await waitForTransactionReceipt(config, { hash: h, chainId });
        setBusy("Deposit");
      }
      return call("deposit", [value]);
    });
  }

  async function grant() {
    const policy = {
      maxPerPayment: parseUnits(perTx, DECIMALS),
      budgetPerPeriod: parseUnits(budget, DECIMALS),
      period: PERIODS[period],
      expiresAt: BigInt(Math.floor(Date.now() / 1000) + Math.round(Number(days) * 86400)),
      anyMerchant,
    };
    await send("Grant session", () => call("grantSession", [agent as Address, policy, merchantList as Address[]]));
  }

  // ------------------------------------------------------------ render
  if (!shield) {
    return (
      <main className="shell">
        <div className="card empty">
          No SpendShield configured for {net.label}. Set <code>NEXT_PUBLIC_SHIELD_{net.key.toUpperCase()}</code> in <code>web/.env.local</code>.
        </div>
      </main>
    );
  }

  const h = history.data;
  return (
    <main className="shell stack">
      <div className="page-head">
        <div>
          <p className="eyebrow">Owner console · {net.label}</p>
          <h1>Give your AI agents a budget, not your wallet</h1>
          <p className="lede">
            Park tUSD8 in your SpendShield vault, then let each agent spend inside limits you set: per-payment cap, budget per period,
            approved merchants and an expiry. Revoke one agent or freeze them all in one click.
          </p>
        </div>
      </div>

      <section className="card">
        <div className="row-between" style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 10, alignItems: "baseline" }}>
          <h2>Live on {net.label}</h2>
          {net.hasExplorer && (
            <a className="fine" href={addressUrl(shield)} target="_blank" rel="noreferrer">
              SpendShield contract {short(shield)} ↗
            </a>
          )}
        </div>
        <p className="sub">Every vault, every agent. Read straight from the chain, no wallet needed.</p>
        <div className="kpis">
          <div className="kpi">
            <span className="fine">Held in vaults</span>
            <strong>{fmt(network.data?.tvl)} tUSD8</strong>
          </div>
          <div className="kpi">
            <span className="fine">Agent payments</span>
            <strong>{network.data ? network.data.count : "…"}</strong>
          </div>
          <div className="kpi">
            <span className="fine">Paid by agents</span>
            <strong>{fmt(network.data?.volume)} tUSD8</strong>
          </div>
          <div className="kpi">
            <span className="fine">Agents · owners</span>
            <strong>{network.data ? `${network.data.agents} · ${network.data.owners}` : "…"}</strong>
          </div>
        </div>
        {network.data && network.data.latest.length > 0 && (
          <div className="table-wrap" style={{ marginTop: 16 }}>
            <table className="data">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Paid</th>
                  <th className="right">Amount</th>
                  <th className="right">Block</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {network.data.latest.map((l) => (
                  <tr key={`${l.transactionHash}-${l.logIndex}`}>
                    <td className="mono">{short(l.args.agent ?? "")}</td>
                    <td className="mono">{short(l.args.merchant ?? "")}</td>
                    <td className="right num">{fmt(l.args.amount)} tUSD8</td>
                    <td className="right num">{l.blockNumber?.toString()}</td>
                    <td>
                      {net.hasExplorer && (
                        <a href={txUrl(l.transactionHash)} target="_blank" rel="noreferrer">
                          Tx
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {network.error && <p className="fine">Couldn&apos;t read the chain: {(network.error as Error).message}</p>}
      </section>

      {!ready && <div className="notice warn">Connect your wallet on {net.label} to manage your vault.</div>}
      {busy && <div className="notice warn" aria-live="polite">{busy}: confirm in your wallet, then wait for Aevum…</div>}
      {error && <div className="notice bad" aria-live="polite">{error}</div>}
      {done && (
        <div className="notice good" aria-live="polite">
          {done.label} confirmed.{" "}
          {net.hasExplorer ? (
            <a href={txUrl(done.hash)} target="_blank" rel="noreferrer">
              View transaction
            </a>
          ) : (
            <code>{short(done.hash)}</code>
          )}
        </div>
      )}

      <section className="card">
        <div className="kpis">
          <div className="kpi">
            <span className="fine">In your wallet</span>
            <strong>{fmt(wallet.data)} tUSD8</strong>
          </div>
          <div className="kpi">
            <span className="fine">In your vault (agents spend from here)</span>
            <strong>{fmt(vault.data)} tUSD8</strong>
          </div>
          <div className="kpi">
            <span className="fine">Agent spending</span>
            <strong style={{ color: frozen.data === undefined ? undefined : frozen.data ? "var(--bad)" : "var(--good)" }}>
              {frozen.data === undefined ? "…" : frozen.data ? "Frozen" : "Live"}
            </strong>
          </div>
        </div>
        <div className="form" style={{ marginTop: 18 }}>
          <label>
            Amount (tUSD8)
            <input className="field" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
        </div>
        <div className="actions">
          <button className="btn" disabled={!ready || !!busy || !(Number(amount) > 0)} onClick={deposit}>
            Deposit
          </button>
          <button className="btn secondary" disabled={!ready || !!busy || !(Number(amount) > 0)} onClick={() => send("Withdraw", () => call("withdraw", [parseUnits(amount, DECIMALS), me!]))}>
            Withdraw
          </button>
          <button
            className={`btn ${frozen.data ? "" : "warn"}`}
            style={{ marginLeft: "auto" }}
            disabled={!ready || !!busy}
            onClick={() => send(frozen.data ? "Unfreeze" : "Freeze all agents", () => call("setFrozen", [!frozen.data]))}
          >
            {frozen.data ? "Unfreeze agents" : "Freeze all agents"}
          </button>
        </div>
      </section>

      <section className="card">
        <h2>Give an agent a budget</h2>
        <p className="sub">The agent signs with its own key. It can never withdraw, and it can only pay inside these limits.</p>
        <div className="form">
          <label className="wide">
            Agent address
            <input className="field" placeholder="0x…" value={agent} onChange={(e) => setAgent(e.target.value.trim())} />
          </label>
          <label>
            Max per payment (tUSD8)
            <input className="field" inputMode="decimal" value={perTx} onChange={(e) => setPerTx(e.target.value)} />
          </label>
          <label>
            Budget per period (tUSD8)
            <input className="field" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} />
          </label>
          <label>
            Period
            <select className="field" value={period} onChange={(e) => setPeriod(e.target.value as keyof typeof PERIODS)}>
              <option value="hour">Hour</option>
              <option value="day">Day</option>
              <option value="week">Week</option>
            </select>
          </label>
          <label>
            Expires after (days)
            <input className="field" inputMode="decimal" value={days} onChange={(e) => setDays(e.target.value)} />
          </label>
          <label className="wide">
            Approved merchants (addresses, comma or space separated)
            <input className="field" placeholder="0x…, 0x…" disabled={anyMerchant} value={merchants} onChange={(e) => setMerchants(e.target.value)} />
          </label>
          <label className="inline wide">
            <input type="checkbox" checked={anyMerchant} onChange={(e) => setAnyMerchant(e.target.checked)} />
            Let this agent pay any merchant (riskier)
          </label>
        </div>
        {grantProblem && agent && <p className="fine" style={{ marginTop: 10 }}>{grantProblem}</p>}
        <div className="actions">
          <button className="btn" disabled={!ready || !!busy || Boolean(grantProblem)} onClick={grant}>
            Grant session
          </button>
        </div>
      </section>

      <section className="card flush">
        <div style={{ padding: "18px 20px 0" }}>
          <h2>Your agents</h2>
          <p className="sub">Re-granting an agent replaces its policy and voids anything it signed before.</p>
        </div>
        {h && h.sessions.length === 0 && <p className="empty">No agents yet.</p>}
        {h && h.sessions.length > 0 && (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Status</th>
                  <th className="right">Per payment</th>
                  <th>Spent this period</th>
                  <th className="right">Can still spend</th>
                  <th className="right">Lifetime</th>
                  <th>Expires</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {h.sessions.map(({ agent: a, s, left }) => {
                  const expired = Number(s.policy.expiresAt) * 1000 < Date.now();
                  const periodOver = Date.now() / 1000 >= Number(s.periodStart) + s.policy.period;
                  const spent = periodOver ? 0n : s.spentInPeriod;
                  const pct = s.policy.budgetPerPeriod ? Number((spent * 100n) / s.policy.budgetPerPeriod) : 0;
                  return (
                    <tr key={a}>
                      <td className="mono">{short(a)}</td>
                      <td>
                        <span className="tag">{!s.active ? "Revoked" : expired ? "Expired" : frozen.data ? "Frozen" : "Active"}</span>
                      </td>
                      <td className="right num">{fmt(s.policy.maxPerPayment)}</td>
                      <td>
                        <div className={`meter ${pct > 80 ? "hot" : ""}`} title={`${pct}%`}>
                          <span style={{ width: `${Math.min(pct, 100)}%` }} />
                        </div>
                        <span className="fine">
                          {fmt(spent)} / {fmt(s.policy.budgetPerPeriod)} per {periodName(s.policy.period)}
                        </span>
                      </td>
                      <td className="right num">{fmt(left)}</td>
                      <td className="right num">{fmt(s.totalSpent)}</td>
                      <td className="fine">{new Date(Number(s.policy.expiresAt) * 1000).toLocaleString()}</td>
                      <td>
                        {s.active && (
                          <button className="btn small warn" disabled={!!busy} onClick={() => send("Revoke agent", () => call("revokeSession", [a]))}>
                            Revoke
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card flush">
        <div style={{ padding: "18px 20px 0" }}>
          <h2>Approval requests</h2>
          <p className="sub">When an agent wants to pay more than its cap, or a merchant you didn&apos;t list, it has to ask you first.</p>
        </div>
        {h && h.requests.length === 0 && <p className="empty">No requests.</p>}
        {h && h.requests.length > 0 && (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Agent</th>
                  <th>Pay to</th>
                  <th className="right">Amount</th>
                  <th>Status</th>
                  <th>Expires</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {h.requests.map(({ id, q }) => {
                  const expired = Number(q.expiresAt) * 1000 < Date.now();
                  const pending = q.status === 1 && !expired;
                  return (
                    <tr key={id.toString()} id={`request-${id}`} className={focusId === id.toString() ? "focus" : undefined}>
                      <td className="num">{id.toString()}</td>
                      <td className="mono">{short(q.agent)}</td>
                      <td className="mono">{short(q.merchant)}</td>
                      <td className="right num">{fmt(q.amount)} tUSD8</td>
                      <td>
                        <span className="tag">{q.status === 1 && expired ? "Expired" : STATUS[q.status]}</span>
                      </td>
                      <td className="fine">{new Date(Number(q.expiresAt) * 1000).toLocaleTimeString()}</td>
                      <td style={{ display: "flex", gap: 8 }}>
                        {pending && (
                          <>
                            <button className="btn small" disabled={!!busy} onClick={() => send(`Approve request #${id}`, () => call("approveRequest", [id]))}>
                              Approve #{id.toString()} &amp; pay
                            </button>
                            <button className="btn small secondary" disabled={!!busy} onClick={() => send(`Reject request #${id}`, () => call("rejectRequest", [id]))}>
                              Reject #{id.toString()}
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card flush">
        <div style={{ padding: "18px 20px 0" }}>
          <h2>Agent payments</h2>
          <p className="sub">
            Every <code>AgentPaid</code> event from your vault{h ? `, blocks ${h.from}–${h.head}` : ""}.
          </p>
        </div>
        {history.isFetching && !h && <p className="empty">Reading Aevum, 1,000 blocks at a time…</p>}
        {history.error && <p className="empty">Couldn&apos;t read events: {(history.error as Error).message}</p>}
        {h && h.paid.length === 0 && <p className="empty">No payments yet.</p>}
        {h && h.paid.length > 0 && (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Merchant</th>
                  <th className="right">Amount</th>
                  <th>Ref</th>
                  <th className="right">Block</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {h.paid.map((l) => (
                  <tr key={`${l.transactionHash}-${l.logIndex}`}>
                    <td className="mono">{short(l.args.agent ?? "")}</td>
                    <td className="mono">{short(l.args.merchant ?? "")}</td>
                    <td className="right num">{fmt(l.args.amount)} tUSD8</td>
                    <td className="mono">{short(l.args.ref ?? "")}</td>
                    <td className="right num">{l.blockNumber?.toString()}</td>
                    <td>
                      {net.hasExplorer && (
                        <a href={txUrl(l.transactionHash)} target="_blank" rel="noreferrer">
                          Tx
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

function periodName(seconds: number) {
  return seconds === PERIODS.hour ? "hour" : seconds === PERIODS.day ? "day" : seconds === PERIODS.week ? "week" : `${seconds}s`;
}

/** SpendShield's custom errors in plain words, falling back to the kit's generic explainer. */
function explainShield(e: unknown): string {
  const msg = e instanceof Error ? `${e.message} ${(e as { shortMessage?: string }).shortMessage ?? ""}` : "";
  const map: [RegExp, string][] = [
    [
      /not been authorized by the user|Unauthorized/i,
      "Your wallet hasn't given this site permission to send transactions. In MetaMask, disconnect localhost:3000, refresh this page, then connect again and allow QDay Aevum Testnet.",
    ],
    [/InvalidPolicy/, "That policy isn't valid: caps must be above zero, the budget at least the per-payment cap, and the expiry in the future."],
    [/InsufficientBalance/, "Your vault doesn't hold enough tUSD8 for that."],
    [/RequestExpired/, "That request expired. The agent has to ask again."],
    [/RequestNotPending/, "That request was already settled."],
    [/RefAlreadyUsed/, "That payment reference was already paid."],
    [/ZeroAmount/, "The amount must be more than zero."],
  ];
  for (const [re, text] of map) if (re.test(msg)) return text;
  return explain(e);
}
