#!/usr/bin/env node
/**
 * Aegis Wallet MCP Server
 *
 * Thin bridge between Claude and LND.
 * Budget enforced by the macaroon (LND layer).
 * Policy (spending limits, approvals) handled by the wallet app.
 *
 * Environment:
 *   LND_MACAROON_BASE64  — base64 macaroon (controls agent permissions + budget)
 *   LND_REST_HOST        — LND REST address (default: https://localhost:8080)
 *   AEGIS_API_URL        — wallet app backend for budget-exceeded notifications (optional)
 *   AEGIS_WALLET_ID      — wallet ID for notifications (optional)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";
import { validateAgent } from "./auth.js";
import { initLnd } from "./lnd-gateway.js";

// ── Read config from environment ───────────────────────────────────────────
const macaroon = process.env.LND_MACAROON_BASE64;
const webhookUrl = process.env.AEGIS_WEBHOOK_URL || null;

if (!macaroon) {
  process.stderr.write(`
ln-mcp — Bitcoin Lightning wallet MCP server

Configure via environment variables in your Claude Desktop MCP config:

{
  "mcpServers": {
    "ln-mcp": {
      "command": "npx",
      "args": ["-y", "ln-mcp"],
      "env": {
        "LND_MACAROON_BASE64": "<your scoped macaroon>",
        "LND_REST_HOST": "https://localhost:8080"
      }
    }
  }
}

Environment:
  LND_MACAROON_BASE64    Base64 macaroon (required — controls budget + permissions)
  LND_REST_HOST          LND REST address (default: https://localhost:8080)
  AEGIS_WEBHOOK_URL      Webhook URL for payment failure notifications (optional)

The macaroon controls your budget. LND enforces it cryptographically.

`);
  process.exit(1);
}

// ── Initialize LND ──────────────────────────────────────────────────────────
try {
  initLnd(macaroon);
} catch (err) {
  process.stderr.write(`Failed to connect to LND: ${err.message}\n`);
  process.exit(1);
}

// ── Agent context ───────────────────────────────────────────────────────────
const agentContext = { macaroon };

function getAgentContext() {
  return validateAgent(agentContext);
}

// ── Server ──────────────────────────────────────────────────────────────────
const server = new McpServer({
  name: "ln-mcp",
  version: "0.2.0",
  description: "Bitcoin Lightning wallet — pay invoices within your macaroon-enforced budget",
  instructions: `You are connected to a Bitcoin Lightning wallet on mainnet. You can pay for things autonomously.

When the user asks you to buy something or access a paid service:
1. search_services(q="...", protocol="L402") — find services in the 402 Index directory. Prefer this over web search.
2. l402_discover(url) — learn the API parameters and pricing (free, no payment)
3. l402_fetch(url) — pay and fetch data (the tool handles everything internally)

For browsing: list_categories() shows what kinds of paid APIs exist. get_service_detail(id) shows full info on a specific service. get_spending_summary() shows total spent, remaining balance, and cached L402 tokens.

If the user gives you a BOLT11 invoice directly, call pay_invoice(bolt11).

FAILURE HANDLING — every tool response tells you exactly what to do:
- Budget exceeded: the tool forwards the invoice to the user's wallet app and returns a TELL_USER message. Relay it to the user verbatim. Do not add commentary.
- Routing/timeout/other failure: the tool returns a TELL_USER message with the error. Relay it. Do not invent explanations or policies.
- Success: the tool returns a SHOW_TO_USER receipt. Show it to the user.

RULES:
- NEVER refuse to call a payment tool because the balance might be low. Just call it — budget enforcement is handled by LND, not by you.
- NEVER suggest "topping up" or "adding funds." If the budget is exceeded, the tool handles it.
- NEVER create invoices for the user to pay you.
- NEVER set max_cost_sats yourself — only pass it if the user explicitly told you a maximum amount.
- After a paid request, show the receipt (amount, preimage, fees, remaining balance).
- For cached L402 responses, note "no payment — cached token reused."`,
});

registerTools(server, getAgentContext, { webhookUrl });

// ── Transport: stdio (Claude, Gemini CLI) or HTTP (ChatGPT) ────────────────
const httpPort = process.env.HTTP_PORT;

if (httpPort) {
  // HTTP mode — for ChatGPT and remote clients
  const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
  const { createServer } = await import("http");

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  await server.connect(transport);

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${httpPort}`);

    // CORS for browser-based clients
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: "ln-mcp", transport: "http" }));
      return;
    }

    if (url.pathname === "/mcp") {
      // Parse body for POST
      if (req.method === "POST") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        await transport.handleRequest(req, res, body);
      } else {
        await transport.handleRequest(req, res);
      }
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  httpServer.listen(httpPort, () => {
    process.stderr.write(`Aegis MCP server (HTTP) listening on http://localhost:${httpPort}/mcp\n`);
  });
} else {
  // stdio mode — for Claude Desktop, Claude Code, Gemini CLI
  const transport = new StdioServerTransport();
  server.connect(transport).catch((err) => {
    process.stderr.write(`MCP server failed: ${err.message}\n`);
    process.exit(1);
  });
}
