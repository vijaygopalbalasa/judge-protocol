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

/* ------------------------ DNS pinning (security review) -------------------- */
import { resolvePublicAddress, pinnedLookup, safeFetch } from "../src/safe-fetch.js";

test("NAT64, site-local and the whole fe80::/10 link-local range are blocked too", () => {
  for (const ip of ["64:ff9b::a00:1", "64:ff9b::7f00:1", "fec0::1", "fe90::1", "fea0::1", "febf::1"]) {
    assert.equal(isBlockedIp(ip), true, `${ip} should be blocked`);
  }
});

test("the connection is pinned to the address that passed the check (no DNS rebinding)", async () => {
  let calls = 0;
  // First answer public, every later answer internal: a classic rebinding server.
  const lookup = async () => { calls++; return calls === 1 ? [{ address: "93.184.215.14", family: 4 }] : [{ address: "169.254.169.254", family: 4 }]; };
  const r = await resolvePublicAddress("https://rebind.example/x", { lookup });
  assert.equal(r.address, "93.184.215.14");
  const pinned = pinnedLookup(r.address, r.family);
  const got = await new Promise((res) => pinned("rebind.example", {}, (err, address, family) => res({ err, address, family })));
  assert.deepEqual(got, { err: null, address: "93.184.215.14", family: 4 });
  const all = await new Promise((res) => pinned("rebind.example", { all: true }, (err, list) => res(list)));
  assert.deepEqual(all, [{ address: "93.184.215.14", family: 4 }]);
  assert.equal(calls, 1, "DNS is consulted exactly once");
});

test("safeFetch hands the HTTP client the pinned lookup and resolves DNS once", async () => {
  let dnsCalls = 0, seen = null;
  const lookup = async () => { dnsCalls++; return [{ address: "93.184.215.14", family: 4 }]; };
  const fetchImpl = async (url, init) => {
    seen = init;
    return new Response("ok");
  };
  const r = await safeFetch("https://pin.example/file.txt", { lookup, fetchImpl });
  assert.equal(r.content.toString(), "ok");
  assert.equal(dnsCalls, 1);
  assert.ok(seen && seen.dispatcher, "a pinned dispatcher must be passed to fetch");
  assert.equal(seen.redirect, "error");
});

test("a host with any internal address is refused before any connection", async () => {
  let fetched = false;
  const lookup = async () => [{ address: "93.184.215.14", family: 4 }, { address: "10.0.0.7", family: 4 }];
  await assert.rejects(() => safeFetch("https://mixed.example/", { lookup, fetchImpl: async () => { fetched = true; } }), /blocked/);
  assert.equal(fetched, false);
});
