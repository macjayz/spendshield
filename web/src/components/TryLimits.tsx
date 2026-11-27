"use client";

import { useEffect, useState } from "react";

type Verdict = { reason: string; allowed: boolean; text: string; needsApproval: boolean };
type Case = Verdict & { label: string; to: string; amount: string };
type Info = {
  frozen: boolean;
  active: boolean;
  policy: { maxPerPayment: string; budgetPerPeriod: string; periodHours: number; expiresAt: number; anyMerchant: boolean };
  remaining: string;
  targets: { id: string; label: string; address: string }[];
  example: Case[];
};

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const period = (h: number) => (h === 24 ? "a day" : h % 24 === 0 ? `every ${h / 24} days` : `every ${h} hours`);

/** Asks the real SpendShield contract (a free, read-only check) what it would do with a payment. No wallet, nothing sent. */
export function TryLimits() {
  const [info, setInfo] = useState<Info | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [amount, setAmount] = useState("0.03");
  const [to, setTo] = useState("shop");
  const [custom, setCustom] = useState("");
  const [result, setResult] = useState<(Verdict & { amount: string; to: string; label?: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/try-limits", { cache: "no-store" })
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? `The server answered ${r.status}.`);
        setInfo(j);
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)));
  }, []);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const target = to === "custom" ? custom.trim() : to;
      const r = await fetch(`/api/try-limits?amount=${encodeURIComponent(amount.trim())}&to=${encodeURIComponent(target)}`, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `The server answered ${r.status}.`);
      setResult(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  if (loadError) return null; // not configured here: the rest of the page still works

  const p = info?.policy;
  return (
    <section className="card try-limits">
      <p className="eyebrow">Try your limits · asks the real contract, no wallet</p>
      <h2>What would SpendShield do?</h2>
      <p className="sub">
        The demo agent below has a real budget on Aevum testnet. Pick an amount and who gets paid, and the contract answers. This is a free read-only
        check, so nothing is signed or sent.
      </p>

      {!info ? (
        <p className="fine">Reading the agent&apos;s budget from the contract…</p>
      ) : (
        <>
          <div className="kpis">
            <div className="kpi">
              <span className="fine">Max per payment</span>
              <strong>{p!.maxPerPayment} tUSD8</strong>
            </div>
            <div className="kpi">
              <span className="fine">Budget {period(p!.periodHours)}</span>
              <strong>{p!.budgetPerPeriod} tUSD8</strong>
            </div>
            <div className="kpi">
              <span className="fine">Left right now</span>
              <strong>{info.remaining} tUSD8</strong>
            </div>
            <div className="kpi">
              <span className="fine">Who it can pay</span>
              <strong>{p!.anyMerchant ? "Anyone" : "Approved shops"}</strong>
            </div>
          </div>
          {(info.frozen || !info.active) && (
            <div className="notice warn" style={{ marginTop: 14 }}>
              {info.frozen ? "The demo owner has frozen all agents right now, so every check says Frozen." : "The demo agent's session is inactive right now."}
            </div>
          )}

          <h3 className="try-h3">Worked example, live from the contract</h3>
          <ol className="live-steps">
            {info.example.map((c) => (
              <li key={c.label} className={`live-step ${c.allowed ? "ok" : "blocked"}`}>
                <span className="live-icon" aria-hidden>
                  {c.allowed ? "✓" : "⛔"}
                </span>
                <div>
                  <strong>
                    {c.label}: {c.amount} tUSD8
                  </strong>
                  <p>
                    {c.allowed ? "Allowed: under the cap, inside the budget, and the shop is approved." : `Blocked: ${c.reason}. ${c.text}`}
                  </p>
                </div>
              </li>
            ))}
            <li className="live-step ok">
              <span className="live-icon" aria-hidden>
                0
              </span>
              <div>
                <strong>Attacker received 0 tUSD8</strong>
                <p>Anything blocked can only become an approval request, and only the owner&apos;s own wallet can approve it.</p>
              </div>
            </li>
          </ol>

          <h3 className="try-h3">Your turn</h3>
          <form className="try-form" onSubmit={run}>
            <label>
              <span className="fine">Amount (tUSD8)</span>
              <input className="field" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.05" />
            </label>
            <label>
              <span className="fine">Pay to</span>
              <select className="field" value={to} onChange={(e) => setTo(e.target.value)}>
                {info.targets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label} · {short(t.address)}
                  </option>
                ))}
                <option value="custom">Another address…</option>
              </select>
            </label>
            {to === "custom" && (
              <label className="try-wide">
                <span className="fine">Address</span>
                <input className="field" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="0x…" spellCheck={false} />
              </label>
            )}
            <button className="btn" type="submit" disabled={busy}>
              {busy ? "Asking the contract…" : "Check it"}
            </button>
          </form>

          {error && (
            <div className="notice bad" style={{ marginTop: 14 }}>
              {error}
            </div>
          )}
          {result && (
            <div className={`notice ${result.allowed ? "good" : "bad"}`} style={{ marginTop: 14 }}>
              <strong>
                {result.allowed ? "✓ Allowed" : `⛔ Blocked: ${result.reason}`} · {result.amount} tUSD8 to {result.label ? result.label.charAt(0).toLowerCase() + result.label.slice(1) : short(result.to)}
              </strong>
              <span>{result.text}</span>
              {result.needsApproval && <span className="fine">The agent could ask the owner instead. Nothing moves unless the owner approves with their own wallet.</span>}
            </div>
          )}
        </>
      )}
    </section>
  );
}
