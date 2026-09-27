// Persistent watcher cursor. The block cursor survives restarts so a job
// submitted while the service was down is still picked up; without this,
// anything older than the boot-time lookback window was silently missed.
import fs from "node:fs";
import path from "node:path";

/** Returns the persisted cursor as a BigInt, or null (missing/corrupt file). */
export function loadCursor(file) {
  try {
    const { block } = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof block === "string" && /^\d+$/.test(block)) return BigInt(block);
  } catch { /* missing or corrupt; caller falls back to a bounded lookback */ }
  return null;
}

/** Atomically persist the cursor (write temp + rename). */
export function saveCursor(file, block) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ block: block.toString() }));
  fs.renameSync(tmp, file);
}
