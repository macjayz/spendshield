/**
 * SpendShield Telegram alerts: your phone buzzes when an agent asks you to approve a payment.
 *
 * A small bot that watches SpendShield on Aevum and messages every chat subscribed to an owner:
 *   🙋 an agent asks for approval (with a button that opens that request in the owner console)
 *   💸 an agent paid a merchant
 *   ✅/❌ a request was approved or rejected
 *   🧊 agents were frozen or unfrozen, 🔒 an agent was revoked
 *
 * Request floods are grouped. An agent that files more than BURST_LIMIT requests within BURST_WINDOW_MIN
 * minutes gets one warning, and anything after that arrives as a single summary instead of one buzz
 * per request, so a hijacked or looping agent can't wear the owner down with alerts.
 * Blocked payments are reported too. A payment SpendShield refuses reverts, so it leaves no event; the
 * bot reads SpendShield's failed transactions from the Aevum explorer instead and tells the owner who
 * tried to pay whom, and why it was refused. A burst of them (a likely compromised agent) is grouped
 * into one alarm. Refusals that never reach the chain (a relayer's free check, a bundler's simulation)
 * cost nothing and are not seen here.
 * With DAILY_SUMMARY=HH:MM (your computer's time), every watched vault also gets one daily review:
 * pending requests grouped by agent, and the day's payments.
 *
 * In Telegram:  /watch 0xYourOwnerAddress   /unwatch 0x...   /list   /status
 *
 *   pnpm example notifier
 *
 * Needs TELEGRAM_BOT_TOKEN (from @BotFather) and SHIELD_ADDRESS in examples/.env. Subscriptions and
 * progress are kept in examples/.notifier-state.json. Nothing here can move money: approving still
 * needs the owner's wallet, in the console.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeFunctionData, formatUnits, getAbiItem, isAddress, type Address, type Hex } from "viem";
import { aevumTestnet, getLogsChunked, links, REASON_TEXT, reasonOf, spendShieldAbi, txUrl } from "@aevum-kit/aevum";
import { connect, required, requiredAddress } from "./env";

const TOKEN = required("TELEGRAM_BOT_TOKEN");
const shield = requiredAddress("SHIELD_ADDRESS");
const APP_URL = (process.env.APP_URL?.trim() || "https://spendshield-psi.vercel.app").replace(/\/+$/, "");
const POLL_MS = 5000;
const BURST_LIMIT = Number(process.env.BURST_LIMIT ?? 3);
const BURST_WINDOW_MS = Number(process.env.BURST_WINDOW_MIN ?? 10) * 60_000;
const DAILY_SUMMARY = /^\d{1,2}:\d{2}$/.test(process.env.DAILY_SUMMARY?.trim() ?? "") ? process.env.DAILY_SUMMARY!.trim() : null;
const DECIMALS = 6;
const { client, chain } = await connect();
const onAevum = chain.id === aevumTestnet.id;

// ------------------------------------------------------------------ state

const here = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.resolve(here, "../.notifier-state.json");

interface State {
  shield: string;
  lastBlock: string | null;
  updateOffset: number;
  subs: Record<string, string[]>; // chatId -> owner addresses (lowercase)
  /** "owner|agent" -> times (ms) of that agent's recent requests, for flood grouping. */
  recent?: Record<string, number[]>;
  /** "owner|agent" -> requests held back during a flood, sent later as one summary. */
  held?: Record<string, { since: number; ids: string[]; total: string; merchants: string[] }>;
  /** owner -> payments seen since the last daily summary. */
  day?: Record<string, { count: number; total: string }>;
  lastSummaryDate?: string;
  /** Highest block whose failed SpendShield transactions have been reported. */
  lastFailBlock?: string | null;
}

function load(): State {
  if (existsSync(STATE_FILE)) {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
    if (s.shield?.toLowerCase() === shield.toLowerCase()) return s;
  }
  return { shield, lastBlock: null, updateOffset: 0, subs: {} };
}
const state = load();
state.recent ??= {};
state.held ??= {};
state.day ??= {};
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

function chatsFor(owner: string): string[] {
  return Object.entries(state.subs)
    .filter(([, owners]) => owners.includes(owner.toLowerCase()))
    .map(([chat]) => chat);
}

// ------------------------------------------------------------------ telegram

async function tg<T = unknown>(method: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(40_000),
  });
  const data = (await res.json()) as { ok: boolean; result: T; description?: string };
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description}`);
  return data.result;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const amt = (v: bigint) => `${formatUnits(v, DECIMALS)} tUSD8`;
const txLink = (hash: string) => (onAevum ? ` · <a href="${txUrl(hash)}">tx</a>` : "");

async function send(chatId: string, html: string, button?: { text: string; url: string }) {
  try {
    await tg("sendMessage", {
      chat_id: chatId,
      text: html,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(button ? { reply_markup: { inline_keyboard: [[button]] } } : {}),
    });
  } catch (e) {
    console.error(`[send ${chatId}]`, e instanceof Error ? e.message : e);
  }
}

// ------------------------------------------------------------------ commands

const HELP = [
  "<b>SpendShield alerts</b>",
  "I message you when your AI agents pay, and when one asks you to approve a payment.",
  "",
  "/watch 0xYourAddress: alerts for the vault owned by that address",
  "/unwatch 0xYourAddress: stop",
  "/list: what this chat watches",
  "/status: vault balance and pending requests",
  "",
  `Owner console: ${APP_URL}/shield`,
].join("\n");

async function status(owner: Address) {
  const [vault, frozen, count] = await Promise.all([
    client.readContract({ address: shield, abi: spendShieldAbi, functionName: "balanceOf", args: [owner] }),
    client.readContract({ address: shield, abi: spendShieldAbi, functionName: "frozen", args: [owner] }),
    client.readContract({ address: shield, abi: spendShieldAbi, functionName: "requestCount" }),
  ]);
  const pending = await pendingByAgent(owner, count);
  return [
    `<b>Vault ${short(owner)}</b>`,
    `Balance: ${amt(vault)}`,
    `Agents: ${frozen ? "🧊 frozen" : "live"}`,
    pending.length ? `Pending approvals, by agent:\n${pending.map(describeGroup).join("\n")}` : "No pending approvals.",
  ].join("\n");
}

type Group = { agent: string; ids: bigint[]; total: bigint; merchants: Set<string> };

/** Open requests for one owner, grouped by agent (newest 200 requests). */
async function pendingByAgent(owner: Address, count?: bigint): Promise<Group[]> {
  const n = count ?? (await client.readContract({ address: shield, abi: spendShieldAbi, functionName: "requestCount" }));
  const now = BigInt(Math.floor(Date.now() / 1000));
  const groups = new Map<string, Group>();
  for (let id = n; id > 0n && id > n - 200n; id--) {
    const q = await client.readContract({ address: shield, abi: spendShieldAbi, functionName: "requestOf", args: [id] });
    if (q.owner.toLowerCase() !== owner.toLowerCase() || q.status !== 1 || q.expiresAt <= now) continue;
    const g = groups.get(q.agent) ?? { agent: q.agent, ids: [], total: 0n, merchants: new Set<string>() };
    g.ids.unshift(id);
    g.total += q.amount;
    g.merchants.add(q.merchant.toLowerCase());
    groups.set(q.agent, g);
  }
  return [...groups.values()].sort((a, b) => b.ids.length - a.ids.length);
}

const describeGroup = (g: Group) =>
  `• Agent <code>${short(g.agent)}</code>: ${g.ids.length} request${g.ids.length > 1 ? "s" : ""} (${g.ids.map((i) => `#${i}`).join(", ")}), ${amt(g.total)} in total, ${g.merchants.size} shop${g.merchants.size > 1 ? "s" : ""}${g.ids.length > BURST_LIMIT ? " ⚠️" : ""}`;

async function handleCommand(chatId: string, text: string) {
  const [cmd, arg] = text.trim().split(/\s+/, 2);
  const command = cmd.toLowerCase().replace(/@.*$/, "");
  const owners = (state.subs[chatId] ??= []);

  if (command === "/watch" || command === "/unwatch" || command === "/status") {
    if (!arg || !isAddress(arg)) return send(chatId, `Usage: <code>${command} 0xYourOwnerAddress</code>`);
    const owner = arg.toLowerCase();
    if (command === "/status") return send(chatId, await status(arg as Address), { text: "Open console", url: `${APP_URL}/shield` });
    if (command === "/watch") {
      if (!owners.includes(owner)) owners.push(owner);
      save();
      return send(chatId, `🔔 Watching vault <code>${short(owner)}</code>. You'll hear from me when its agents pay or ask for approval.`);
    }
    state.subs[chatId] = owners.filter((o) => o !== owner);
    save();
    return send(chatId, `🔕 Stopped watching <code>${short(owner)}</code>.`);
  }
  if (command === "/list") return send(chatId, owners.length ? `Watching:\n${owners.map((o) => `<code>${o}</code>`).join("\n")}` : "Not watching any vault yet. Send /watch 0xYourAddress");
  return send(chatId, HELP);
}

async function pollCommands() {
  for (;;) {
    try {
      const updates = await tg<{ update_id: number; message?: { chat: { id: number }; text?: string } }[]>("getUpdates", {
        offset: state.updateOffset,
        timeout: 25,
        allowed_updates: ["message"],
      });
      for (const u of updates) {
        state.updateOffset = u.update_id + 1;
        if (u.message?.text) await handleCommand(String(u.message.chat.id), u.message.text);
      }
      if (updates.length) save();
    } catch (e) {
      console.error("[commands]", e instanceof Error ? e.message : e);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

// ------------------------------------------------------------------ chain watcher

async function pollChain() {
  for (;;) {
    try {
      const head = await client.getBlockNumber();
      if (state.lastBlock === null) {
        state.lastBlock = head.toString(); // start from now; don't replay history on first run
        save();
      }
      const from = BigInt(state.lastBlock) + 1n;
      if (head >= from) {
        const range = { address: shield, fromBlock: from, toBlock: head };
        const [asks, paid, settled, frozen, revoked] = await Promise.all([
          getLogsChunked(client, { ...range, event: getAbiItem({ abi: spendShieldAbi, name: "ApprovalRequested" }) }),
          getLogsChunked(client, { ...range, event: getAbiItem({ abi: spendShieldAbi, name: "AgentPaid" }) }),
          getLogsChunked(client, { ...range, event: getAbiItem({ abi: spendShieldAbi, name: "RequestSettled" }) }),
          getLogsChunked(client, { ...range, event: getAbiItem({ abi: spendShieldAbi, name: "FrozenSet" }) }),
          getLogsChunked(client, { ...range, event: getAbiItem({ abi: spendShieldAbi, name: "SessionRevoked" }) }),
        ]);

        for (const l of asks) {
          const { id, owner, agent, merchant, amount } = l.args;
          if (!chatsFor(owner!).length) continue;
          const key = `${owner!.toLowerCase()}|${agent!.toLowerCase()}`;
          const now = Date.now();
          const times = (state.recent![key] = [...(state.recent![key] ?? []).filter((t) => now - t < BURST_WINDOW_MS), now]);

          if (times.length <= BURST_LIMIT) {
            for (const chat of chatsFor(owner!)) {
              await send(
                chat,
                [
                  `🙋 <b>Approval needed: request #${id}</b>`,
                  `Agent <code>${short(agent!)}</code> wants to pay <b>${amt(amount!)}</b>`,
                  `to <code>${esc(merchant!)}</code>${txLink(l.transactionHash)}`,
                  "",
                  "It's over the agent's limits, so nothing moves until you decide. Check the merchant before approving.",
                ].join("\n"),
                { text: `Review request #${id}`, url: `${APP_URL}/shield#request-${id}` },
              );
            }
            continue;
          }

          // A flood: warn once, then hold the rest and send them as one summary.
          const held = state.held![key];
          if (!held) {
            state.held![key] = { since: now, ids: [String(id)], total: String(amount!), merchants: [merchant!.toLowerCase()] };
            for (const chat of chatsFor(owner!)) {
              await send(
                chat,
                [
                  `⚠️ <b>Agent <code>${short(agent!)}</code> filed ${times.length} requests in ${Math.round(BURST_WINDOW_MS / 60_000)} minutes</b>`,
                  "That's unusual: it could be stuck in a loop, or hijacked and trying to wear you down.",
                  "I'll group its next requests into one summary instead of messaging you for each.",
                  "Review them together in the console, or revoke the agent there.",
                ].join("\n"),
                { text: "Review this agent's requests", url: `${APP_URL}/shield#agent-${agent}` },
              );
            }
          } else {
            held.ids.push(String(id));
            held.total = String(BigInt(held.total) + amount!);
            if (!held.merchants.includes(merchant!.toLowerCase())) held.merchants.push(merchant!.toLowerCase());
          }
        }
        for (const l of paid) {
          const { owner, agent, merchant, amount, spentInPeriod } = l.args;
          const d = (state.day![owner!.toLowerCase()] ??= { count: 0, total: "0" });
          d.count += 1;
          d.total = String(BigInt(d.total) + amount!);
          for (const chat of chatsFor(owner!)) {
            await send(chat, `💸 Agent <code>${short(agent!)}</code> paid <b>${amt(amount!)}</b> to <code>${short(merchant!)}</code> (spent this period: ${amt(spentInPeriod!)})${txLink(l.transactionHash)}`);
          }
        }
        for (const l of settled) {
          const { id, owner, approved } = l.args;
          for (const chat of chatsFor(owner!)) await send(chat, `${approved ? "✅ Approved" : "❌ Rejected"} request #${id}${txLink(l.transactionHash)}`);
        }
        for (const l of frozen) {
          for (const chat of chatsFor(l.args.owner!)) await send(chat, l.args.frozen ? "🧊 All agents frozen. No agent can pay until you unfreeze." : "🔓 Agents unfrozen.");
        }
        for (const l of revoked) {
          for (const chat of chatsFor(l.args.owner!)) await send(chat, `🔒 Agent <code>${short(l.args.agent!)}</code> revoked. Anything it signed before no longer works.`);
        }

        state.lastBlock = head.toString();
        save();
      }
      if (onAevum && ++failTick % 3 === 0) await pollBlocked(head);
      await flushHeld();
      await dailySummary();
    } catch (e) {
      console.error("[chain]", e instanceof Error ? e.message : e);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

let failTick = 0;

/** Failed SpendShield transactions from the explorer: payments the contract refused, reported to the vault's owner. */
async function pollBlocked(head: bigint) {
  if (state.lastFailBlock == null) {
    state.lastFailBlock = head.toString(); // start from now
    save();
    return;
  }
  const url = `${links.explorer}/api?module=account&action=txlist&address=${shield}&startblock=${BigInt(state.lastFailBlock) + 1n}&sort=asc&page=1&offset=100`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  const body = (await res.json()) as { result?: { hash: Hex; blockNumber: string; isError: string; from: Address; input: Hex }[] };
  const txs = Array.isArray(body.result) ? body.result : [];
  for (const tx of txs) {
    if (tx.isError === "1") await reportBlocked(tx).catch((e) => console.error("[blocked]", e instanceof Error ? e.message : e));
    if (BigInt(tx.blockNumber) > BigInt(state.lastFailBlock!)) state.lastFailBlock = tx.blockNumber;
  }
  if (txs.length) save();
}

async function reportBlocked(tx: { hash: Hex; from: Address; input: Hex }) {
  let call;
  try {
    call = decodeFunctionData({ abi: spendShieldAbi, data: tx.input });
  } catch {
    return; // not a SpendShield call we know
  }
  let owner: Address, agent: Address, merchant: Address, amount: bigint;
  if (call.functionName === "payWithSig") [owner, agent, merchant, amount] = call.args as unknown as [Address, Address, Address, bigint];
  else if (call.functionName === "pay") {
    [owner, merchant, amount] = call.args as unknown as [Address, Address, bigint];
    agent = tx.from;
  } else return;
  if (!chatsFor(owner).length) return;

  // The explorer decodes SpendShield's revert: PaymentRejected(uint8 reason).
  const detail = (await fetch(`${links.explorer}/api/v2/transactions/${tx.hash}`, { signal: AbortSignal.timeout(15_000) })
    .then((r) => r.json())
    .catch(() => null)) as { revert_reason?: { parameters?: { value?: string }[] } } | null;
  const code = detail?.revert_reason?.parameters?.[0]?.value;
  const reason = code !== undefined ? reasonOf(Number(code)) : null;

  const key = `blocked|${owner.toLowerCase()}|${agent.toLowerCase()}`;
  const now = Date.now();
  const times = (state.recent![key] = [...(state.recent![key] ?? []).filter((t) => now - t < BURST_WINDOW_MS), now]);
  const why = reason ? `${reason}: ${REASON_TEXT[reason]}` : "refused by SpendShield";

  if (times.length <= BURST_LIMIT) {
    for (const chat of chatsFor(owner)) {
      await send(
        chat,
        [
          `🚫 <b>Blocked payment</b>`,
          `Agent <code>${short(agent)}</code> tried to pay <b>${amt(amount)}</b> to <code>${esc(merchant)}</code>${txLink(tx.hash)}`,
          `SpendShield refused it (${esc(why)}). Nothing was paid.`,
        ].join("\n"),
      );
    }
    return;
  }
  const held = state.held![key];
  if (!held) {
    state.held![key] = { since: now, ids: [tx.hash], total: String(amount), merchants: [merchant.toLowerCase()] };
    for (const chat of chatsFor(owner)) {
      await send(
        chat,
        [
          `🚨 <b>Agent <code>${short(agent)}</code> had ${times.length} payments blocked in ${Math.round(BURST_WINDOW_MS / 60_000)} minutes</b>`,
          "Nothing was paid, but a burst like this usually means the agent is compromised or misbehaving.",
          "Consider revoking it. I'll group further blocked attempts into one summary.",
        ].join("\n"),
        { text: "Open the console", url: `${APP_URL}/shield#agent-${agent.toLowerCase()}` },
      );
    }
  } else {
    held.ids.push(tx.hash);
    held.total = String(BigInt(held.total) + amount);
    if (!held.merchants.includes(merchant.toLowerCase())) held.merchants.push(merchant.toLowerCase());
  }
}

/** Held-back flood requests go out as one summary once the burst window has passed. */
async function flushHeld() {
  const now = Date.now();
  for (const [key, held] of Object.entries(state.held!)) {
    if (now - held.since < BURST_WINDOW_MS) continue;
    const blocked = key.startsWith("blocked|");
    const [owner, agent] = blocked ? key.split("|").slice(1) : key.split("|");
    if (blocked) {
      for (const chat of chatsFor(owner)) {
        await send(
          chat,
          [
            `🗂 <b>Agent <code>${short(agent)}</code>: ${held.ids.length} more blocked payment${held.ids.length > 1 ? "s" : ""}</b>`,
            `${amt(BigInt(held.total))} in total, to ${held.merchants.length} address${held.merchants.length > 1 ? "es" : ""}. Nothing was paid.`,
            "If you haven't already, revoke this agent.",
          ].join("\n"),
          { text: "Open the console", url: `${APP_URL}/shield#agent-${agent}` },
        );
      }
      delete state.held![key];
      save();
      continue;
    }
    for (const chat of chatsFor(owner)) {
      await send(
        chat,
        [
          `🗂 <b>Agent <code>${short(agent)}</code>: ${held.ids.length} more request${held.ids.length > 1 ? "s" : ""}, grouped</b>`,
          `${held.ids.map((i) => `#${i}`).join(", ")}: ${amt(BigInt(held.total))} in total, to ${held.merchants.length} shop${held.merchants.length > 1 ? "s" : ""}.`,
          "Nothing moves until you decide. If you didn't expect these, reject them all or revoke the agent.",
        ].join("\n"),
        { text: "Review this agent's requests", url: `${APP_URL}/shield#agent-${agent}` },
      );
    }
    delete state.held![key];
    save();
  }
}

/** Once a day at DAILY_SUMMARY (local time): pending requests by agent, and the day's payments. */
async function dailySummary() {
  if (!DAILY_SUMMARY) return;
  const now = new Date();
  const today = now.toLocaleDateString("en-CA");
  const [h, m] = DAILY_SUMMARY.split(":").map(Number);
  if (state.lastSummaryDate === today || now.getHours() * 60 + now.getMinutes() < h * 60 + m) return;
  state.lastSummaryDate = today;
  save();
  const owners = [...new Set(Object.values(state.subs).flat())];
  for (const owner of owners) {
    const groups = await pendingByAgent(owner as Address);
    const d = state.day![owner] ?? { count: 0, total: "0" };
    const text = [
      `📋 <b>Daily review for vault <code>${short(owner)}</code></b>`,
      `Agent payments since the last review: ${d.count} (${amt(BigInt(d.total))}).`,
      groups.length ? `Waiting for you:\n${groups.map(describeGroup).join("\n")}` : "Nothing is waiting for your approval.",
    ].join("\n");
    for (const chat of chatsFor(owner)) await send(chat, text, groups.length ? { text: "Review in the console", url: `${APP_URL}/shield` } : undefined);
    state.day![owner] = { count: 0, total: "0" };
  }
  save();
}

// Retry instead of crashing when the network blips at startup.
let me: { username: string } | undefined;
for (let wait = 5; !me; wait = Math.min(wait * 2, 60)) {
  try {
    me = await tg<{ username: string }>("getMe", {});
  } catch (e) {
    console.error(`[startup] can't reach Telegram (${e instanceof Error ? e.message : e}), retrying in ${wait}s`);
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
}
console.log(`🤖 @${me.username} is watching SpendShield ${shield} on chain ${chain.id}`);
console.log(`   Open https://t.me/${me.username}, press Start, then send: /watch 0xYourOwnerAddress`);
console.log(`   Blocked payments: ${onAevum ? "reported from the explorer" : "not watched (explorer only on Aevum)"}.`);
console.log(`   Floods: more than ${BURST_LIMIT} requests from one agent in ${BURST_WINDOW_MS / 60_000} min are grouped.${DAILY_SUMMARY ? ` Daily review at ${DAILY_SUMMARY}.` : ""}`);
await Promise.all([pollCommands(), pollChain()]);
