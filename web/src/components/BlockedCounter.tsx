"use client";

import { useEffect, useState } from "react";

type Blocked = {
  blocked: number;
  stopped: string;
  attackerAttempts: number;
  paidToAttacker: string;
  byReason: Record<string, number>;
  latest: { hash: string; url: string; time: number; merchant: string; toAttacker: boolean; amount: string; reason: string; text: string }[];
};

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
function ago(t: number) {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - t);
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}

/** Every payment SpendShield refused on chain, with proof links. Refreshes once a minute. */
export function BlockedCounter() {
  const [data, setData] = useState<Blocked | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    const load = () =>
      fetch("/api/blocked")
        .then(async (r) => {
          if (!r.ok) throw new Error(String(r.status));
          const j = (await r.json()) as Blocked;
          if (live) setData(j);
        })
        .catch(() => live && setFailed(true));
    load();
    const id = setInterval(load, 60_000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);

  if (failed && !data) return null; // no explorer here: the rest of the page still works

  return (
    <section className="card">
      <p className="eyebrow">Proof · read from Aevum, refreshed every minute</p>
      <h2>Attacks blocked so far</h2>
      <p className="sub">
        Every payment SpendShield has refused on chain, including every press of &quot;Run the attack live&quot;. A refused payment leaves no event, so
        this counts the failed transactions the explorer records and the reason the contract gave.
      </p>
      {!data ? (
        <p className="fine">Counting blocked payments…</p>
      ) : (
        <>
          <div className="kpis">
            <div className="kpi">
              <span className="fine">Payments blocked on chain</span>
              <strong>{data.blocked}</strong>
            </div>
            <div className="kpi">
              <span className="fine">Amount stopped</span>
              <strong>{data.stopped} tUSD8</strong>
            </div>
            <div className="kpi">
              <span className="fine">Tries to pay the attacker</span>
              <strong>{data.attackerAttempts}</strong>
            </div>
            <div className="kpi">
              <span className="fine">Attacker received</span>
              <strong className="good-text">{data.paidToAttacker} tUSD8</strong>
            </div>
          </div>
          {data.latest.length > 0 && (
            <div className="table-wrap" style={{ marginTop: 16 }}>
              <table className="data">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Tried to pay</th>
                    <th className="right">Amount</th>
                    <th>Why it was blocked</th>
                    <th>Proof</th>
                  </tr>
                </thead>
                <tbody>
                  {data.latest.map((b) => (
                    <tr key={b.hash}>
                      <td>{ago(b.time)}</td>
                      <td>{b.toAttacker ? <span className="tag bad">attacker {short(b.merchant)}</span> : short(b.merchant)}</td>
                      <td className="right">{b.amount} tUSD8</td>
                      <td title={b.text}>{b.reason}</td>
                      <td>
                        <a href={b.url} target="_blank" rel="noreferrer">
                          failed tx ↗
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
