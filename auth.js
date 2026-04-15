/**
 * Agent validation — macaroon-based, no auth tokens.
 *
 * The litd account macaroon IS the credential. No DB lookup needed.
 * Rate limiting is the only server-side check.
 */

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_CALLS = 30;
const callLog = new Map();

export function validateAgent(agentContext) {
  if (!agentContext || !agentContext.macaroon) {
    throw new AgentError(
      "No macaroon configured. Start the MCP server with: --macaroon <base64_macaroon>"
    );
  }

  // Rate limiting
  const key = agentContext.macaroon.slice(0, 20);
  const now = Date.now();
  if (!callLog.has(key)) callLog.set(key, []);
  const log = callLog.get(key);
  while (log.length > 0 && log[0] < now - RATE_LIMIT_WINDOW_MS) log.shift();

  if (log.length >= RATE_LIMIT_MAX_CALLS) {
    throw new AgentError(`Rate limited — max ${RATE_LIMIT_MAX_CALLS} tool calls per minute.`);
  }

  log.push(now);
  return agentContext;
}

export class AgentError extends Error {
  constructor(message) {
    super(message);
    this.name = "AgentError";
  }
}
