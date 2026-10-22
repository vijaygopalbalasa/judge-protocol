// Where jobs live. Every store has the same four calls; update() runs one job's read-modify-write at a time, so two
// requests for the same job cannot interleave inside this process.
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ID = /^[0-9]{6,30}$/;
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
  const jobs = new Map();
  const run = serial();
  return {
    kind: "memory",
    async get(id) { return clone(jobs.get(String(id))); },
    async put(job) { jobs.set(job.id, clone(job)); return clone(job); },
    async list() { return [...jobs.values()].map(clone); },
    update(id, fn) {
      return run(String(id), async () => {
        const cur = jobs.get(String(id));
        if (!cur) return null;
        const next = await fn(clone(cur));
        jobs.set(String(id), clone(next));
        return clone(next);
      });
    },
  };
}

/** One JSON file per job, written to a temporary name and renamed, so a crash never leaves half a job. */
export function fileStore(dir) {
  const run = serial();
  const path = (id) => {
    if (!ID.test(String(id))) throw new RangeError(`bad job id: ${id}`);
    return join(dir, `${id}.json`);
  };
  async function read(id) {
    try { return JSON.parse(await readFile(path(id), "utf8")); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
  }
  async function write(job) {
    await mkdir(dir, { recursive: true });
    const tmp = `${path(job.id)}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(job, null, 2));
    await rename(tmp, path(job.id));
    return job;
  }
  return {
    kind: "file",
    get: read,
    put: write,
    async list() {
      let names = [];
      try { names = await readdir(dir); } catch (e) { if (e.code !== "ENOENT") throw e; }
      const jobs = [];
      for (const n of names) if (/^[0-9]+\.json$/.test(n)) { const j = await read(n.slice(0, -5)); if (j) jobs.push(j); }
      return jobs;
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
