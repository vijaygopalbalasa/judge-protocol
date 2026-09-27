// The decision log on disk: one JSON entry per line, verified when loaded, with
// a high-water mark beside it (<log>.head) so a log that lost its tail, or was
// rolled back to another history, is refused instead of trusted. (Someone who
// can rewrite both files could also rewrite the brief; this guards against
// crashes, bad copies and restores, not against the owner's own disk.)
import fs from "node:fs";
import path from "node:path";
import { createLedger } from "./ledger.js";

export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
export const logPathFor = (brief, dir) => path.join(dir, `${slug(brief.project)}.jsonl`);

export function openLog(file, opts = {}) {
  const markFile = `${file}.head`;
  const entries = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  if (fs.existsSync(markFile)) {
    const mark = JSON.parse(fs.readFileSync(markFile, "utf8"));
    const at = entries[mark.count - 1];
    if (entries.length < mark.count || !at || at.hash !== mark.head) {
      throw new Error(`refusing ${file}: it has ${entries.length} entries but its last known state was ${mark.count} ending in ${mark.head}; it was truncated or rolled back`);
    }
  }
  const ledger = createLedger({ ...opts, entries, onAppend: (e) => {
    fs.appendFileSync(file, JSON.stringify(e) + "\n");
    fs.writeFileSync(markFile, JSON.stringify({ count: e.seq + 1, head: e.hash }));
  } });
  if (entries.length && !fs.existsSync(markFile)) {
    fs.writeFileSync(markFile, JSON.stringify({ count: entries.length, head: ledger.head() }));
  }
  return ledger;
}
