/**
 * SpendShield Telegram alerts: your phone buzzes when an agent asks you to approve a payment.
 *
 * A small bot that watches SpendShield on Aevum and messages every chat subscribed to an owner:
 *   🙋 an agent asks for approval (with a button that opens that request in the owner console)
 *   💸 an agent paid a merchant
 *   ✅/❌ a request was approved or rejected
 *   🧊 agents were frozen or unfrozen, 🔒 an agent was revoked
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
import { formatUnits, getAbiItem, isAddress, type Address } from "viem";
import { aevumTestnet, getLogsChunked, spendShieldAbi, txUrl } from "@aevum-kit/aevum";
import { connect, required, requiredAddress } from "./env";

const TOKEN = required("TELEGRAM_BOT_TOKEN");
const shield = requiredAddress("SHIELD_ADDRESS");
const APP_URL = (process.env.APP_URL?.trim() || "https://spendshield-psi.vercel.app").replace(/\/+$/, "");
const POLL_MS = 5000;
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
}

function load(): State {
  if (existsSync(STATE_FILE)) {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
    if (s.shield?.toLowerCase() === shield.toLowerCase()) return s;
  }
  return { shield, lastBlock: null, updateOffset: 0, subs: {} };
}
const state = load();
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
  const pending: string[] = [];
  const now = BigInt(Math.floor(Date.now() / 1000));
  for (let id = count; id > 0n && id > count - 50n; id--) {
    const q = await client.readContract({ address: shield, abi: spendShieldAbi, functionName: "requestOf", args: [id] });
    if (q.owner.toLowerCase() === owner.toLowerCase() && q.status === 1 && q.expiresAt > now) pending.push(`#${id}: ${amt(q.amount)} to ${short(q.merchant)}`);
  }
  return [
    `<b>Vault ${short(owner)}</b>`,
    `Balance: ${amt(vault)}`,
    `Agents: ${frozen ? "🧊 frozen" : "live"}`,
    pending.length ? `Pending approvals:\n${pending.join("\n")}` : "No pending approvals.",
  ].join("\n");
}

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
        }
        for (const l of paid) {
          const { owner, agent, merchant, amount, spentInPeriod } = l.args;
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
    } catch (e) {
      console.error("[chain]", e instanceof Error ? e.message : e);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

const me = await tg<{ username: string }>("getMe", {});
console.log(`🤖 @${me.username} is watching SpendShield ${shield} on chain ${chain.id}`);
console.log(`   Open https://t.me/${me.username}, press Start, then send: /watch 0xYourOwnerAddress`);
await Promise.all([pollCommands(), pollChain()]);
