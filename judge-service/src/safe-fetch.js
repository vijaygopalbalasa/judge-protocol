// SSRF-hardened fetch. Both deliverable resolution and the http-endpoint checker
// fetch client-controlled URLs. Without guards that is a server-side request
// forgery + exfiltration primitive against the judge's own network. Every
// outbound fetch in the service MUST go through here.
//
// Guards: scheme allowlist (http/https), DNS resolution + private/loopback/
// link-local/ULA denylist (defeats DNS-rebind-to-internal and raw-IP SSRF),
// request timeout, and a streamed response size cap.

import dns from "node:dns/promises";
import net from "node:net";

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
    if (lower.startsWith("fe80")) return true;                  // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA fc00::/7
    if (lower.startsWith("::ffff:")) return isBlockedIp(lower.slice(7)); // IPv4-mapped
    return false;
  }
  return true; // not a valid IP → block
}

/** Validate a URL is fetchable and resolves only to public addresses. */
export async function assertPublicUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { throw new Error(`invalid URL: ${rawUrl}`); }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    throw new Error(`blocked scheme: ${u.protocol}`);

  const host = u.hostname;
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new Error(`blocked address: ${host}`);
    return u;
  }
  // Resolve hostname; block if ANY resolved address is private.
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); }
  catch { throw new Error(`DNS resolution failed: ${host}`); }
  if (addrs.length === 0) throw new Error(`no DNS records: ${host}`);
  for (const { address } of addrs) {
    if (isBlockedIp(address)) throw new Error(`host ${host} resolves to blocked address ${address}`);
  }
  return u;
}

/**
 * Fetch a client-controlled URL safely. Returns { content: Buffer, status,
 * headers }. Enforces the SSRF denylist, a timeout, and a hard byte cap
 * (streamed: a malicious server cannot exhaust memory by lying about length).
 */
export async function safeFetch(rawUrl, { timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAX_BYTES } = {}) {
  await assertPublicUrl(rawUrl);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(rawUrl, { signal: ctrl.signal, redirect: "error" });
    const reader = res.body?.getReader();
    const chunks = [];
    let total = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) { try { await reader.cancel(); } catch {} throw new Error(`response exceeds ${maxBytes} bytes`); }
        chunks.push(Buffer.from(value));
      }
    }
    return { content: Buffer.concat(chunks), status: res.status, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}
