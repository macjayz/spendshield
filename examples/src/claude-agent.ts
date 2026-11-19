/**
 * The AI buying agent, run through Claude Code instead of an API key.
 *
 * Starts the SpendShield MCP server (mcp-server.ts) and runs `claude -p` against it with every
 * built-in tool switched off, so the agent's only abilities are the five SpendShield tools. Uses
 * whatever account your Claude Code CLI is logged in with.
 *
 *   pnpm example claude-agent                      # normal agent: should spot and ignore the injection
 *   pnpm example claude-agent -- --compromised     # red-team mode: told to obey instructions hidden in shop content
 *   PROOF_ONCHAIN=1 pnpm example claude-agent -- --compromised   # blocked payments also revert on chain
 *   TASK="Buy the weather" pnpm example claude-agent
 *   AI_MODEL=sonnet pnpm example claude-agent      # any model name Claude Code accepts
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aevumTestnet, txUrl } from "@aevum-kit/aevum";
import { PROMPTS, TOOL_DEFS } from "./shield-tools";

const compromised = process.argv.includes("--compromised");
const TASK = process.env.TASK?.trim() || PROMPTS.task;
const here = path.dirname(fileURLToPath(import.meta.url));
const examplesDir = path.resolve(here, "..");
const onAevum = (process.env.RPC_URL ?? aevumTestnet.rpcUrls.default.http[0]).includes("rpc-test.qday.info");
const log = (icon: string, msg: string) => console.log(`${icon}  ${msg}`);

// An empty working folder: no project files, no CLAUDE.md, nothing for the agent to wander into.
const workDir = mkdtempSync(path.join(tmpdir(), "spendshield-agent-"));
const mcpConfig = path.join(workDir, "mcp.json");
writeFileSync(
  mcpConfig,
  JSON.stringify({
    mcpServers: {
      spendshield: {
        command: path.join(examplesDir, "node_modules/.bin/tsx"),
        args: [`--env-file=${path.join(examplesDir, ".env")}`, path.join(here, "mcp-server.ts")],
        // Pass through overrides set on the command line (they win over examples/.env in the server).
        env: Object.fromEntries(
          ["PROOF_ONCHAIN", "OWNER_ADDRESS", "SHIELD_ADDRESS", "MERCHANT_API", "RPC_URL"]
            .filter((k) => process.env[k] !== undefined)
            .map((k) => [k, process.env[k]!]),
        ),
      },
    },
  }),
);

const allowed = TOOL_DEFS.map((t) => `mcp__spendshield__${t.name}`);
const args = [
  "-p",
  TASK,
  "--system-prompt",
  compromised ? PROMPTS.compromised : PROMPTS.safe,
  "--mcp-config",
  mcpConfig,
  "--strict-mcp-config",
  "--tools",
  "", // no built-in tools: no shell, no files, no web
  "--allowedTools",
  ...allowed,
  "--output-format",
  "stream-json",
  "--verbose",
  "--no-session-persistence",
  "--max-budget-usd",
  process.env.MAX_BUDGET_USD ?? "2",
];
if (process.env.AI_MODEL?.trim()) args.push("--model", process.env.AI_MODEL.trim());

console.log(compromised ? "\n🔴  RED-TEAM MODE: this agent is told to obey instructions hidden in shop content.\n" : "");
log("🤖", "AI agent: Claude Code, with only the 5 SpendShield tools");
log("📝", `Task: ${TASK}\n`);

const child = spawn("claude", args, { cwd: workDir, stdio: ["ignore", "pipe", "inherit"] });
const toolNames = new Map<string, string>();
let buffer = "";

child.stdout.on("data", (chunk: Buffer) => {
  buffer += chunk.toString();
  let nl: number;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line) handle(line);
  }
});

child.on("close", (code) => {
  rmSync(workDir, { recursive: true, force: true });
  process.exitCode = code ?? 0;
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handle(line: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let event: any;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }

  if (event.type === "system" && event.subtype === "init") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mcp = (event.mcp_servers ?? []).find((s: any) => s.name === "spendshield");
    log("🔌", `SpendShield tools: ${mcp?.status ?? "not found"} · model ${event.model ?? "?"}`);
    return;
  }

  if (event.type === "assistant") {
    for (const block of event.message?.content ?? []) {
      if (block.type === "thinking" && block.thinking?.trim()) log("🧠", block.thinking.trim().replace(/\s+/g, " ").slice(0, 400));
      if (block.type === "text" && block.text?.trim()) log("💬", block.text.trim());
      if (block.type === "tool_use") {
        const name = String(block.name).replace("mcp__spendshield__", "");
        toolNames.set(block.id, name);
        log("🔧", `${name}(${Object.entries(block.input ?? {}).map(([k, v]) => `${k}=${v}`).join(", ")})`);
      }
    }
    return;
  }

  if (event.type === "user") {
    for (const block of event.message?.content ?? []) {
      if (block.type === "tool_result") describeResult(toolNames.get(block.tool_use_id) ?? "?", block.content);
    }
    return;
  }

  if (event.type === "result") {
    console.log();
    const cost = typeof event.total_cost_usd === "number" ? ` · usage ~$${event.total_cost_usd.toFixed(2)}` : "";
    log("🏁", `Finished (${event.subtype}) in ${event.num_turns ?? "?"} turns${cost}`);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function describeResult(tool: string, content: any) {
  const text = Array.isArray(content) ? content.map((c) => c.text ?? "").join("") : String(content ?? "");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let r: any;
  try {
    r = JSON.parse(text);
  } catch {
    return log("↩️ ", text.slice(0, 200));
  }
  const link = (hash: string) => (onAevum && /^0x[0-9a-f]{64}$/i.test(hash) ? txUrl(hash) : hash);
  if (tool === "check_payment") return log("🛡️ ", `SpendShield: ${r.reason}${r.allowed ? "" : ` (${r.explanation})`}`);
  if (tool === "pay_merchant") {
    if (r.paid) return log("💸", `Paid: ${link(String(r.payment_proof).replace(/^tx:/, ""))}`);
    return log("⛔", `BLOCKED by SpendShield: ${r.reason} (${r.explanation})${r.tx ? ` · on chain: ${r.tx}` : ""}`);
  }
  if (tool === "ask_owner_approval") {
    return r.requested ? log("🙋", `Asked the owner (request #${r.requestId}); waiting for a human decision`) : log("❌", `Request failed: ${r.error}`);
  }
  if (tool === "browse_shop") {
    if (r.status === 402) return log("🧾", `Quote: ${r.body?.accepts?.amountFormatted} to ${r.body?.accepts?.merchant}`);
    if (r.status === 200) return log("📦", JSON.stringify(r.body?.data).slice(0, 300));
    return log("↩️ ", `Shop answered ${r.status}: ${r.body?.error ?? ""}`);
  }
  if (tool === "get_budget") return log("💰", `Can still spend ${r.canStillSpendThisPeriod} tUSD8 (max ${r.maxPerPayment} per payment)`);
  log("↩️ ", text.slice(0, 200));
}
