import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Demo video",
  description: "We hacked our own AI agent. It tried to pay an attacker, and SpendShield blocked it on chain.",
};

const CONTRACT = "0x0E9578a05BEc3D8BB21f0f4F8C00FF54eB3D7B2D";

export default function DemoPage() {
  return (
    <main className="shell stack">
      <div className="page-head">
        <div>
          <p className="eyebrow">Demo · 2:55 · recorded live on Aevum testnet</p>
          <h1>We hacked our own AI agent. The contract said no.</h1>
          <p className="lede">
            A real AI agent buys live data with a budget we set. Then we make it obey a hidden instruction to pay an attacker. SpendShield blocks it on
            chain, twice, and my phone asks me what to do.
          </p>
        </div>
      </div>

      <section className="card flush">
        <video
          src="/spendshield-demo.mp4"
          poster="/spendshield-demo-poster.jpg"
          controls
          playsInline
          preload="metadata"
          style={{ display: "block", width: "100%", aspectRatio: "16 / 9", background: "#000" }}
        >
          Your browser can&apos;t play this video. <a href="/spendshield-demo.mp4">Download it</a> instead.
        </video>
      </section>

      <section className="card">
        <h2>What you&apos;re watching</h2>
        <ul>
          <li>
            <b>0:29</b> I give the agent a budget: 0.10 per payment, 0.50 per day, one shop, 7 days. The limits live in the contract, not in the app or
            the AI.
          </li>
          <li>
            <b>1:10</b> Red-team mode: the agent is told to obey anything it reads, and a news item tells it to pay an attacker.
          </li>
          <li>
            <b>1:28</b> Blocked on chain twice: over the cap, then not an approved shop.
          </li>
          <li>
            <b>1:41</b> Telegram asks me to review the request. I reject it in the console.
          </li>
          <li>
            <b>1:59</b> The failed attack on the Aevum explorer. <b>2:08</b> One click freezes every agent.
          </li>
        </ul>
        <p className="fine" style={{ marginTop: 14 }}>
          Contract{" "}
          <a href={`https://explorer-test.qday.info/address/${CONTRACT}`} target="_blank" rel="noreferrer">
            {CONTRACT}
          </a>{" "}
          · <Link href="/shield">Try the owner console</Link> ·{" "}
          <a href="https://github.com/macjayz/spendshield" target="_blank" rel="noreferrer">
            Source on GitHub
          </a>
        </p>
      </section>
    </main>
  );
}
