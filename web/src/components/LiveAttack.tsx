"use client";

import { useState } from "react";

type Step = { id: string; status: "run" | "ok" | "blocked" | "info" | "error"; title: string; detail?: string; tx?: string };

const ICON: Record<Step["status"], string> = { run: "…", ok: "✓", blocked: "⛔", info: "!", error: "×" };

/** One click replays the prompt-injection attack on Aevum testnet and streams each step as it lands. */
export function LiveAttack({ compact = false }: { compact?: boolean }) {
  const [steps, setSteps] = useState<Step[]>([]);
  const [state, setState] = useState<"idle" | "running" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setSteps([]);
    setError(null);
    setState("running");
    try {
      const res = await fetch("/api/live-demo", { method: "POST" });
      if (!res.ok || !res.body) {
        setError((await res.json().catch(() => null))?.error ?? `The server answered ${res.status}.`);
        setState("idle");
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const s = JSON.parse(line) as Step;
          setSteps((prev) => {
            const i = prev.findIndex((p) => p.id === s.id);
            if (i === -1) return [...prev, s];
            const next = prev.slice();
            next[i] = s;
            return next;
          });
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setState("done");
  }

  const blocked = steps.filter((s) => s.status === "blocked" && s.id.startsWith("attack")).length;
  const finished = steps.some((s) => s.id === "done");

  return (
    <section className="card live-attack">
      <div className="live-head">
        <div>
          <p className="eyebrow">Try it yourself · real transactions on Aevum testnet</p>
          <h2>Run the attack live</h2>
          {!compact && (
            <p className="sub">
              An agent buys the news. One headline hides an order to pay an attacker, and the agent obeys it. Watch SpendShield stop it on chain. No
              wallet needed, takes about 30 seconds.
            </p>
          )}
        </div>
        <button className="btn big" onClick={start} disabled={state === "running"}>
          {state === "running" ? "Running on Aevum…" : state === "done" ? "Run it again" : "▶ Run the attack live"}
        </button>
      </div>

      {(steps.length > 0 || error) && (
        <ol className="live-steps" aria-live="polite">
          {steps.map((s) => (
            <li key={s.id} className={`live-step ${s.status}`}>
              <span className="live-icon" aria-hidden>
                {ICON[s.status]}
              </span>
              <div>
                <strong>{s.title}</strong>
                {s.detail && <p>{s.detail}</p>}
                {s.tx && (
                  <a href={s.tx} target="_blank" rel="noreferrer" className="fine">
                    {s.status === "blocked" ? "See the failed transaction on the explorer ↗" : "See the transaction on the explorer ↗"}
                  </a>
                )}
              </div>
            </li>
          ))}
          {error && (
            <li className="live-step error">
              <span className="live-icon" aria-hidden>
                ×
              </span>
              <div>
                <strong>Couldn&apos;t run it</strong>
                <p>{error}</p>
              </div>
            </li>
          )}
        </ol>
      )}

      {(state !== "idle" || steps.length > 0) && (
        <div className="kpis live-score">
          <div className="kpi">
            <span className="fine">Attacks blocked on chain</span>
            <strong>{blocked}</strong>
          </div>
          <div className="kpi">
            <span className="fine">Attacker received</span>
            <strong className={finished ? "good-text" : undefined}>0 tUSD8</strong>
          </div>
        </div>
      )}
      <p className="fine" style={{ marginTop: 12 }}>
        The agent here is a script that does exactly what the poisoned headline says. In the demo video a real AI (Claude) makes the same calls. Either way,
        the contract decides.
      </p>
    </section>
  );
}
