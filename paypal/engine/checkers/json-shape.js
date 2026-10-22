// The json check's shape language (docs/CRITERIA.md, "json"): a small subset of JSON Schema, pinned so that
// any implementation gives the same answer. No regular expression comes from the criteria, no platform URL or
// email parser is used, and lengths count Unicode code points. This file is copied byte for byte to
// web/json-shape.js, and a test keeps the two identical.

export const SHAPE_LIMITS = { nodes: 128, anyOf: 4, shown: 5, shownChars: 40, terms: 256, termChars: 1024, urlChars: 2048, emailChars: 254 };

const TYPES = ["object", "array", "string", "number", "integer", "boolean", "null"];
// Each keyword applies to one type, and a shape that uses it must declare that type.
const NEEDS = { required: "object", properties: "object", additionalProperties: "object", items: "array", minItems: "array",
  maxItems: "array", uniqueBy: "array", minLength: "string", maxLength: "string", format: "string", minimum: "number", maximum: "number" };
const FORMATS = ["url", "email"];
/** Every keyword a shape may use (docs/CRITERIA.md documents each one; a test holds them together). */
export const SHAPE_KEYWORDS = ["type", "enum", "anyOf", ...Object.keys(NEEDS)];

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isCount = (v) => Number.isInteger(v) && v >= 0;
const isScalar = (v) => v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
// JSON.parse turns a literal too large for a double (1e400) into Infinity, which is not a number here.
const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array"
  : typeof v === "number" && !Number.isFinite(v) ? "non-finite number" : typeof v);

/** A value for a message: JSON, cut to a few characters (whole code points), since it may come from the deliverable. */
function show(v) {
  const s = [...JSON.stringify(v)];
  return s.length > SHAPE_LIMITS.shownChars ? s.slice(0, SHAPE_LIMITS.shownChars).join("") + "..." : s.join("");
}
const step = (k) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? `.${k}` : `[${show(k)}]`);

/** What is wrong with a shape, or null. The criteria gate calls this before any deliverable is read. */
export function shapeProblem(shape) {
  if (!isObject(shape)) return "shape must be an object";
  let nodes = 0;
  const visit = (node, at, inAnyOf) => {
    if (++nodes > SHAPE_LIMITS.nodes) return `shape: at most ${SHAPE_LIMITS.nodes} shapes in all`;
    if (!isObject(node)) return `${at} must be an object`;
    for (const k of Object.keys(node)) {
      if (k !== "type" && k !== "enum" && k !== "anyOf" && !Object.hasOwn(NEEDS, k)) return `${at}: unknown keyword ${show(k)}`;
    }
    if (Object.hasOwn(node, "anyOf")) {
      if (Object.keys(node).length !== 1) return `${at}: anyOf stands alone (no other keyword beside it)`;
      if (inAnyOf) return `${at}: anyOf directly inside anyOf`;
      const alts = node.anyOf;
      if (!Array.isArray(alts) || alts.length < 2 || alts.length > SHAPE_LIMITS.anyOf) return `${at}: anyOf needs 2 to ${SHAPE_LIMITS.anyOf} shapes`;
      for (let i = 0; i < alts.length; i++) {
        const p = visit(alts[i], `${at}.anyOf[${i}]`, true);
        if (p) return p;
      }
      return null;
    }
    const type = node.type;
    if (Object.hasOwn(node, "type") && !TYPES.includes(type)) return `${at}: type must be one of ${TYPES.join(", ")}`;
    if (Object.hasOwn(node, "enum")) {
      const e = node.enum;
      if (!Array.isArray(e) || e.length < 1 || e.length > SHAPE_LIMITS.terms
        || !e.every((x) => isScalar(x) && (typeof x !== "string" || x.length <= SHAPE_LIMITS.termChars))) {
        return `${at}: enum must be a list of 1 to ${SHAPE_LIMITS.terms} strings, numbers, booleans or nulls (strings up to ${SHAPE_LIMITS.termChars} characters)`;
      }
    }
    for (const [k, want] of Object.entries(NEEDS)) {
      if (!Object.hasOwn(node, k)) continue;
      if (want === "number" ? type !== "number" && type !== "integer" : type !== want) {
        return `${at}: ${k} needs "type": "${want}"${want === "number" ? ' or "integer"' : ""}`;
      }
    }
    for (const k of ["minItems", "maxItems", "minLength", "maxLength"]) {
      if (Object.hasOwn(node, k) && !isCount(node[k])) return `${at}: ${k} must be a whole number >= 0`;
    }
    for (const k of ["minimum", "maximum"]) {
      if (Object.hasOwn(node, k) && !(typeof node[k] === "number" && Number.isFinite(node[k]))) return `${at}: ${k} must be a number`;
    }
    for (const [lo, hi] of [["minItems", "maxItems"], ["minLength", "maxLength"], ["minimum", "maximum"]]) {
      if (Object.hasOwn(node, lo) && Object.hasOwn(node, hi) && node[lo] > node[hi]) return `${at}: ${lo} must not be above ${hi}`;
    }
    if (Object.hasOwn(node, "format") && !FORMATS.includes(node.format)) return `${at}: format must be "url" or "email"`;
    if (Object.hasOwn(node, "additionalProperties") && typeof node.additionalProperties !== "boolean") {
      return `${at}: additionalProperties must be true or false`;
    }
    if (Object.hasOwn(node, "required")) {
      const r = node.required;
      if (!Array.isArray(r) || r.length > SHAPE_LIMITS.terms || !r.every((f) => typeof f === "string" && f.length <= SHAPE_LIMITS.termChars)) {
        return `${at}: required must be a list of up to ${SHAPE_LIMITS.terms} field names, each up to ${SHAPE_LIMITS.termChars} characters`;
      }
    }
    if (Object.hasOwn(node, "uniqueBy")) {
      const u = node.uniqueBy;
      if (!isObject(u) || Object.keys(u).length !== 2 || typeof u.field !== "string" || u.field.length < 1
        || u.field.length > SHAPE_LIMITS.termChars || (u.key !== "value" && u.key !== "domain")) {
        return `${at}: uniqueBy must be { field, key } with a field name and key "value" or "domain"`;
      }
    }
    if (Object.hasOwn(node, "properties")) {
      const props = node.properties;
      if (!isObject(props)) return `${at}: properties must be an object of field: shape`;
      const names = Object.keys(props);
      if (names.length > SHAPE_LIMITS.terms || names.some((f) => f.length > SHAPE_LIMITS.termChars)) {
        return `${at}: properties may name up to ${SHAPE_LIMITS.terms} fields, each up to ${SHAPE_LIMITS.termChars} characters`;
      }
      for (const f of names) {
        const p = visit(props[f], `${at}.properties${step(f)}`, false);
        if (p) return p;
      }
    }
    if (Object.hasOwn(node, "items")) return visit(node.items, `${at}.items`, false);
    return null;
  };
  return visit(shape, "shape", false);
}

function isType(v, t) {
  if (t === "integer") return typeof v === "number" && Number.isInteger(v);
  return typeOf(v) === t;
}

function fail(out, path, message) {
  out.count++;
  if (out.shown && out.shown.length < SHAPE_LIMITS.shown) out.shown.push(`${path}: ${message}`);
}

const described = (v) => (isScalar(v) ? show(v) : `${typeOf(v) === "array" || typeOf(v) === "object" ? "an" : "a"} ${typeOf(v)}`);

function walk(v, node, path, out) {
  if (out.count >= out.stop) return;
  if (Object.hasOwn(node, "anyOf")) {
    const ok = node.anyOf.some((alt) => {
      const probe = { count: 0, stop: 1, shown: null };
      walk(v, alt, path, probe);
      return probe.count === 0;
    });
    if (!ok) fail(out, path, `matches none of the ${node.anyOf.length} allowed shapes`);
    return;
  }
  if (Object.hasOwn(node, "type") && !isType(v, node.type)) {
    fail(out, path, `expected ${node.type}, got ${typeOf(v)}`);
    return;
  }
  if (Object.hasOwn(node, "enum") && !node.enum.some((e) => e === v)) {
    fail(out, path, `${described(v)} is not one of ${node.enum.slice(0, 5).map(show).join(", ")}${node.enum.length > 5 ? ", ..." : ""}`);
  }
  switch (node.type) {
    case "string": {
      const n = [...v].length;
      if (Object.hasOwn(node, "minLength") && n < node.minLength) fail(out, path, `${n} characters, need at least ${node.minLength}`);
      if (Object.hasOwn(node, "maxLength") && n > node.maxLength) fail(out, path, `${n} characters, need at most ${node.maxLength}`);
      if (node.format === "url" && !isUrl(v)) fail(out, path, "not a URL (http or https, with a domain)");
      if (node.format === "email" && !isEmail(v)) fail(out, path, "not an email address");
      return;
    }
    case "number":
    case "integer":
      if (Object.hasOwn(node, "minimum") && v < node.minimum) fail(out, path, `${show(v)} is below the minimum ${node.minimum}`);
      if (Object.hasOwn(node, "maximum") && v > node.maximum) fail(out, path, `${show(v)} is above the maximum ${node.maximum}`);
      return;
    case "object": {
      const props = node.properties ?? {};
      for (const f of node.required ?? []) if (!Object.hasOwn(v, f)) fail(out, path, `missing ${show(f)}`);
      if (node.additionalProperties === false) {
        for (const k of Object.keys(v)) if (!Object.hasOwn(props, k)) fail(out, path, `unexpected field ${show(k)}`);
      }
      for (const f of Object.keys(props)) if (Object.hasOwn(v, f)) walk(v[f], props[f], path + step(f), out);
      return;
    }
    case "array": {
      const s = v.length === 1 ? "" : "s";
      if (Object.hasOwn(node, "minItems") && v.length < node.minItems) fail(out, path, `${v.length} item${s}, need at least ${node.minItems}`);
      if (Object.hasOwn(node, "maxItems") && v.length > node.maxItems) fail(out, path, `${v.length} item${s}, need at most ${node.maxItems}`);
      if (Object.hasOwn(node, "items")) for (let i = 0; i < v.length && out.count < out.stop; i++) walk(v[i], node.items, `${path}[${i}]`, out);
      if (Object.hasOwn(node, "uniqueBy")) unique(v, node.uniqueBy, path, out);
      return;
    }
    default:
  }
}

/** No two items may share a key. Items whose field is missing, null, an object or a list (or, for "domain", not a URL)
 *  are not compared: the shape's other rules decide whether those are allowed. */
function unique(items, { field, key }, path, out) {
  const seen = new Map();
  for (let i = 0; i < items.length && out.count < out.stop; i++) {
    const item = items[i];
    if (!isObject(item) || !Object.hasOwn(item, field)) continue;
    const raw = item[field];
    let k;
    if (key === "domain") {
      if (!isUrl(raw)) continue;
      k = domainOf(raw);
    } else {
      if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") continue;
      k = `${typeof raw}:${String(raw)}`;
    }
    if (seen.has(k)) fail(out, `${path}[${i}]${step(field)}`, `same ${key} as ${path}[${seen.get(k)}]${key === "domain" ? ` (${k})` : ""}`);
    else seen.set(k, i);
  }
}

/** Every way `value` breaks `shape`: how many, and the first few found as "path: problem" (an array's own bounds,
 *  then each item in turn, then its uniqueBy rule). */
export function shapeViolations(value, shape) {
  const out = { count: 0, stop: Infinity, shown: [] };
  if (shape) walk(value, shape, "$", out);
  return out;
}

// A host: two or more dot-separated labels of ASCII letters, digits and inner hyphens, 1 to 63 characters
// each, at most 253 in all, and a last label that is not all digits (so no IP addresses and no localhost).
const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
function isHost(h) {
  if (h.length > 253) return false;
  const labels = h.split(".");
  return labels.length >= 2 && labels.every((l) => LABEL.test(l)) && !/^[0-9]+$/.test(labels[labels.length - 1]);
}

/** A URL: http:// or https:// (any case), a host, an optional port of 1 to 5 digits, then optionally a path, query
 *  or fragment of printable ASCII with no spaces. No user name, no IP address, at most 2048 characters. */
export function isUrl(s) {
  if (typeof s !== "string" || s.length > SHAPE_LIMITS.urlChars) return false;
  const scheme = /^https?:\/\//i.exec(s);
  if (!scheme) return false;
  const tail = s.slice(scheme[0].length);
  const end = tail.search(/[/?#]/);
  const authority = end === -1 ? tail : tail.slice(0, end);
  const rest = end === -1 ? "" : tail.slice(end);
  const colon = authority.indexOf(":");
  if (colon !== -1 && !/^[0-9]{1,5}$/.test(authority.slice(colon + 1))) return false;
  return isHost(colon === -1 ? authority : authority.slice(0, colon)) && /^[\x21-\x7E]*$/.test(rest);
}

const ATEXT = /^[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+$/;
/** An email address: exactly one @, a local part of up to 64 characters made of dot-separated runs of letters,
 *  digits and !#$%&'*+/=?^_`{|}~- (no leading, trailing or double dot), and a host as for URLs. No "mailto:". */
export function isEmail(s) {
  if (typeof s !== "string" || s.length > SHAPE_LIMITS.emailChars) return false;
  const at = s.indexOf("@");
  if (at < 1 || at !== s.lastIndexOf("@")) return false;
  const local = s.slice(0, at);
  return local.length <= 64 && local.split(".").every((part) => ATEXT.test(part)) && isHost(s.slice(at + 1));
}

/** The domain two URLs are compared by: the host, lowercased, with one leading "www." removed when more remains
 *  than a single label. Subdomains stay distinct: there is no public-suffix list, since that list changes. */
export function domainOf(url) {
  const tail = url.slice(url.indexOf("//") + 2);
  const end = tail.search(/[/?#:]/);
  const host = (end === -1 ? tail : tail.slice(0, end)).toLowerCase();
  return host.startsWith("www.") && host.split(".").length > 2 ? host.slice(4) : host;
}
