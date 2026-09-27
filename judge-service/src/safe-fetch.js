// SSRF-hardened fetch. Both deliverable resolution and the http-endpoint checker
// fetch client-controlled URLs. Without guards that is a server-side request
// forgery + exfiltration primitive against the judge's own network. Every
// outbound fetch in the service MUST go through here.
//
// Guards: scheme allowlist (http/https), DNS resolution + private/loopback/
// link-local/ULA denylist, request timeout, and a streamed response size cap.
// DNS is resolved ONCE and the connection is pinned to the address that passed
// the check, so a rebinding server cannot answer "public" to the check and
// "internal" to the connection.

import dns from "node:dns/promises";
import net from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

export const MAX_BYTES = Number(process.env.MAX_DELIVERABLE_BYTES || 1_000_000); // 1 MB
export const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 5000);

/** True if an IP literal is private, loopback, link-local, ULA, or unspecified. */
export function isBlockedIp(ip) {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10) return true;                         // 10.0.0.0/8
    if (a === 127) return true;                        // loopback
    if (a === 0) return true;                          // 0.0.0.0/8
    if (a === 169 && b === 254) return true;           // link-local + cloud metadata 169.254.169.254
    if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12
    if (a === 192 && b === 168) return true;           // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    if (a >= 224) return true;                         // multicast/reserved
    return false;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;          // loopback / unspecified
    if (/^fe[89ab]/.test(lower)) return true;                   // link-local fe80::/10
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA fc00::/7
    if (lower.startsWith("::ffff:")) return isBlockedIp(lower.slice(7)); // IPv4-mapped
    if (lower.startsWith("fec0") || /^fe[c-f]/.test(lower)) return true; // site-local fec0::/10
    if (lower.startsWith("64:ff9b:")) return true;              // NAT64 64:ff9b::/96 can reach internal IPv4
    return false;
  }
  return true; // not a valid IP → block
}

const systemLookup = (host) => dns.lookup(host, { all: true });

/** A fetch failure with a stable code. Callers decide on `code`, never on the
 *  message: it can contain the URL, and so anything a provider wrote. */
export class FetchError extends Error {
  constructor(code, message) { super(message); this.name = "FetchError"; this.code = code; }
}

/**
 * Validate a URL and resolve it ONCE. Blocks if the scheme is not http(s) or if
 * ANY resolved address is internal. Returns the URL and the single address the
 * connection will be pinned to.
 */
export async function resolvePublicAddress(rawUrl, { lookup = systemLookup } = {}) {
  let u;
  try { u = new URL(rawUrl); } catch { throw new FetchError("INVALID_URL", `invalid URL: ${rawUrl}`); }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    throw new FetchError("BLOCKED_SCHEME", `blocked scheme: ${u.protocol}`);
  if (u.username || u.password) throw new FetchError("CREDENTIALS", "URL must not include credentials");

  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new FetchError("BLOCKED_ADDRESS", `blocked address: ${host}`);
    return { url: u, address: host, family: net.isIP(host) };
  }
  let addrs;
  try { addrs = await lookup(host); }
  catch { throw new FetchError("DNS_FAILED", `DNS resolution failed: ${host}`); }
  if (!addrs || addrs.length === 0) throw new FetchError("NO_DNS_RECORDS", `no DNS records: ${host}`);
  for (const { address } of addrs) {
    if (isBlockedIp(address)) throw new FetchError("RESOLVES_BLOCKED", `host ${host} resolves to blocked address ${address}`);
  }
  return { url: u, address: addrs[0].address, family: addrs[0].family };
}

/** Validate a URL is fetchable and resolves only to public addresses. */
export async function assertPublicUrl(rawUrl, opts) {
  return (await resolvePublicAddress(rawUrl, opts)).url;
}

/** A DNS lookup that only ever answers with the pre-validated address. */
export function pinnedLookup(address, family) {
  return (hostname, options, cb) => {
    if (typeof options === "function") { cb = options; options = {}; }
    if (options && options.all) cb(null, [{ address, family }]);
    else cb(null, address, family);
  };
}

/**
 * Fetch a client-controlled URL safely. Returns { content: Buffer, status,
 * headers }. Enforces the SSRF denylist, a timeout, and a hard byte cap
 * (streamed: a malicious server cannot exhaust memory by lying about length).
 */
export async function safeFetch(rawUrl, { timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAX_BYTES, lookup, fetchImpl = undiciFetch, okOnly = false } = {}) {
  const { address, family } = await resolvePublicAddress(rawUrl, { lookup });
  const dispatcher = new Agent({ connect: { lookup: pinnedLookup(address, family) } });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(rawUrl, { signal: ctrl.signal, redirect: "error", dispatcher });
    if (okOnly && (res.status < 200 || res.status >= 300)) {
      // An error page is not the content asked for, however large it is.
      try { await res.body?.cancel(); } catch {}
      throw new FetchError("HTTP_STATUS", `http fetch ${res.status}`);
    }
    const reader = res.body?.getReader();
    const chunks = [];
    let total = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) { try { await reader.cancel(); } catch {} throw new FetchError("TOO_LARGE", `response exceeds ${maxBytes} bytes`); }
        chunks.push(Buffer.from(value));
      }
    }
    return { content: Buffer.concat(chunks), status: res.status, headers: res.headers };
  } finally {
    clearTimeout(timer);
    dispatcher.close().catch(() => {});
  }
}
