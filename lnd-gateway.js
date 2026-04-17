/**
 * LND client for the MCP package.
 * Connects directly to LND's REST API — no sidecar, no gRPC, pure fetch.
 *
 * Connection: LND REST (HTTPS, port 8080 by default)
 * Auth: macaroon in Grpc-Metadata-macaroon header (hex-encoded)
 *
 * Env vars:
 *   LND_REST_HOST   — LND REST address (default: https://localhost:8080)
 *   LND_CERT_PATH   — TLS cert for self-signed (optional, skips verify if not set)
 */

let _host = null;
let _macaroonHex = null;

export function initLnd(macaroonB64) {
  _host = process.env.LND_REST_HOST || "https://localhost:8080";
  // Convert base64 macaroon to hex (LND REST expects hex in header)
  _macaroonHex = Buffer.from(macaroonB64, "base64").toString("hex");
}

async function lndRest(method, path, body) {
  if (!_host || !_macaroonHex) throw new Error("LND not initialized. Call initLnd() first.");

  const opts = {
    method,
    headers: {
      "Grpc-Metadata-macaroon": _macaroonHex,
      "Content-Type": "application/json",
    },
    // Skip TLS verification for self-signed certs (litd default)
    ...(process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0" ? {} : {}),
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${_host}${path}`, opts);
  const data = await res.json();

  // LND REST returns { code, message, details } on errors
  if (data.code && data.message) {
    throw new Error(data.message);
  }

  return data;
}

// ── Balance ─────────────────────────────────────────────────────────────────

export async function getBalance() {
  const data = await lndRest("GET", "/v1/balance/channels");
  return { balance_sats: parseInt(data.local_balance?.sat || "0") };
}

// ── Payments ────────────────────────────────────────────────────────────────

export async function sendPayment(bolt11) {
  if (!_host || !_macaroonHex) throw new Error("LND not initialized");

  // Use SendPaymentV2 (streaming) for timeout + cancel support.
  // no_inflight_updates=true means we only get the terminal SUCCEEDED/FAILED.
  const controller = new AbortController();
  const safetyTimeout = setTimeout(() => controller.abort(), 90_000);

  try {
    const res = await fetch(`${_host}/v2/router/send`, {
      method: "POST",
      headers: {
        "Grpc-Metadata-macaroon": _macaroonHex,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        payment_request: bolt11,
        timeout_seconds: 60,
        fee_limit_sat: "1000",
        no_inflight_updates: true,
      }),
      signal: controller.signal,
    });

    // litd rejects budget-exceeded payments as a plain JSON error (HTTP 500)
    // before the stream starts. Handle that before reading NDJSON.
    if (!res.ok) {
      const text = await res.text();
      try {
        const err = JSON.parse(text);
        const msg = err.error?.message || err.message || text;
        return {
          success: false,
          error: msg,
          budget_exceeded: msg.includes("no request values") || msg.includes("insufficient"),
        };
      } catch {
        return { success: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
      }
    }

    // Read NDJSON stream line by line
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete trailing line

      for (const line of lines) {
        if (!line.trim()) continue;
        let parsed;
        try { parsed = JSON.parse(line); } catch { continue; }
        const payment = parsed.result || parsed;

        if (payment.status === "SUCCEEDED") {
          const { balance_sats } = await getBalance();
          return {
            success: true,
            amount_sats: parseInt(payment.value_sat || "0"),
            fee_sats: parseInt(payment.fee_sat || "0"),
            preimage: payment.payment_preimage || "",  // already hex from V2
            balance_remaining_sats: balance_sats,
          };
        }

        if (payment.status === "FAILED") {
          const reason = payment.failure_reason || "UNKNOWN";
          return {
            success: false,
            error: reason,
            budget_exceeded: reason === "FAILURE_REASON_INSUFFICIENT_BALANCE",
          };
        }
      }
    }

    return { success: false, error: "payment stream ended without terminal state" };
  } catch (err) {
    if (err.name === "AbortError") {
      return { success: false, error: "payment timed out after 90s" };
    }
    return { success: false, error: err.message || String(err) };
  } finally {
    clearTimeout(safetyTimeout);
  }
}

// ── Invoices ────────────────────────────────────────────────────────────────

export async function addInvoice(amountSats, memo) {
  const data = await lndRest("POST", "/v1/invoices", {
    value: String(amountSats),
    memo,
  });
  return {
    bolt11: data.payment_request,
    payment_hash: data.r_hash,
  };
}

export async function decodeInvoice(bolt11) {
  if (!bolt11 || (!bolt11.startsWith("lnbc") && !bolt11.startsWith("lntb"))) {
    return { is_valid: false, error: "not a Lightning invoice — must start with 'lnbc' or 'lntb'" };
  }
  try {
    const data = await lndRest("GET", `/v1/payreq/${bolt11}`);
    const expiry = parseInt(data.expiry || "3600");
    const timestamp = parseInt(data.timestamp || "0");
    const expiresAt = (timestamp + expiry) * 1000;
    return {
      is_valid: true,
      is_expired: expiresAt < Date.now(),
      payment_hash: data.payment_hash,
      amount_sats: parseInt(data.num_satoshis || "0"),
      description: data.description || "",
      expiry_seconds: Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)),
    };
  } catch (err) {
    return { is_valid: false, error: err.message };
  }
}

// ── Payment History ─────────────────────────────────────────────────────────

export async function listPayments(limit = 10) {
  const data = await lndRest("GET", `/v1/payments?reversed=true&max_payments=${limit}`);
  return (data.payments || []).map((p) => ({
    amount_sats: parseInt(p.value_sat || "0"),
    fee_sats: parseInt(p.fee_sat || "0"),
    status: p.status === "SUCCEEDED" ? "settled" : p.status === "FAILED" ? "failed" : "pending",
    timestamp: new Date(parseInt(p.creation_date || "0") * 1000).toISOString(),
  }));
}

// ── Info ─────────────────────────────────────────────────────────────────────

export async function getInfo() {
  return lndRest("GET", "/v1/getinfo");
}
