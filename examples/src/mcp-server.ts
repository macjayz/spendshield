/**
 * SpendShield as an MCP server: gives any MCP-capable AI (Claude Code, Claude Desktop, Cursor,
 * agent frameworks) the five payment tools, with SpendShield's on-chain policy behind every payment.
 *
 * Runs over stdio. Reads the same examples/.env as the other scripts. Example client config:
 *
 *   {
 *     "mcpServers": {
 *       "spendshield": {
 *         "command": "<repo>/examples/node_modules/.bin/tsx",
 *         "args": ["--env-file=<repo>/examples/.env", "<repo>/examples/src/mcp-server.ts"]
 *       }
 *     }
 *   }
 *
 * stdout carries the MCP protocol, so all logging goes to stderr.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createShieldTools, TOOL_DEFS, type ToolInput } from "./shield-tools";

const log = (icon: string, msg: string) => process.stderr.write(`${icon}  ${msg}\n`);
const shieldTools = await createShieldTools({ log, proofOnchain: process.env.PROOF_ONCHAIN === "1" });

const server = new Server({ name: "spendshield", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_DEFS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const input = (request.params.arguments ?? {}) as ToolInput;
  try {
    const text = await shieldTools.runTool(request.params.name, input);
    return { content: [{ type: "text", text }] };
  } catch (e) {
    const error = e instanceof Error ? e.message.split("\n")[0] : String(e);
    return { content: [{ type: "text", text: JSON.stringify({ error }) }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
log("🛡️ ", `SpendShield MCP server ready · agent ${shieldTools.agent} · vault owner ${shieldTools.owner}`);
