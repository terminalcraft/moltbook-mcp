/**
 * safe-fetch.mjs — Shared HTTP module replacing execSync('curl ...') calls.
 *
 * Provides native fetch()-based HTTP with:
 * - SSRF protection (blocks private/internal IPs)
 * - Configurable timeouts
 * - Status-only and full-body modes
 * - POST support with JSON payloads
 *
 * Replaces curl in: service-liveness.mjs, service-evaluator.mjs, account-manager.mjs
 */

const PRIVATE_IP_RE = /^(127\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|0\.|localhost|169\.254\.|\[::1\]|\[fc|\[fd)/i;

function isPrivateHost(hostname) {
  return PRIVATE_IP_RE.test(hostname);
}

/**
 * Fetch a URL with timeout and SSRF protection.
 * Returns { status, body, elapsed, redirectUrl, error }
 */
export async function safeFetch(url, opts = {}) {
  const {
    timeout = 8000,
    method = "GET",
    headers = {},
    body = null,
    maxRedirects = 5,
    userAgent = "moltbook-agent/1.0",
    bodyMode = "text",   // "text" | "none" (skip body read)
    maxBody = 2 * 1024 * 1024,
    allowInternal = false,
  } = opts;

  const start = Date.now();

  try {
    const parsed = new URL(url);

    // SSRF protection — block private IPs unless explicitly allowed
    if (!allowInternal && isPrivateHost(parsed.hostname)) {
      return { status: 0, body: null, elapsed: 0, error: "blocked_private_ip" };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const fetchHeaders = { "User-Agent": userAgent, ...headers };
    const fetchOpts = {
      method,
      headers: fetchHeaders,
      signal: controller.signal,
      redirect: maxRedirects > 0 ? "follow" : "manual",
    };
    if (body !== null) {
      fetchOpts.body = typeof body === "string" ? body : JSON.stringify(body);
    }

    const resp = await fetch(url, fetchOpts);
    clearTimeout(timer);

    const elapsed = (Date.now() - start) / 1000;

    if (bodyMode === "none") {
      return { status: resp.status, body: null, elapsed, error: null };
    }

    const text = await resp.text();
    const truncated = text.length > maxBody ? text.slice(0, maxBody) : text;

    return { status: resp.status, body: truncated, elapsed, error: null };
  } catch (e) {
    const elapsed = (Date.now() - start) / 1000;
    if (e.name === "AbortError") {
      return { status: 0, body: null, elapsed, error: "timeout" };
    }
    return { status: 0, body: null, elapsed, error: "connection_error" };
  }
}

/**
 * Fetch just the HTTP status code (no body).
 */
export async function fetchStatus(url, opts = {}) {
  const result = await safeFetch(url, { ...opts, bodyMode: "none" });
  return result.status;
}

/**
 * Fetch body as text.
 */
export async function fetchBody(url, opts = {}) {
  const result = await safeFetch(url, opts);
  return result.body;
}
