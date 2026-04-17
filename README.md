# ln-mcp

MCP server that gives AI agents a Bitcoin Lightning wallet. Pay invoices, fetch L402 APIs, discover paid services, and manage spending budgets — all through the Model Context Protocol.

Works with **Claude Desktop**, **Claude Code**, **Gemini CLI**, and **ChatGPT**.

> **Demo project:** [Aegis Wallet](https://github.com/PraneethGunas/aegis-wallet) — a seedless Bitcoin wallet where Claude is the AI financial agent. Uses ln-mcp for autonomous Lightning payments with budget enforcement and real-time approval flows.

## Quick Start

```bash
npx -y ln-mcp
```

### Claude Desktop

Add to Claude Desktop → Settings → Developer → Edit Config:

```json
{
  "mcpServers": {
    "ln-mcp": {
      "command": "npx",
      "args": ["-y", "ln-mcp"],
      "env": {
        "LND_MACAROON_BASE64": "<your scoped macaroon>",
        "LND_REST_HOST": "https://localhost:8080",
        "NODE_TLS_REJECT_UNAUTHORIZED": "0"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add ln-mcp \
  -e 'LND_MACAROON_BASE64=<macaroon>' \
  -e LND_REST_HOST=https://localhost:8080 \
  -e NODE_TLS_REJECT_UNAUTHORIZED=0 \
  -- npx -y ln-mcp
```

### Gemini CLI

```bash
gemini mcp add \
  -e 'LND_MACAROON_BASE64=<macaroon>' \
  -e LND_REST_HOST=https://localhost:8080 \
  -e NODE_TLS_REJECT_UNAUTHORIZED=0 \
  ln-mcp npx -- -y ln-mcp
```

### ChatGPT (HTTP mode)

```bash
HTTP_PORT=3004 LND_MACAROON_BASE64=<macaroon> LND_REST_HOST=https://localhost:8080 npx -y ln-mcp
# Then tunnel: ngrok http 3004
# Paste the ngrok URL + /mcp into ChatGPT Settings → Apps → Create
```

## Tools (10)

| Tool | Description |
|------|-------------|
| **Payments** | |
| `pay_invoice` | Pay a BOLT11 Lightning invoice. Budget enforced by LND. |
| `l402_fetch` | Fetch a URL with automatic L402 payment (402 → pay → retry, one call) |
| `l402_discover` | Probe an L402 endpoint for pricing and docs before paying (free) |
| `create_invoice` | Generate an invoice to receive payment |
| **Spending** | |
| `list_payments` | Recent payment history |
| `get_spending_summary` | Total spent, fees, remaining balance, cached L402 tokens |
| **Discovery** | |
| `search_services` | Search the [402 Index](https://402index.io) directory for paid APIs |
| `list_categories` | Browse available service categories |
| `get_service_detail` | Full details on a specific service by ID |
| `get_directory_stats` | Directory-wide stats and health |

## How It Works

```
AI Agent (Claude / Gemini / ChatGPT)
    ↕ MCP (stdio or HTTP)
ln-mcp
    ↕ HTTPS + macaroon
LND REST API (your node)
    ↕ gRPC
402 Index API (service discovery)
```

The MCP server connects directly to your LND node's REST API. The macaroon controls what the agent can do — scoped permissions + budget ceiling enforced cryptographically by LND.

### Payment Flow

```
User: "Buy me a coffee"

Agent: search_services(q="coffee", protocol="L402")
  → Finds Unhuman Coffee (L402, ~3000 sats)

Agent: l402_discover("https://unhuman.coffee/api/order")
  → Gets pricing, parameters, usage docs (free)

Agent: l402_fetch("https://unhuman.coffee/api/order", method="POST", body=...)
  → Hits URL → gets HTTP 402 + invoice
  → Decodes invoice (3000 sats)
  → Pays via Lightning (SendPaymentV2, 60s timeout)
  → Caches L402 token for unhuman.coffee
  → Retries with L402 auth header
  → Returns order confirmation + receipt
```

### Budget Exceeded → User Approval

When a payment exceeds the agent's budget, the invoice is forwarded to the wallet app for the user to pay directly:

```
Agent: l402_fetch(url)
  → LND rejects (FAILURE_REASON_INSUFFICIENT_BALANCE)
  → MCP POSTs to AEGIS_WEBHOOK_URL: { bolt11, amount, error }
  → Wallet app receives SSE push → shows "Pay directly" banner instantly
  → User taps to approve → payment completes
  → Agent relays TELL_USER message to user
```

Only budget-exceeded failures trigger this flow. Routing failures and timeouts return an error for the agent to relay — no webhook, no false "approval required" messages.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `LND_MACAROON_BASE64` | Yes | Base64-encoded macaroon (controls permissions + budget) |
| `LND_REST_HOST` | No | LND REST address (default: `https://localhost:8080`) |
| `NODE_TLS_REJECT_UNAUTHORIZED` | No | Set to `0` for self-signed TLS certs |
| `AEGIS_WEBHOOK_URL` | No | Webhook URL for budget-exceeded notifications |
| `HTTP_PORT` | No | Set to serve over HTTP instead of stdio (for ChatGPT) |

## Transports

| Platform | Transport | Config |
|----------|-----------|--------|
| Claude Desktop | stdio | JSON config file |
| Claude Code | stdio | `claude mcp add` |
| Gemini CLI | stdio | `gemini mcp add` |
| ChatGPT | HTTP | `HTTP_PORT` env var + ngrok |

## Requirements

- Node.js 22+
- LND or litd node with REST API enabled (port 8080)
- A macaroon with payment permissions

### Recommended Macaroon Permissions

```
routerrpc.Router/SendPaymentV2
routerrpc.Router/TrackPaymentV2
lnrpc.Lightning/SendPaymentSync
lnrpc.Lightning/DecodePayReq
lnrpc.Lightning/ChannelBalance
lnrpc.Lightning/ListPayments
lnrpc.Lightning/GetInfo
lnrpc.Lightning/AddInvoice
```

For budget enforcement, use a [litd account](https://docs.lightning.engineering/lightning-network-tools/lightning-terminal/accounts) macaroon — the budget ceiling is enforced cryptographically by LND's RPC middleware.

## Design Decisions

- **No `get_balance` tool** — agents used it to pre-check balance and refuse to pay, preventing the budget-exceeded → webhook → user-approval flow. Balance is available via `get_spending_summary` and in every payment receipt.
- **No `decode_invoice` tool** — agents decoded invoices, saw the amount, and hesitated before paying. `pay_invoice` and `l402_fetch` decode internally.
- **SendPaymentV2 streaming** — 60-second timeout auto-cancels stuck payments. No more "already in flight" errors on retry.
- **Webhook only on budget exceeded** — routing/timeout failures return an error to the agent directly, not a false "manual approval required" message.

## License

MIT
