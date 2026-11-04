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
