// Every store has the same four calls; update() runs one record's read-modify-write at a time, so two requests for
// the same record cannot interleave inside this process. Records carry their key in `id`.
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const JOB_ID = /^[0-9]{6,30}$/;
const clone = (x) => (x === null || x === undefined ? null : structuredClone(x));

function serial() {
  const tails = new Map();
  return (id, fn) => {
    const prev = tails.get(id) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    tails.set(id, next.catch(() => {}));
    return next;
  };
}

export function memoryStore() {
  const records = new Map();
  const run = serial();
  return {
    kind: "memory",
    async get(id) { return clone(records.get(String(id))); },
    async put(record) { records.set(String(record.id), clone(record)); return clone(record); },
    async list() { return [...records.values()].map(clone); },
    update(id, fn) {
      return run(String(id), async () => {
        const cur = records.get(String(id));
        if (!cur) return null;
        const next = await fn(clone(cur));
        records.set(String(id), clone(next));
        return clone(next);
      });
    },
  };
}

/** Jobs: one file per job named by its numeric id. */
export const jobFileName = (id) => {
  if (!JOB_ID.test(String(id))) throw new RangeError(`bad job id: ${id}`);
  return `${id}.json`;
};
/** One JSON file per record, written to a temporary name and renamed, so a crash never leaves half a record. */
export function fileStore(dir, { fileName = jobFileName } = {}) {
  const run = serial();
  const path = (id) => join(dir, fileName(id));
  async function read(id) {
    try { return JSON.parse(await readFile(path(id), "utf8")); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
  }
  async function write(record) {
    await mkdir(dir, { recursive: true });
    const tmp = `${path(record.id)}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(record, null, 2));
    await rename(tmp, path(record.id));
    return record;
  }
  return {
    kind: "file",
    get: read,
    put: write,
    async list() {
      let names = [];
      try { names = await readdir(dir); } catch (e) { if (e.code !== "ENOENT") throw e; }
      const records = [];
      for (const n of names) {
        if (!n.endsWith(".json")) continue;
        try { records.push(JSON.parse(await readFile(join(dir, n), "utf8"))); } catch { /* a half-written temp file is never .json */ }
      }
      return records;
    },
    update(id, fn) {
      return run(String(id), async () => {
        const cur = await read(id);
        if (!cur) return null;
        return write(await fn(cur));
      });
    },
  };
}

/**
 * Jobs in a private Vercel Blob store, for serverless hosting where the local disk does not last. Reads bypass the CDN
 * cache (useCache: false) so they see the latest write. update() writes with ifMatch on the ETag it read, so when two
 * function instances change one job at once, the later write is refused and its change is re-applied to the fresh
 * record. That is safe because every update callback in the escrow is a pure edit of the record: PayPal calls happen
 * outside update(), guarded by their own idempotency keys.
 */
export function blobStore({ client, isConflict, prefix = "judge-pay/jobs/", fileName = jobFileName, retries = 5 } = {}) {
  if (!client) throw new Error("blobStore needs a client (the @vercel/blob module)");
  const run = serial();
  const path = (id) => `${prefix}${fileName(id)}`;
  async function read(id) {
    const r = await client.get(path(id), { access: "private", useCache: false });
    if (!r || r.statusCode !== 200) return null;
    return { record: JSON.parse(await new Response(r.stream).text()), etag: r.blob.etag };
  }
  async function write(record, ifMatch) {
    await client.put(path(record.id), JSON.stringify(record), {
      access: "private", addRandomSuffix: false, allowOverwrite: true, contentType: "application/json",
      ...(ifMatch ? { ifMatch } : {}),
    });
    return record;
  }
  return {
    kind: "blob",
    async get(id) { return (await read(id))?.record ?? null; },
    put: (record) => write(record),
    async list() {
      const records = [];
      let cursor;
      do {
        const page = await client.list({ prefix, cursor, limit: 1000 });
        for (const b of page.blobs) {
          const id = b.pathname.slice(prefix.length).replace(/\.json$/, "");
          const r = await read(id).catch(() => null);
          if (r) records.push(r.record);
        }
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      return records;
    },
    update(id, fn) {
      return run(String(id), async () => {
        for (let attempt = 0; attempt < retries; attempt++) {
          const cur = await read(id);
          if (!cur) return null;
          const next = await fn(cur.record);
          try { return await write(next, cur.etag); } catch (e) { if (!isConflict(e)) throw e; }
        }
        throw new Error(`job ${id} kept being changed by another request; try again`);
      });
    },
  };
}
