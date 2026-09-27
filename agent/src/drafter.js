// Plain-English acceptance text -> Judge Protocol criteria, deterministically.
//
// Every sentence must become a check, or the milestone goes to a human. The
// drafter never guesses: an ambiguous term, an "A or B" list, conflicting
// bounds or a subjective ask ("make it look great") is reported by sentence,
// never dropped or approximated, because criteria decide where escrow goes.
import { validateCriteria } from "../../kit/judge-kit.js";

const SUBJECT = "(?:(?:it|this|the (?:text|answer|deliverable|document|summary|post|response|article|report|output))\\s+(?:must|should|has to|needs to)\\s+be\\s+)?";
const UNIT = "(words?|characters?|chars?)";
const LONG = "(?:\\s+long)?";
const TYPE_NAMES = ["string", "number", "boolean", "object"];

export function splitSentences(text) {
  return String(text || "")
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((s) => s.trim().replace(/[.!?;]+$/, "").trim())
    .filter(Boolean);
}

/** "A, B and C" or '"two words", C' -> terms; null if any term is ambiguous (unquoted with spaces) or the list says "or". */
export function parseTerms(list) {
  const out = [];
  let rest = String(list || "").trim();
  if (!rest) return null;
  const item = /^(?:"([^"]+)"|'([^']+)'|`([^`]+)`|([^\s,"'`&]+))/;
  const sep = /^(?:\s*,\s*(?:and\s+)?|\s+and\s+|\s*&\s*)/i;
  while (rest.length) {
    const m = rest.match(item);
    if (!m) return null;
    out.push(m[1] ?? m[2] ?? m[3] ?? m[4]);
    rest = rest.slice(m[0].length);
    if (!rest.length) break;
    const s = rest.match(sep);
    if (!s) return null; // e.g. "the thing" or "A or B": not a plain all-of list
    rest = rest.slice(s[0].length);
    if (!rest.length) return null;
  }
  return out;
}

const unitOf = (u) => (/^char/i.test(u) ? "chars" : "words");

/** One sentence -> a partial draft ({ length } | { terms } | { schema } | { checksum } | { probe }), or null if it cannot be checked. */
function readSentence(s) {
  let m;
  const n = (x) => Number.parseInt(x, 10);
  if ((m = s.match(new RegExp(`^${SUBJECT}(?:between|from)\\s+(\\d{1,6})\\s+(?:and|to)\\s+(\\d{1,6})\\s+${UNIT}${LONG}$`, "i")))) {
    return { length: { unit: unitOf(m[3]), min: n(m[1]), max: n(m[2]) } };
  }
  if ((m = s.match(new RegExp(`^${SUBJECT}(\\d{1,6})\\s*(?:-|to)\\s*(\\d{1,6})\\s+${UNIT}${LONG}$`, "i")))) {
    return { length: { unit: unitOf(m[3]), min: n(m[1]), max: n(m[2]) } };
  }
  if ((m = s.match(new RegExp(`^${SUBJECT}exactly\\s+(\\d{1,6})\\s+${UNIT}${LONG}$`, "i")))) {
    return { length: { unit: unitOf(m[2]), min: n(m[1]), max: n(m[1]) } };
  }
  if ((m = s.match(new RegExp(`^${SUBJECT}(at least|a minimum of|no fewer than|not less than|more than)\\s+(\\d{1,6})\\s+${UNIT}${LONG}$`, "i")))) {
    const v = n(m[2]);
    return { length: { unit: unitOf(m[3]), min: /more than/i.test(m[1]) ? v + 1 : v } };
  }
  if ((m = s.match(new RegExp(`^${SUBJECT}(at most|a maximum of|no more than|not more than|up to|under|fewer than|less than|shorter than)\\s+(\\d{1,6})\\s+${UNIT}${LONG}$`, "i")))) {
    const v = n(m[2]);
    return { length: { unit: unitOf(m[3]), max: /under|fewer|less|shorter/i.test(m[1]) ? v - 1 : v } };
  }
  if ((m = s.match(/^(?:(?:it|the (?:text|answer|deliverable|document|summary|post|response|article|report|output))\s+)?(?:must|should|has to|needs to)\s+(?:mention|include|contain|reference|name|use)(?:\s+the\s+(?:terms?|words?|phrases?))?\s+(.+)$/i))
    || (m = s.match(/^(?:mention|include|use)(?:\s+the\s+(?:terms?|words?|phrases?))?\s+(.+)$/i))) {
    const terms = parseTerms(m[1]);
    return terms ? { terms } : null;
  }
  if ((m = s.match(/^(?:(?:it|the (?:deliverable|output|response|answer))\s+(?:must|should)\s+be\s+)?(?:an?\s+)?(?:valid\s+)?json(?:\s+object)?(?:\s+with\s+(?:the\s+)?(?:fields|keys|properties)\s+(.+))?$/i))) {
    if (m[1] === undefined) return { schema: { required: [], types: {} } };
    const fields = parseTerms(m[1]);
    return fields ? { schema: { required: fields, types: {} } } : null;
  }
  if ((m = s.match(/^(?:the\s+)?(?:field\s+|key\s+)?["'`]?([A-Za-z_][\w-]*)["'`]?\s+(?:must|should)\s+be\s+(?:an?\s+)?(string|number|boolean|object)$/i))) {
    return { schema: { required: [m[1]], types: { [m[1]]: m[2].toLowerCase() } } }; // a typed field must also be present
  }
  if ((m = s.match(/^(?:the\s+)?(?:(?:file|deliverable)(?:'s)?\s+)?sha-?256(?:\s+(?:hash|digest))?(?:\s+of\s+the\s+(?:file|deliverable))?(?:\s+must)?(?:\s+(?:be|equal|equals|is)|\s*:)?\s+([0-9a-f]{64})$/i))) {
    return { checksum: m[1].toLowerCase() };
  }
  if ((m = s.match(/^(https?:\/\/\S+)\s+(?:must\s+)?(?:return|returns|respond with|responds with|answer with|answers with)\s+(?:(?:http\s+)?status\s+)?(\d{3})(?:\s+and\s+(?:contain|include|mention)\s+(.+))?$/i))) {
    const probe = { url: m[1], expectStatus: n(m[2]) };
    if (m[3] !== undefined) {
      const body = parseTerms(m[3]);
      if (!body) return null;
      probe.bodyIncludes = body;
    }
    return { probe };
  }
  return null;
}

/**
 * Draft criteria from acceptance text.
 * @returns {{ complete: boolean, criteria: object|null, uncovered: string[], reason?: string }}
 */
export function draftCriteria(text) {
  const sentences = splitSentences(text);
  const refuse = (reason, uncovered = []) => ({ complete: false, criteria: null, uncovered, reason });
  if (!sentences.length) return refuse("the acceptance text is empty");

  const length = {}; // unit -> { min, max }
  const terms = [];
  let schema = null, checksum = null;
  const probes = [];
  const uncovered = [];
  for (const s of sentences) {
    const r = readSentence(s);
    if (!r) { uncovered.push(s); continue; }
    if (r.length) {
      const cur = (length[r.length.unit] ??= {});
      if (r.length.min !== undefined) cur.min = Math.max(cur.min ?? 0, r.length.min);
      if (r.length.max !== undefined) cur.max = Math.min(cur.max ?? Infinity, r.length.max);
    }
    if (r.terms) for (const t of r.terms) if (!terms.includes(t)) terms.push(t);
    if (r.schema) {
      schema ??= { required: [], types: {} };
      for (const f of r.schema.required) if (!schema.required.includes(f)) schema.required.push(f);
      for (const [f, t] of Object.entries(r.schema.types)) {
        if (schema.types[f] && schema.types[f] !== t) return refuse(`conflict: ${f} must be both ${schema.types[f]} and ${t}`);
        schema.types[f] = t;
      }
    }
    if (r.checksum) {
      if (checksum && checksum !== r.checksum) return refuse("conflict: two different SHA-256 digests");
      checksum = r.checksum;
    }
    if (r.probe) probes.push(r.probe);
  }
  if (uncovered.length) return refuse("some sentences cannot be checked by a deterministic judge; rephrase them or move them to notes", uncovered);

  const checks = [];
  for (const unit of ["words", "chars"]) {
    const b = length[unit];
    if (!b) continue;
    if (b.min !== undefined && b.max !== undefined && b.min > b.max) return refuse(`conflict: ${unit} min ${b.min} is above max ${b.max}`);
    const params = {};
    if (b.min !== undefined) params.min = b.min;
    if (b.max !== undefined && b.max !== Infinity) params.max = b.max;
    if (unit === "chars") params.unit = "chars";
    checks.push({ kind: "length", params });
  }
  if (terms.length) checks.push({ kind: "contains", params: { all: terms, wholeWords: true } }); // "Arc" must not match "Architecture"
  if (schema) {
    const params = { required: schema.required };
    if (Object.keys(schema.types).length) params.types = schema.types;
    for (const t of Object.values(schema.types)) if (!TYPE_NAMES.includes(t)) return refuse(`unknown type ${t}`);
    checks.push({ kind: "schema", params });
  }
  if (checksum) checks.push({ kind: "checksum", params: { sha256: checksum } });
  for (const p of probes) checks.push({ kind: "http-endpoint", params: p });

  const criteria = { version: 1, checks };
  const v = validateCriteria(criteria);
  if (!v.valid) return refuse(`the drafted criteria would be refused by the judge: ${v.reason}`);
  return { complete: true, criteria, uncovered: [] };
}
