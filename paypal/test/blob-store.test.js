import test from "node:test";
import assert from "node:assert/strict";
import { blobStore } from "../src/store.js";

class PreconditionFailed extends Error {}

/** An in-memory stand-in for the @vercel/blob calls the store uses, with ETags and ifMatch like the service. */
function fakeBlob({ conflictOnce = false, weakEtags = false } = {}) {
  const blobs = new Map();
  let version = 0;
  let conflict = conflictOnce;
  const calls = [];
  return {
    blobs, calls, PreconditionFailed,
    async put(pathname, body, opts) {
      calls.push({ op: "put", pathname, opts });
      assert.equal(opts.access, "private");
      assert.equal(opts.addRandomSuffix, false);
      const cur = blobs.get(pathname);
      if (opts.ifMatch !== undefined) {
        if (conflict) { conflict = false; blobs.set(pathname, { body: JSON.stringify({ ...JSON.parse(cur.body), touched: true }), etag: `e${++version}` }); throw new PreconditionFailed("etag mismatch"); }
        if (!cur || cur.etag !== opts.ifMatch) throw new PreconditionFailed("etag mismatch");
      } else if (cur && !opts.allowOverwrite) throw new Error("exists");
      blobs.set(pathname, { body: String(body), etag: `e${++version}` });
      return { pathname };
    },
    async get(pathname, opts) {
      calls.push({ op: "get", pathname, opts });
      assert.equal(opts.access, "private");
      assert.equal(opts.useCache, false, "reads must bypass the CDN cache to see the latest write");
      const cur = blobs.get(pathname);
      if (!cur) return null;
      // The real service sends a weak tag (W/"...") on compressed reads but compares writes against the strong one.
      return { statusCode: 200, stream: new Response(cur.body).body, blob: { pathname, etag: weakEtags ? `W/${cur.etag}` : cur.etag } };
    },
    async list({ prefix, cursor }) {
      const names = [...blobs.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = names.slice(start, start + 2);
      const next = start + 2 < names.length ? String(start + 2) : undefined;
      return { blobs: page.map((pathname) => ({ pathname })), cursor: next, hasMore: Boolean(next) };
    },
  };
}

test("blob store: put, get and list round-trip private records, across list pages", async () => {
  const client = fakeBlob();
  const store = blobStore({ client, isConflict: (e) => e instanceof PreconditionFailed });
  for (const id of ["1000001", "1000002", "1000003"]) await store.put({ id, status: "open" });
  assert.deepEqual(await store.get("1000002"), { id: "1000002", status: "open" });
  assert.equal(await store.get("1000009"), null);
  assert.deepEqual((await store.list()).map((r) => r.id).sort(), ["1000001", "1000002", "1000003"]);
  assert.ok([...client.blobs.keys()].every((k) => k.startsWith("judge-pay/jobs/")));
});

test("blob store: update writes only if nobody changed the record since it was read, and re-applies on a conflict", async () => {
  const client = fakeBlob({ conflictOnce: true });
  const store = blobStore({ client, isConflict: (e) => e instanceof PreconditionFailed });
  await store.put({ id: "1000001", n: 0 });
  let runs = 0;
  const out = await store.update("1000001", (j) => { runs++; j.n += 1; return j; });
  assert.equal(runs, 2, "the change is re-applied to the fresh record after a conflict");
  assert.equal(out.n, 1);
  assert.equal(out.touched, true, "the other writer's change is kept, not overwritten");
  assert.ok(client.calls.some((c) => c.op === "put" && c.opts.ifMatch));
});

test("blob store: update of a missing record is null, and bad ids are refused", async () => {
  const store = blobStore({ client: fakeBlob(), isConflict: () => false });
  assert.equal(await store.update("1000001", (j) => j), null);
  await assert.rejects(store.get("../x"), RangeError);
});

test("blob store: a record that keeps conflicting fails loudly instead of overwriting", async () => {
  const client = fakeBlob();
  const store = blobStore({ client, isConflict: (e) => e instanceof PreconditionFailed, retries: 3 });
  await store.put({ id: "1000001", n: 0 });
  const realPut = client.put;
  client.put = async (p, b, o) => { if (o.ifMatch) throw new PreconditionFailed("busy"); return realPut(p, b, o); };
  await assert.rejects(store.update("1000001", (j) => j), /changed by another request/);
});

test("blob store: a weak ETag from a compressed read still makes a valid conditional write", async () => {
  const client = fakeBlob({ weakEtags: true });
  const store = blobStore({ client, isConflict: (e) => e instanceof PreconditionFailed });
  await store.put({ id: "1000001", n: 0 });
  const out = await store.update("1000001", (j) => { j.n += 1; return j; });
  assert.equal(out.n, 1);
  assert.ok(client.calls.filter((c) => c.op === "put" && c.opts.ifMatch).every((c) => !c.opts.ifMatch.startsWith("W/")));
});
