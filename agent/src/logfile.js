// The decision log on disk: one JSON entry per line, verified when loaded.
import fs from "node:fs";
import path from "node:path";
import { createLedger } from "./ledger.js";

export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
export const logPathFor = (brief, dir) => path.join(dir, `${slug(brief.project)}.jsonl`);

export function openLog(file, opts = {}) {
  const entries = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  return createLedger({ ...opts, entries, onAppend: (e) => fs.appendFileSync(file, JSON.stringify(e) + "\n") });
}
