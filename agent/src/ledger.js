// An append-only decision log, hash-chained: every entry commits to the one
// before it, so an edit, deletion, insertion or reordering is detectable. The
// head hash goes into each job description, anchoring the log on chain.
import { keccak256, toHex } from "viem";
import { canonicalize } from "../../kit/judge-kit.js";

export const GENESIS = "0x" + "0".repeat(64);
const plain = (v) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));
const hashOf = ({ seq, at, type, data, prev }) => keccak256(toHex(canonicalize({ seq, at, type, data, prev })));

export function verifyLedger(entries) {
  let prev = GENESIS;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e || e.seq !== i) return { ok: false, badSeq: i, reason: "out of sequence" };
    if (e.prev !== prev) return { ok: false, badSeq: i, reason: "broken chain" };
    if (hashOf(e) !== e.hash) return { ok: false, badSeq: i, reason: "hash does not match the entry" };
    prev = e.hash;
  }
  return { ok: true, head: prev };
}

export function createLedger({ entries = [], clock = () => new Date().toISOString(), onAppend } = {}) {
  const list = entries.map((e) => ({ ...e }));
  const v = verifyLedger(list);
  if (!v.ok) throw new Error(`refusing to continue a tampered log (entry ${v.badSeq}: ${v.reason})`);
  return {
    entries: list,
    head: () => (list.length ? list[list.length - 1].hash : GENESIS),
    append(type, data = {}) {
      const e = { seq: list.length, at: clock(), type, data: plain(data), prev: list.length ? list[list.length - 1].hash : GENESIS };
      e.hash = hashOf(e);
      list.push(e);
      if (onAppend) onAppend(e);
      return e;
    },
  };
}
