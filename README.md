# ln-mcp

MCP server that gives AI agents a Bitcoin Lightning wallet. Pay invoices, fetch L402 APIs, and manage spending budgets — all through the Model Context Protocol.

Works with **Claude Desktop**, **Claude Code**, **ChatGPT**, and **Gemini CLI**.

## Quick Start

```bash
npx ln-mcp
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
  -- npx ln-mcp
```

### ChatGPT (HTTP mode)

```bash
HTTP_PORT=3004 LND_MACAROON_BASE64=<macaroon> LND_REST_HOST=https://localhost:8080 npx ln-mcp
# Then tunnel: ngrok http 3004
# Paste the ngrok URL + /mcp into ChatGPT Settings → Apps → Create
```

## Tools (10)

| Tool | Description |
|------|-------------|
| `pay_invoice` | Pay a BOLT11 Lightning invoice |
| `l402_fetch` | Fetch a URL with automatic L402 payment (402 → pay → retry, one call) |
| `l402_discover` | Discover API params and pricing before paying (free) |
| `create_invoice` | Generate an invoice to receive payment |
| `list_payments` | Recent payment history |
| `get_spending_summary` | Total spent, fees, remaining balance, cached L402 tokens |
| `search_services` | Search the 402 Index directory for paid APIs |
| `list_categories` | Browse available service categories |
| `get_service_detail` | Full details on a specific service |
| `get_directory_stats` | Directory-wide stats and health |

## How It Works

```
AI Agent (Claude/ChatGPT/Gemini)
    ↕ MCP (stdio or HTTP)
ln-mcp
    ↕ HTTPS + macaroon
LND REST API (your node)
```

The MCP server connects directly to your LND node's REST API. The macaroon controls what the agent can do — scoped permissions + budget ceiling enforced by LND.

### L402 Flow (one call)

```
Agent: l402_fetch("https://api.example.com/data")
  → Tool hits URL → gets 402 + invoice
  → Decodes invoice (3 sats)
  → Pays via Lightning
  → Caches token for domain
  → Retries with L402 auth header
  → Returns data + receipt
```

### Budget Exceeded → Webhook

When a payment exceeds the agent's budget, the invoice is forwarded to the wallet app via webhook:

```
Agent: l402_fetch(url) → LND rejects (insufficient balance)
  → MCP POSTs to AEGIS_WEBHOOK_URL: { bolt11, amount, error }
  → Wallet app shows "Pay directly" button
  → User pays with full wallet balance
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `LND_MACAROON_BASE64` | Yes | Base64-encoded macaroon (controls permissions + budget) |
| `LND_REST_HOST` | No | LND REST address (default: `https://localhost:8080`) |
| `NODE_TLS_REJECT_UNAUTHORIZED` | No | Set to `0` for self-signed TLS certs |
| `AEGIS_WEBHOOK_URL` | No | Webhook URL for payment failure notifications |
| `HTTP_PORT` | No | Set to serve over HTTP instead of stdio (for ChatGPT) |

## Transports

| Platform | Transport | Config |
|----------|-----------|--------|
| Claude Desktop | stdio | JSON config file |
| Claude Code | stdio | `claude mcp add` |
| Gemini CLI | stdio | Same as Claude |
| ChatGPT | HTTP | `HTTP_PORT` env var + ngrok |

## Requirements

- Node.js 22+
- LND or litd node with REST API enabled (port 8080)
- A macaroon with payment permissions

### Recommended Macaroon Permissions

```
lnrpc.Lightning/SendPaymentSync
lnrpc.Lightning/DecodePayReq
lnrpc.Lightning/ChannelBalance
lnrpc.Lightning/ListPayments
lnrpc.Lightning/GetInfo
lnrpc.Lightning/AddInvoice
routerrpc.Router/SendPaymentV2
routerrpc.Router/TrackPaymentV2
```

For budget enforcement, use a [litd account](https://docs.lightning.engineering/lightning-network-tools/lightning-terminal/accounts) macaroon — the budget ceiling is enforced cryptographically by LND.

## License

MIT
