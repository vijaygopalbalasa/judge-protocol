// The ERC-8404 profile (rvr/profiles/judge-protocol-rvr-v0) says its SPEC
// describes what the live judge does. This checks that claim: the judge's own
// ruling path (prepareRuling, on an in-memory chain) and the profile's
// independent Python adapter must derive the same rulings, keccak for keccak,
// and refuse the same criteria for the same reason. Criteria are written as raw
// text, so spellings JSON.stringify never produces (1.0, duplicate keys,
// __proto__, huge literals) reach both parsers.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { keccak256, toHex } from "viem";
import { mockChain } from "./helpers/mock-chain.js";

const { prepareRuling } = await import("../src/engine.js");

const PROFILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "rvr", "profiles", "judge-protocol-rvr-v0");
const noPython = spawnSync("python3", ["--version"]).status !== 0 && "python3 not available";
const GATE = "rvr.judge-protocol.v0.gate.";
const fenced = (text) => `Cross-check job.\n\`\`\`judge-criteria\n${text}\n\`\`\``;
const describe = (criteria) => fenced(JSON.stringify(criteria));

/** What the live judge does with this job: its ruling, or why it abstained. */
async function judge(description, content, jobId) {
  const { clients } = mockChain({ jobs: [{ id: jobId, description, content: "unused",
    uri: `data:application/octet-stream;base64,${content.toString("base64")}`, logDeliverable: keccak256(content) }] });
  const log = console.log;
  console.log = () => {};
  try {
    const r = await prepareRuling(BigInt(jobId), keccak256(content), clients, keccak256(toHex(`submit-${jobId}`)));
    if (r.outcome !== "ready") return { abstained: r.reason };
    return { criteriaHash: r.criteriaHash, checks: r.verdictObj.results.map((x) => ({ kind: x.kind, pass: !!x.pass })),
      score: r.score + 0, threshold: r.threshold + 0, pass: r.pass, evidenceHash: r.evidenceHash }; // + 0: the judge signs -0 as 0
  } finally {
    console.log = log;
  }
}

function adapter(requests) {
  const out = spawnSync("python3", [path.join(PROFILE, "adapter.py"), "--evaluate"], {
    input: JSON.stringify(requests), encoding: "utf8", maxBuffer: 64 << 20, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  if (out.status !== 0) throw new Error(out.stderr);
  return JSON.parse(out.stdout);
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/** SPEC 5.2 item 3: every number a safe integer, every string and key a scalar-value string. */
function inV0(value) {
  if (typeof value === "number") return Number.isSafeInteger(value);
  if (typeof value === "string") return !LONE_SURROGATE.test(value);
  if (Array.isArray(value)) return value.every(inV0);
  if (value && typeof value === "object") return Object.keys(value).every((k) => !LONE_SURROGATE.test(k) && inV0(value[k]));
  return true;
}
const blockText = (description) => description.match(/```judge-criteria\s*([\s\S]*?)```/)?.[1];

/** What the profile must answer, given what the judge did (SPEC 5.2, 5.3 and 6). */
function expectedFromJudge(js, description, content) {
  const text = blockText(description);
  let criteria;
  try { criteria = JSON.parse(text); } catch { criteria = undefined; }
  if (js.abstained?.startsWith("no judge-criteria block")) return { gate: GATE + (text === undefined ? "criteria_missing" : "criteria_invalid") };
  if (js.abstained?.startsWith("invalid criteria")) return { gate: GATE + (inV0(criteria) ? "criteria_invalid" : "criteria_out_of_scope") };
  if (js.abstained) throw new Error(`the judge abstained for another reason: ${js.abstained}`);
  if (!inV0(criteria)) return { gate: GATE + "criteria_out_of_scope" };
  const textChecks = criteria.checks.some((c) => c.kind !== "checksum");
  let utf8 = true;
  try { new TextDecoder("utf-8", { fatal: true }).decode(content); } catch { utf8 = false; }
  if (textChecks && !utf8) return { gate: GATE + "deliverable_not_utf8" };
  return js;
}

/** Run every case through both; returns counts of what happened, so a test can pin them exactly. */
async function compare(cases) {
  const requests = cases.map(({ description, content, jobId }) => ({ description, jobId, commitment: keccak256(content),
    deliverableBase64: content.toString("base64") }));
  const python = adapter(requests);
  const counts = { ruled: 0 };
  for (const [i, c] of cases.entries()) {
    const label = `${c.label}: ${c.description.slice(0, 160)} | ${JSON.stringify(c.content.toString("utf8").slice(0, 80))}`;
    let probe = false;
    try { probe = JSON.parse(blockText(c.description)).checks.some((k) => k?.kind === "http-endpoint"); } catch { /* not criteria */ }
    const wanted = probe ? { gate: GATE + "criteria_out_of_scope" } : expectedFromJudge(await judge(c.description, c.content, c.jobId), c.description, c.content);
    assert.deepEqual(python[i], wanted, label);
    const key = wanted.gate ? wanted.gate.slice(GATE.length) : "ruled";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

test("the judge and the profile's Python adapter derive the same ruling for every vector and seven real rulings", { skip: noPython }, async () => {
  const vectors = JSON.parse(fs.readFileSync(path.join(PROFILE, "vectors.json"), "utf8"));
  const cases = vectors.semanticCases.map((v) => ({ label: v.id, jobId: "900001", description: describe(v.criteria), content: Buffer.from(v.deliverable, "utf8") }));
  for (const job of ["186779", "186780"]) {
    const snap = JSON.parse(fs.readFileSync(path.join(PROFILE, "upstream", `job-${job}.snapshot.json`), "utf8"));
    const content = fs.readFileSync(path.join(PROFILE, "upstream", `job-${job}.deliverable.bin`));
    cases.push({ label: `job ${job}`, jobId: job, description: snap.job.description, content });
    const js = await judge(snap.job.description, content, job);
    assert.equal(js.evidenceHash, snap.verdict.evidenceHash, `the live judge's ruling path reproduces job ${job}'s on-chain evidenceHash`);
  }
  // Five earlier rulings whose deliverable is in the judge's stored evidence (a data: URI).
  const evidenceDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "evidence");
  let recorded = 0;
  for (const file of fs.readdirSync(evidenceDir)) {
    const ev = JSON.parse(fs.readFileSync(path.join(evidenceDir, file), "utf8"));
    const match = /^data:[^,]*;base64,(.*)$/.exec(ev.deliverableURI ?? "");
    if (!match) continue;
    const content = Buffer.from(match[1], "base64");
    const description = describe(ev.criteria);
    assert.equal((await judge(description, content, ev.jobId)).evidenceHash, ev.evidenceHash, `job ${ev.jobId} re-derives its recorded evidenceHash`);
    cases.push({ label: `recorded job ${ev.jobId}`, jobId: ev.jobId, description, content });
    recorded++;
  }
  assert.equal(recorded, 5);
  assert.deepEqual(await compare(cases), { ruled: cases.length });
});

test("and on 400 generated cases aimed at the places JavaScript and Python differ", { skip: noPython }, async () => {
  let seed = 8404;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const PIECES = ["word", "USDC", "USDCx", "_USDC", "USDC_", "café", "é", "ß", "Ⅻ", "²", "٣", "😀", "2026", " USDC ", "ERC-8183",
    " ", "  ", "\t", "\n", " ", " ", "　", "﻿", " ", "\u001c", "\u0085", "᠎", ",", ".", "-", "a", "Z",
    "\u{10940}", "\u{11F04}", "\u{10D4A}", "͸"];
  const TERMS = ["USDC", "café", "Ⅻ", "²", "e", "😀", "a b", "2026", "_", "word", "ERC-8183"];
  const text = () => Array.from({ length: 1 + Math.floor(rnd() * 12) }, () => pick(PIECES)).join("");
  const jsonText = () => {
    const values = ['"s"', "1", "1.5", "-0", "true", "null", "[1]", "{}", '"12"', "1" + "0".repeat(4400), "1e400"];
    const keys = ["a", "b", "n", "10", "9", "__proto__"];
    const body = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => `"${pick(keys)}":${pick(values)}`).join(",");
    return pick([`{${body}}`, `{${body}}`, `{${body}}`, `[${body}]`, "null", `{${body}`, `﻿{${body}}`]);
  };
  const num = () => pick(["1", "2", "5", "1.0", "1e0", "2.0", "1000", "7"]);
  const check = (kind, content) => {
    const weight = pick(["", "", "", `,"weight":${num()}`, `,"weight":${num()}`, ',"weight":1000', rnd() < 0.3 ? ',"weight":0.5' : ""]);
    if (kind === "length") return `{"kind":"length","params":{${rnd() < 0.5 ? '"unit":"chars",' : ""}"min":${Math.floor(rnd() * 4)},"max":${2 + Math.floor(rnd() * 14)}}${weight}}`;
    if (kind === "contains") {
      const terms = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => JSON.stringify(pick(TERMS))).join(",");
      return `{"kind":"contains","params":{"all":[${terms}]${rnd() < 0.6 ? ',"wholeWords":true' : ""}}${weight}}`;
    }
    if (kind === "schema") {
      const types = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => `"${pick(["a", "b", "n", "9", "10"])}":"${pick(["string", "number", "boolean", "object"])}"`).join(",");
      return `{"kind":"schema","params":{"required":["${pick(["a", "n", "10"])}"],"types":{${types}}}${weight}}`;
    }
    const digest = crypto.createHash("sha256").update(content).digest("hex");
    return `{"kind":"checksum","params":{"sha256":"${pick([digest, digest.toUpperCase(), "a".repeat(64)])}"}${weight}}`;
  };
  const cases = [];
  for (let i = 0; i < 400; i++) {
    const schemaCase = rnd() < 0.3;
    const content = rnd() < 0.08 ? Buffer.from([0x66, 0xff, 0xfe, 0x41]) : Buffer.from(schemaCase ? jsonText() : text(), "utf8");
    const kinds = schemaCase ? ["schema", pick(["length", "contains"])] : Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick(["length", "contains", "length", "checksum"]));
    const threshold = pick(["", "", ',"passThreshold":0', ',"passThreshold":50', ',"passThreshold":99', ',"passThreshold":100', ',"passThreshold":-0',
      ',"passThreshold":1e2', ',"passThreshold":50,"passThreshold":100', rnd() < 0.3 ? ',"passThreshold":1.5' : ""]);
    const extra = pick(["", "", "", "", ',"note":"x"', ',"__proto__":{"x":1}', rnd() < 0.3 ? ',"big":' + "9".repeat(20) : "", ',"n":1.0']);
    const body = `{"version":1${threshold}${extra},"checks":[${kinds.map((k) => check(k, content)).join(",")}]}`;
    const description = rnd() < 0.03 ? "No criteria block here." : rnd() < 0.03 ? fenced(body.slice(0, -3)) : fenced(body);
    cases.push({ label: `generated ${i}`, jobId: String(700000 + i), description, content });
  }
  // Pinned for this seed: a change to the generator or to either side shows up here.
  assert.deepEqual(await compare(cases), GENERATED_COUNTS);
});

const GENERATED_COUNTS = { ruled: 236, criteria_invalid: 64, criteria_missing: 18, criteria_out_of_scope: 60, deliverable_not_utf8: 22 };

test("criteria the judge refuses are refused by the profile, for the matching reason", { skip: noPython }, async () => {
  const content = Buffer.from("some deliverable text");
  const cases = [
    { label: "unknown field", description: describe({ version: 1, checks: [{ kind: "length", param: { min: 1 } }] }) },
    { label: "zero weight", description: describe({ version: 1, checks: [{ kind: "length", params: { min: 1 }, weight: 0 }] }) },
    { label: "no block", description: "No criteria here." },
    { label: "not JSON", description: fenced("{checks:") },
    { label: "__proto__ member", description: fenced('{"__proto__":{"x":1},"checks":[{"kind":"length"}]}') },
    { label: "weight out of range and out of v0", description: fenced('{"checks":[{"kind":"length","weight":1e400}]}') },
    { label: "probe", description: describe({ version: 1, checks: [{ kind: "http-endpoint", params: { url: "https://example.com" } }] }) },
  ].map((c) => ({ ...c, jobId: "900002", content }));
  assert.deepEqual(await compare(cases), { ruled: 0, criteria_invalid: 4, criteria_missing: 1, criteria_out_of_scope: 2 });
});

test("whole-word boundaries follow the pinned Unicode 17.0.0 table on every runtime", { skip: noPython }, async () => {
  // Each side used to ask its own runtime whether a neighbour is a letter or digit, so a
  // character newer than one runtime's Unicode tables split the verdict. [text, passes]
  const cases = [
    ["pay \u{10940}USDC now", false], // Sidetic letter, new in Unicode 17.0
    ["Paid in USDC\u{11F04}", false], // Kawi letter, in Unicode 15.0 and later
    ["Paid in USDC\u{10D4A}", false], // Garay letter, new in Unicode 16.0
    ["Paid in USDC\u{E0001} today", true], // a format character, never a word character
    ["Paid in USDC\u{0378}", true], // unassigned, so not a word character
  ];
  const description = describe({ version: 1, checks: [{ kind: "contains", params: { all: ["USDC"], wholeWords: true } }] });
  const counts = await compare(cases.map(([t], i) => ({ label: `unicode ${i}`, jobId: "900003", description, content: Buffer.from(t, "utf8") })));
  assert.deepEqual(counts, { ruled: cases.length });
  for (const [t, passes] of cases) assert.equal((await judge(description, Buffer.from(t, "utf8"), "900003")).pass, passes, JSON.stringify(t));
});
