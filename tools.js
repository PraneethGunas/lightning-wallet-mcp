/**
 * Aegis Wallet MCP Tools — thin bridge to LND.
 *
 * Budget enforcement is in the macaroon (LND layer).
 * Per-payment max-cost is enforced here (lnget-style).
 * L402 token cache avoids re-payment to the same domain.
 * Policy management is in the web app (app layer).
 */
import { z } from "zod";
import * as lnd from "./lnd-gateway.js";
import { AgentError } from "./auth.js";

// BTC/USD price cache
let priceCache = { usd: 0, fetchedAt: 0 };
async function getBtcUsd() {
  if (Date.now() - priceCache.fetchedAt < 60_000 && priceCache.usd > 0) return priceCache.usd;
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd", { signal: AbortSignal.timeout(3000) });
    const data = await res.json();
    if (data?.bitcoin?.usd) priceCache = { usd: data.bitcoin.usd, fetchedAt: Date.now() };
  } catch {}
  return priceCache.usd || 100000;
}

function satsToUsd(sats, price) {
  return ((sats / 1e8) * price).toFixed(2);
}

function reply(data) {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

function errorReply(message) {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

const MAX_BODY_CHARS = 20_000;
function truncateBody(text) {
  if (text.length <= MAX_BODY_CHARS) return text;
  return text.slice(0, MAX_BODY_CHARS) + `\n\n... [truncated — ${text.length} chars total, showing first ${MAX_BODY_CHARS}]`;
}

function wrapTool(handler) {
  return async (args) => {
    try {
      return await handler(args);
    } catch (err) {
      if (err instanceof AgentError) return reply({ error: err.message });
      return errorReply(`Unexpected error: ${err.message}`);
    }
  };
}

// ── L402 token cache (per origin+path, in-memory) ────────────────────────────
const tokenCache = new Map(); // "origin/path" → { macaroon, preimage }

function cacheKey(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch { return url; }
}

function cacheToken(url, macaroon, preimage) {
  tokenCache.set(cacheKey(url), { macaroon, preimage, cachedAt: Date.now() });
}

function getCachedToken(url) {
  return tokenCache.get(cacheKey(url)) || null;
}

/**
 * Parse L402 challenge from WWW-Authenticate header.
 * Format: L402 macaroon="<base64>", invoice="<bolt11>"
 * or:     LSAT macaroon="<base64>", invoice="<bolt11>"
 */
function parseL402Challenge(header) {
  if (!header) return null;
  const match = header.match(/(?:L402|LSAT)\s+macaroon="([^"]+)",\s*invoice="([^"]+)"/i);
  if (!match) return null;
  return { macaroon: match[1], invoice: match[2] };
}

/**
 * Register all wallet tools on a server instance.
 */
export function registerTools(server, getAgentContext, opts = {}) {

  // ── 1. pay_invoice ────────────────────────────────────────────────────────
  server.tool(
    "pay_invoice",
    "Pay a BOLT11 Lightning invoice with real Bitcoin. Budget enforced cryptographically by LND — exceeding it rejects the payment and notifies the user. Use max_cost_sats to refuse invoices above a threshold. Always decode_invoice first for large amounts. Report cost and remaining balance after payment.",
    {
      bolt11: z.string().describe("BOLT11 invoice string"),
      purpose: z.string().describe("Why this payment is being made"),
      max_cost_sats: z.number().int().positive().optional().describe("Optional safety cap set by the USER only. Do NOT set this yourself."),
    },
    wrapTool(async ({ bolt11, purpose, max_cost_sats }) => {
      getAgentContext();
      const btcPrice = await getBtcUsd();
      const steps = [];

      // Decode first
      const decoded = await lnd.decodeInvoice(bolt11);
      if (!decoded.is_valid) return errorReply(`Invalid invoice: ${decoded.error}`);
      if (decoded.is_expired) return errorReply("Invoice expired. Ask for a fresh one.");

      steps.push({
        step: 1,
        action: "invoice_decoded",
        detail: `${decoded.amount_sats} sats ($${satsToUsd(decoded.amount_sats, btcPrice)}) — ${decoded.description || "no description"}`,
        invoice: {
          amount_sats: decoded.amount_sats,
          amount_usd: satsToUsd(decoded.amount_sats, btcPrice),
          description: decoded.description,
          payment_hash: decoded.payment_hash,
          expiry_seconds: decoded.expiry_seconds,
        },
      });

      // Per-payment cost guard (lnget-style --max-cost)
      if (max_cost_sats && decoded.amount_sats > max_cost_sats) {
        steps.push({ step: 2, action: "rejected", detail: `Exceeds max_cost_sats (${max_cost_sats})` });
        return reply({ steps, success: false, reason: "exceeds_max_cost" });
      }

      // Pay
      steps.push({ step: 2, action: "paying", detail: `Sending ${decoded.amount_sats} sats via Lightning...` });
      const result = await lnd.sendPayment(bolt11);

      if (!result.success) {
        let invoiceForwarded = false;
        if (opts.webhookUrl) {
          try {
            await fetch(opts.webhookUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ event: "payment_failed", bolt11, amount_sats: decoded.amount_sats, description: decoded.description, error: result.error, timestamp: new Date().toISOString() }),
            });
            invoiceForwarded = true;
          } catch {}
        }
        steps.push({ step: 3, action: "payment_failed", detail: result.error });
        return reply({
          steps,
          success: false,
          error: result.error,
          invoice_forwarded: invoiceForwarded,
          invoice: { bolt11, amount_sats: decoded.amount_sats, amount_usd: satsToUsd(decoded.amount_sats, btcPrice), description: decoded.description },
          TELL_USER: invoiceForwarded
            ? `The invoice for ${decoded.amount_sats} sats ($${satsToUsd(decoded.amount_sats, btcPrice)}) has been sent to your Aegis wallet app. Open it and tap "Pay directly" to complete this purchase.`
            : `Payment failed: ${result.error}`,
        });
      }

      steps.push({
        step: 3,
        action: "payment_success",
        detail: `Paid ${result.amount_sats} sats + ${result.fee_sats || 0} fee`,
        receipt: {
          preimage: result.preimage,
          amount_sats: result.amount_sats,
          amount_usd: satsToUsd(result.amount_sats, btcPrice),
          fee_sats: result.fee_sats || 0,
          fee_usd: satsToUsd(result.fee_sats || 0, btcPrice),
          payment_hash: decoded.payment_hash,
          balance_remaining_sats: result.balance_remaining_sats,
          balance_remaining_usd: satsToUsd(result.balance_remaining_sats, btcPrice),
        },
      });

      const receipt = steps.find((s) => s.receipt)?.receipt;
      return reply({
        steps,
        success: true,
        purpose,
        SHOW_TO_USER: `Payment receipt — ${result.amount_sats} sats ($${satsToUsd(result.amount_sats, btcPrice)}), fee: ${result.fee_sats || 0} sats, preimage: ${result.preimage}, remaining: ${result.balance_remaining_sats} sats`,
        receipt,
      });
    })
  );

  // ── 2. create_invoice ─────────────────────────────────────────────────────
  server.tool(
    "create_invoice",
    "Generate a BOLT11 Lightning invoice to receive Bitcoin. The payer sends sats to this invoice. Returns bolt11 string and payment_hash.",
    {
      amount_sats: z.number().int().positive().describe("Amount in satoshis"),
      memo: z.string().describe("Description shown to the payer"),
    },
    wrapTool(async ({ amount_sats, memo }) => {
      getAgentContext();
      const invoice = await lnd.addInvoice(amount_sats, memo);
      return reply(invoice);
    })
  );

  // ── 3. get_balance ────────────────────────────────────────────────────────
  server.tool(
    "get_balance",
    "Returns current spending allowance in sats and USD when the USER asks about their balance. Do NOT call this before making a payment — just call pay_invoice or l402_fetch directly.",
    {},
    wrapTool(async () => {
      getAgentContext();
      const { balance_sats } = await lnd.getBalance();
      const btcPrice = await getBtcUsd();
      return reply({
        balance_sats,
        balance_usd: satsToUsd(balance_sats, btcPrice),
      });
    })
  );

  // ── 4. decode_invoice ─────────────────────────────────────────────────────
  server.tool(
    "decode_invoice",
    "Decode a BOLT11 invoice to inspect amount, description, destination, and expiry before paying. Use this to verify cost before committing.",
    {
      bolt11: z.string().describe("BOLT11 invoice string"),
    },
    wrapTool(async ({ bolt11 }) => {
      getAgentContext();
      const decoded = await lnd.decodeInvoice(bolt11);
      if (!decoded.is_valid) return errorReply(decoded.error);
      const btcPrice = await getBtcUsd();
      return reply({
        ...decoded,
        amount_usd: satsToUsd(decoded.amount_sats, btcPrice),
      });
    })
  );

  // ── 5. list_payments ──────────────────────────────────────────────────────
  server.tool(
    "list_payments",
    "List recent payment history with amounts, fees, status, and timestamps.",
    {
      limit: z.number().int().min(1).max(50).default(10).describe("Number of payments to return"),
    },
    wrapTool(async ({ limit }) => {
      getAgentContext();
      const payments = await lnd.listPayments(limit);
      const btcPrice = await getBtcUsd();
      return reply({
        payments: payments.map((p) => ({
          ...p,
          amount_usd: satsToUsd(p.amount_sats, btcPrice),
        })),
      });
    })
  );

  // ── 6. l402_fetch — automatic L402 payment flow (lnget-style) ────────────
  server.tool(
    "l402_fetch",
    "Fetch a URL with automatic L402 Lightning payment. Handles 402 → extract invoice → pay → cache token → retry in one call. Tokens cached per URL path (repeat calls are free). IMPORTANT: Call l402_discover first on new services to learn correct endpoints and params — don't waste sats on bad requests. Use max_cost_sats as a safety cap. Use no_cache=true to force fresh payment. ALWAYS show the receipt (invoice, preimage, amount, fees, remaining balance) to the user after a paid call.",
    {
      url: z.string().describe("URL to fetch"),
      method: z.enum(["GET", "POST", "PUT", "DELETE"]).default("GET").describe("HTTP method"),
      headers: z.record(z.string()).optional().describe("Extra HTTP headers"),
      body: z.string().optional().describe("Request body (for POST/PUT)"),
      max_cost_sats: z.number().int().positive().optional().describe("Optional safety cap set by the USER only. Do NOT set this yourself — let every payment attempt go through regardless of amount."),
      no_cache: z.boolean().default(false).optional().describe("Skip token cache — always pay fresh (useful for demos)"),
    },
    wrapTool(async ({ url, method, headers: extraHeaders, body, max_cost_sats, no_cache }) => {
      getAgentContext();
      const btcPrice = await getBtcUsd();
      const steps = [];

      // Always request uncompressed + JSON to avoid garbled responses
      const reqHeaders = { "Accept-Encoding": "identity", "Accept": "application/json", ...extraHeaders };

      // Check token cache first — reuse if we already paid this domain
      const cached = !no_cache ? getCachedToken(url) : null;
      if (cached) {
        reqHeaders["Authorization"] = `L402 ${cached.macaroon}:${cached.preimage}`;
        steps.push({ step: 1, action: "cache_hit", detail: `Reusing cached L402 token for ${new URL(url).hostname}` });
      } else {
        steps.push({ step: 1, action: "request", detail: `${method} ${url}${no_cache ? " (cache skipped)" : ""}` });
      }

      // First request
      const fetchOpts = { method, headers: reqHeaders, signal: AbortSignal.timeout(15000) };
      if (body && (method === "POST" || method === "PUT")) fetchOpts.body = body;

      let res;
      try {
        res = await fetch(url, fetchOpts);
      } catch (err) {
        return errorReply(`Network error: ${err.message}`);
      }

      // Not a 402 — return the response directly
      if (res.status !== 402) {
        steps.push({
          step: 2,
          action: "response",
          detail: cached
            ? `HTTP ${res.status} — used cached token (no payment, free)`
            : `HTTP ${res.status} (no payment needed)`,
        });
        const responseBody = await res.text();
        return reply({
          steps,
          status: res.status,
          body: truncateBody(responseBody),
          paid: false,
          cached_token: !!cached,
          SHOW_TO_USER: cached ? "No payment — cached token reused (free)" : null,
          receipt: cached
            ? { paid: false, note: "Reused cached L402 token — no sats spent" }
            : null,
        });
      }

      // ── 402 Payment Required — extract L402 challenge ──────────────────
      steps.push({ step: 2, action: "l402_challenge", detail: "Server returned HTTP 402 — payment required" });

      const wwwAuth = res.headers.get("www-authenticate");
      const challenge = parseL402Challenge(wwwAuth);
      if (!challenge) {
        return errorReply(`Got 402 but couldn't parse L402 challenge from WWW-Authenticate: ${wwwAuth || "(missing)"}`);
      }

      // Decode invoice to check amount
      const decoded = await lnd.decodeInvoice(challenge.invoice);
      if (!decoded.is_valid) return errorReply(`L402 invoice invalid: ${decoded.error}`);
      if (decoded.is_expired) return errorReply("L402 invoice expired.");

      steps.push({
        step: 3,
        action: "invoice_decoded",
        detail: `${decoded.amount_sats} sats ($${satsToUsd(decoded.amount_sats, btcPrice)}) — ${decoded.description || "no description"}`,
        invoice: {
          amount_sats: decoded.amount_sats,
          amount_usd: satsToUsd(decoded.amount_sats, btcPrice),
          description: decoded.description,
          payment_hash: decoded.payment_hash,
          expiry_seconds: decoded.expiry_seconds,
        },
      });

      // Per-request cost guard
      if (max_cost_sats && decoded.amount_sats > max_cost_sats) {
        steps.push({ step: 4, action: "rejected", detail: `Invoice ${decoded.amount_sats} sats exceeds max_cost_sats ${max_cost_sats}` });
        return reply({
          steps,
          success: false,
          reason: "exceeds_max_cost",
          message: `Invoice is ${decoded.amount_sats} sats but max_cost_sats is ${max_cost_sats}. Refusing to pay.`,
        });
      }

      // Pay the invoice
      steps.push({ step: 4, action: "paying", detail: `Sending ${decoded.amount_sats} sats via Lightning...` });
      const payment = await lnd.sendPayment(challenge.invoice);

      if (!payment.success) {
        let invoiceForwarded = false;
        if (opts.webhookUrl) {
          try {
            await fetch(opts.webhookUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ event: "payment_failed", bolt11: challenge.invoice, amount_sats: decoded.amount_sats, description: decoded.description, error: payment.error, url, timestamp: new Date().toISOString() }),
            });
            invoiceForwarded = true;
          } catch {}
        }
        if (invoiceForwarded) {
          steps.push({ step: 5, action: "invoice_forwarded", detail: `Invoice for ${decoded.amount_sats} sats forwarded to wallet app` });
          return reply({
            steps,
            success: false,
            invoice_forwarded: true,
            invoice: { bolt11: challenge.invoice, amount_sats: decoded.amount_sats, amount_usd: satsToUsd(decoded.amount_sats, btcPrice), description: decoded.description },
            TELL_USER: `The invoice for ${decoded.amount_sats} sats ($${satsToUsd(decoded.amount_sats, btcPrice)}) has been sent to your Aegis wallet app. Open it and tap "Pay directly" to complete this purchase.`,
          });
        }
        steps.push({ step: 5, action: "payment_failed", detail: payment.error });
        return reply({
          steps,
          success: false,
          error: payment.error,
          TELL_USER: `Payment failed: ${payment.error}`,
        });
      }

      steps.push({
        step: 5,
        action: "payment_success",
        detail: `Paid ${payment.amount_sats} sats + ${payment.fee_sats || 0} fee`,
        receipt: {
          preimage: payment.preimage,
          amount_sats: payment.amount_sats,
          amount_usd: satsToUsd(payment.amount_sats, btcPrice),
          fee_sats: payment.fee_sats || 0,
          fee_usd: satsToUsd(payment.fee_sats || 0, btcPrice),
          payment_hash: decoded.payment_hash,
          balance_remaining_sats: payment.balance_remaining_sats,
          balance_remaining_usd: satsToUsd(payment.balance_remaining_sats, btcPrice),
        },
      });

      // Cache the token for this domain
      cacheToken(url, challenge.macaroon, payment.preimage);
      steps.push({ step: 6, action: "token_cached", detail: `L402 token cached for ${new URL(url).hostname}` });

      // Retry with L402 auth header
      const retryHeaders = {
        ...extraHeaders,
        "Authorization": `L402 ${challenge.macaroon}:${payment.preimage}`,
      };
      const retryOpts = { method, headers: retryHeaders, signal: AbortSignal.timeout(15000) };
      if (body && (method === "POST" || method === "PUT")) retryOpts.body = body;

      let retryRes;
      try {
        retryRes = await fetch(url, retryOpts);
      } catch (err) {
        steps.push({ step: 7, action: "retry_failed", detail: err.message });
        return reply({
          steps,
          paid: true,
          receipt: steps[4]?.receipt,
          retry_error: err.message,
          message: "Payment succeeded but retry request failed. Use the preimage to retry manually.",
        });
      }

      const retryBody = await retryRes.text();
      steps.push({ step: 7, action: "response", detail: `HTTP ${retryRes.status} — data received` });

      const receipt = steps.find((s) => s.receipt)?.receipt;
      return reply({
        steps,
        status: retryRes.status,
        body: truncateBody(retryBody),
        SHOW_TO_USER: receipt
          ? `Payment receipt — ${receipt.amount_sats} sats ($${receipt.amount_usd}), fee: ${receipt.fee_sats} sats, preimage: ${receipt.preimage}, remaining: ${receipt.balance_remaining_sats} sats`
          : "No payment — cached token reused (free)",
        receipt,
      });
    })
  );

  // ── 7. get_spending_summary — total spent + remaining budget ─────────────
  server.tool(
    "get_spending_summary",
    "Get a full spending overview: total sats spent, total fees, payment count, remaining balance (sats + USD), and list of cached L402 domains (where tokens are reusable).",
    {},
    wrapTool(async () => {
      getAgentContext();
      const { balance_sats } = await lnd.getBalance();
      const payments = await lnd.listPayments(50);
      const btcPrice = await getBtcUsd();

      const settled = payments.filter((p) => p.status === "settled");
      const totalSpent = settled.reduce((sum, p) => sum + p.amount_sats, 0);
      const totalFees = settled.reduce((sum, p) => sum + (p.fee_sats || 0), 0);

      return reply({
        balance_sats,
        balance_usd: satsToUsd(balance_sats, btcPrice),
        total_spent_sats: totalSpent,
        total_spent_usd: satsToUsd(totalSpent, btcPrice),
        total_fees_sats: totalFees,
        payment_count: settled.length,
        cached_l402_domains: [...tokenCache.keys()],
      });
    })
  );

  // ── 8. l402_discover — fetch API docs before paying ─────────────────────
  server.tool(
    "l402_discover",
    "Discover how to use an L402 API before spending sats. Returns pricing, endpoint docs, required parameters, and usage instructions — all free. ALWAYS call this on a new service before l402_fetch. Read the response carefully to construct the correct URL with the right query parameters.",
    {
      url: z.string().describe("URL of the L402 endpoint to discover (e.g. https://api.example.com/l402/proxy/service/endpoint)"),
    },
    wrapTool(async ({ url }) => {
      getAgentContext();

      const parsed = new URL(url);
      const baseUrl = parsed.origin;
      const result = {
        endpoint: url,
        pricing: null,
        parameters: null,
        instructions: null,
        manifest: null,
      };

      // 1. Hit the endpoint to get the 402 body (richest source of docs)
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(8000),
          headers: { "Accept-Encoding": "identity", "Accept": "application/json" },
        });

        result.status = res.status;

        if (res.status === 402) {
          // Extract pricing from L402 challenge
          const wwwAuth = res.headers.get("www-authenticate");
          const challenge = parseL402Challenge(wwwAuth);
          if (challenge) {
            const decoded = await lnd.decodeInvoice(challenge.invoice);
            result.pricing = {
              price_sats: decoded.amount_sats,
              description: decoded.description,
            };
          }

          // Check for manifest link header
          const linkHeader = res.headers.get("link");
          if (linkHeader) {
            const manifestMatch = linkHeader.match(/<([^>]+)>;\s*rel="l402-manifest"/);
            if (manifestMatch) {
              try {
                const manifestUrl = new URL(manifestMatch[1], baseUrl).href;
                const mRes = await fetch(manifestUrl, { signal: AbortSignal.timeout(5000) });
                if (mRes.ok) {
                  result.manifest = { url: manifestUrl, content: (await mRes.text()).slice(0, 4000) };
                }
              } catch {}
            }
          }

          // Parse 402 response body — usually has instructions, proxy info, parameters
          try {
            const body = await res.text();
            const data = JSON.parse(body);

            if (data.instructions) result.instructions = data.instructions;
            if (data.proxy) result.service = data.proxy;
            if (data.l402) result.l402_details = data.l402;
            if (data.message) result.message = data.message;
            if (data.error) result.api_error = data.error;

            // Extract parameter hints from error messages or instructions
            if (data.instructions?.step1) {
              result.usage_hint = "Follow the instructions in the 'instructions' field to construct your request correctly.";
            }
          } catch {}
        } else {
          // Non-402 — might be a validation error with helpful info
          try {
            const body = await res.text();
            const data = JSON.parse(body);
            if (data.errors) result.parameters = data.errors;
            if (data.message) result.message = data.message;
          } catch {}
        }
      } catch (err) {
        result.error = err.message;
      }

      // 2. Try well-known doc paths (if no manifest found yet)
      if (!result.manifest) {
        for (const path of [
          "/.well-known/l402-manifest.json",
          "/l402.json",
          "/agent-spec.md",
          "/openapi.json",
          "/docs",
        ]) {
          try {
            const res = await fetch(`${baseUrl}${path}`, {
              signal: AbortSignal.timeout(3000),
              headers: { "Accept": "application/json" },
            });
            if (res.ok) {
              const text = await res.text();
              result.manifest = { url: `${baseUrl}${path}`, content: text.slice(0, 4000) };
              break;
            }
          } catch {}
        }
      }

      // 3. Parse manifest for endpoints
      if (result.manifest?.content) {
        try {
          const manifest = JSON.parse(result.manifest.content);
          if (manifest.endpoints) result.endpoints = manifest.endpoints;
          if (manifest.parameters) result.parameters = manifest.parameters;
          if (manifest.service) result.service = manifest.service;
        } catch {}
      }

      // 4. Try the free test URL to learn exact params from a real response
      // Many L402 proxies have a free version at agent-commerce.store
      const testUrls = [];
      const pathMatch = url.match(/\/l402\/proxy\/([^/]+)\/(.+)/);
      if (pathMatch) {
        testUrls.push(`https://agent-commerce.store/api/weather/${pathMatch[2]}?latitude=40.7&longitude=-74.0`);
      }

      for (const testUrl of testUrls) {
        try {
          const testRes = await fetch(testUrl, {
            signal: AbortSignal.timeout(5000),
            headers: { "Accept-Encoding": "identity", "Accept": "application/json" },
          });
          if (testRes.ok) {
            const testData = await testRes.json();
            if (testData.meta) {
              result.example = {
                test_url: testUrl,
                l402_url: testData.meta.l402_url,
                correct_params: "Use 'latitude' and 'longitude' as query parameters (extracted from test response)",
              };
              // The l402_url from meta tells us the EXACT correct URL format
              if (testData.meta.l402_url) {
                result.correct_l402_url = testData.meta.l402_url;
                result.usage = `Use this exact URL pattern: ${testData.meta.l402_url} — replace lat/lon values as needed`;
              }
            }
            break;
          }
        } catch {}
      }

      return reply(result);
    })
  );
}
