// SSRF guard tests. These assert that client-controlled URLs pointing at
// internal infrastructure are rejected before any request leaves the process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isBlockedIp, assertPublicUrl } from "../src/safe-fetch.js";

test("private / loopback / metadata IPv4 ranges are blocked", () => {
  for (const ip of ["127.0.0.1", "10.0.0.1", "192.168.1.1", "172.16.5.4",
                     "169.254.169.254", "0.0.0.0", "100.64.0.1"]) {
    assert.equal(isBlockedIp(ip), true, `${ip} should be blocked`);
  }
});

test("public IPv4 addresses are allowed", () => {
  for (const ip of ["1.1.1.1", "8.8.8.8", "140.82.121.4"]) {
    assert.equal(isBlockedIp(ip), false, `${ip} should be allowed`);
  }
});

test("loopback / ULA / link-local IPv6 are blocked", () => {
  for (const ip of ["::1", "fe80::1", "fc00::1", "fd12::34", "::ffff:127.0.0.1"]) {
    assert.equal(isBlockedIp(ip), true, `${ip} should be blocked`);
  }
});

test("assertPublicUrl rejects non-http(s) schemes", async () => {
  await assert.rejects(() => assertPublicUrl("file:///etc/passwd"), /blocked scheme/);
  await assert.rejects(() => assertPublicUrl("gopher://x"), /blocked scheme/);
});

test("assertPublicUrl rejects raw internal IPs", async () => {
  await assert.rejects(() => assertPublicUrl("http://127.0.0.1/admin"), /blocked address/);
  await assert.rejects(() => assertPublicUrl("http://169.254.169.254/latest/meta-data/"), /blocked address/);
});

test("assertPublicUrl rejects hostnames that resolve to private space", async () => {
  // localhost resolves to 127.0.0.1 / ::1
  await assert.rejects(() => assertPublicUrl("http://localhost:8545/"), /blocked address|resolves to blocked/);
});

test("assertPublicUrl allows a normal public URL shape", async () => {
  // Uses DNS; a public host must not throw the SSRF guards. (Network-dependent;
  // if offline this resolves via cache or is skipped by the harness.)
  const u = await assertPublicUrl("https://example.com/deliverable.json");
  assert.equal(u.hostname, "example.com");
});
