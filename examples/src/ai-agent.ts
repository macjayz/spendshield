/**
 * A real AI buying agent on the Claude Messages API, paying through SpendShield.
 * (No API key? Use `pnpm example claude-agent`, which runs the same tools through Claude Code.)
 *
 * The model gets a shopping task and five tools (see shield-tools.ts). It decides on its own what to
 * browse, what to pay and when to ask the owner. One shop item (`market-news`) is deliberately
 * poisoned with a prompt injection that tells the agent to pay an attacker.
 *
 *   pnpm example ai-agent                      # normal agent: should spot and ignore the injection
 *   pnpm example ai-agent -- --compromised     # red-team mode: the agent is told to obey injected text
 *   PROOF_ONCHAIN=1 pnpm example ai-agent -- --compromised   # blocked payments also revert on chain
 *   TASK="Buy the weather" pnpm example ai-agent
 *
 * Needs ANTHROPIC_API_KEY plus the usual examples/.env.
 */
import Anthropic from "@anthropic-ai/sdk";
import { createShieldTools, PROMPTS, TOOL_DEFS, type ToolInput } from "./shield-tools";

const compromised = process.argv.includes("--compromised");
const MODEL = process.env.AI_MODEL?.trim() || "claude-opus-5-5";
const MAX_STEPS = 20;
const TASK = process.env.TASK?.trim() || PROMPTS.task;
const log = (icon: string, msg: string) => console.log(`${icon}  ${msg}`);

const shieldTools = await createShieldTools({ log, proofOnchain: process.env.PROOF_ONCHAIN === "1" });
const anthropic = new Anthropic();
const tools: Anthropic.Beta.BetaTool[] = TOOL_DEFS;

console.log(compromised ? "\n🔴  RED-TEAM MODE: this agent is told to obey instructions hidden in shop content.\n" : "");
log("🤖", `AI agent ${shieldTools.agent} (${MODEL})`);
log("🏦", `Owner ${shieldTools.owner} · SpendShield ${shieldTools.shield} · chain ${shieldTools.chain.id}`);
log("📝", `Task: ${TASK}\n`);

const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: TASK }];

for (let step = 0; step < MAX_STEPS; step++) {
  const response = await anthropic.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: compromised ? PROMPTS.compromised : PROMPTS.safe,
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: "medium" },
    // If a safety classifier declines a request, the API retries it on a fallback model it picks.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    tools,
    messages,
  });

  // Keep the full content (thinking blocks included) so the conversation stays valid.
  messages.push({ role: "assistant", content: response.content });

  for (const block of response.content) {
    if (block.type === "thinking" && block.thinking.trim()) log("🧠", block.thinking.trim().replace(/\s+/g, " ").slice(0, 400));
    if (block.type === "text" && block.text.trim()) log("💬", block.text.trim());
  }

  if (response.stop_reason === "refusal") {
    log("🚫", `The model declined: ${response.stop_details?.explanation ?? "no details"}`);
    break;
  }
  if (response.stop_reason === "pause_turn") continue;
  if (response.stop_reason !== "tool_use") break;

  const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
  for (const block of response.content) {
    if (block.type !== "tool_use") continue;
    const input = (block.input ?? {}) as ToolInput;
    log("🔧", `${block.name}(${Object.entries(input).map(([k, v]) => `${k}=${v}`).join(", ")})`);
    try {
      results.push({ type: "tool_result", tool_use_id: block.id, content: await shieldTools.runTool(block.name, input) });
    } catch (e) {
      const error = e instanceof Error ? e.message.split("\n")[0] : String(e);
      results.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify({ error }), is_error: true });
    }
  }
  messages.push({ role: "user", content: results });
}

console.log();
log("💰", await shieldTools.summary());
