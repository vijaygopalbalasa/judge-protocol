// Plain-language views of checks, results and events, so a buyer reads the terms instead of JSON. Pure functions,
// shared by the pages and the tests. The JSON stays available next to these as the exact agreed record.

const num = (n) => (typeof n === "number" ? n.toLocaleString("en-US") : String(n));
const show = (v) => (typeof v === "string" ? `"${v}"` : num(v));
const joinAnd = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

function range(min, max, unit) {
  if (min !== undefined && max !== undefined) return min === max ? `exactly ${num(min)} ${unit}` : `${num(min)} to ${num(max)} ${unit}`;
  if (min !== undefined) return `at least ${num(min)} ${unit}`;
  if (max !== undefined) return `at most ${num(max)} ${unit}`;
  return "";
}

function describeShape(name, s = {}) {
  if (Array.isArray(s.enum)) {
    return s.enum.length === 1 ? `${name} is exactly ${show(s.enum[0])}` : `${name} is one of ${s.enum.map(show).join(", ")}`;
  }
  if (Array.isArray(s.anyOf)) return `${name} matches one of ${s.anyOf.length} allowed forms`;
  const type = Array.isArray(s.type) ? s.type.join(" or ") : s.type;
  if (type === "array") {
    const count = range(s.minItems, s.maxItems, "");
    let out = `${name} is a list${count ? ` of ${count.trim()}` : ""}${s.uniqueItems ? (count ? " different items" : " of different items") : count ? " items" : ""}`;
    if (s.items?.enum) out += `, each one of ${s.items.enum.map((v) => (typeof v === "string" ? v : num(v))).join(", ")}`;
    else if (s.items?.type) out += `, each ${s.items.type === "object" ? "an object" : `a ${s.items.type}`}`;
    return out;
  }
  if (type === "string") {
    const len = range(s.minLength, s.maxLength, "characters");
    const fmt = s.format === "email" ? "an email address" : s.format === "url" ? "a web address" : "text";
    return `${name} is ${fmt}${len ? ` of ${len}` : ""}`;
  }
  if (type === "number" || type === "integer") {
    const what = type === "integer" ? "a whole number" : "a number";
    if (s.minimum !== undefined && s.minimum === s.maximum) return `${name} is exactly ${num(s.minimum)}`;
    if (s.minimum !== undefined && s.maximum !== undefined) return `${name} is ${what} from ${num(s.minimum)} to ${num(s.maximum)}`;
    if (s.minimum !== undefined) return `${name} is ${what} of at least ${num(s.minimum)}`;
    if (s.maximum !== undefined) return `${name} is ${what} of at most ${num(s.maximum)}`;
    return `${name} is ${what}`;
  }
  if (type === "boolean") return `${name} is true or false`;
  if (type === "object") return `${name} is an object`;
  return type ? `${name} is ${type}` : `${name} is present`;
}

export function describeCheck(check) {
  const p = check?.params ?? {};
  switch (check?.kind) {
    case "json": {
      const s = p.shape ?? {};
      const lines = [];
      if (Array.isArray(s.required) && s.required.length) {
        lines.push(`It has ${s.additionalProperties === false ? "exactly these fields" : "the fields"}: ${s.required.join(", ")}`);
      }
      for (const [name, shape] of Object.entries(s.properties ?? {})) lines.push(describeShape(name, shape));
      const title = s.type === "array" ? "The answer is a JSON list" : s.type === "object" || !s.type ? "The answer is a JSON object" : `The answer is JSON (${s.type})`;
      if (s.type === "array") lines.unshift(describeShape("The list", s).replace(/^The list is a list/, "It is a list"));
      return { title, lines };
    }
    case "contains":
      return { title: `Mentions ${joinAnd(p.all ?? [])}${p.wholeWords ? " (as whole words)" : ""}`, lines: [] };
    case "length": {
      const unit = p.unit === "chars" ? "characters" : "words";
      const r = range(p.min, p.max, unit);
      const title = p.min !== undefined && p.max !== undefined ? `Between ${num(p.min)} and ${num(p.max)} ${unit} long` : r ? `${r[0].toUpperCase()}${r.slice(1)} long` : `Any length`;
      return { title, lines: [] };
    }
    case "schema":
      return { title: `JSON with the fields ${(p.required ?? []).join(", ")}`, lines: Object.entries(p.types ?? {}).map(([k, t]) => `${k} is ${t}`) };
    case "checksum":
      return { title: `The file is exactly the agreed one (SHA-256 ${String(p.sha256).slice(0, 12)}...)`, lines: [] };
    case "http-endpoint":
      return { title: `${p.url} answers${p.expectStatus ? ` with status ${p.expectStatus}` : ""}`, lines: (p.bodyIncludes ?? []).map((t) => `Its page includes "${t}"`) };
    default:
      return { title: `${check?.kind ?? "unknown"} check`, lines: [] };
  }
}

const KIND_LABEL = { json: "JSON rules", contains: "Required mentions", length: "Length", schema: "Fields", checksum: "Exact file", "http-endpoint": "Live address" };
const PASS_TEXT = { json: "every rule met", schema: "every field present" };
export function describeResult(result) {
  const detail = result.pass && PASS_TEXT[result.kind] && /^(json|schema) ok$/.test(String(result.detail)) ? PASS_TEXT[result.kind] : result.detail;
  return { pass: Boolean(result.pass), text: `${KIND_LABEL[result.kind] ?? result.kind}: ${detail}` };
}

const EVENT_LABEL = {
  posted: "Job created; checks pinned", "order-created": "PayPal order created", funded: "PayPal hold authorized",
  judged: "Delivery judged", captured: "Payment captured", "payout-sent": "Payout sent to the worker", paid: "Worker paid",
  refunded: "Hold voided; the buyer is not charged", expired: "Deadline passed; hold voided", failed: "Needs attention",
  "payout-review": "Payout needs review", "payout-reconciled": "Payout reconciled", "payout-check": "Payout status checked",
  "settle-retry": "Settlement will retry", "payout-retry": "Payout will retry", "expire-retry": "Void will retry",
};
export function describeEvent(event) {
  const label = EVENT_LABEL[event.type] ?? event.type;
  const detail = event.type === "posted" ? String(event.detail ?? "").replace(/^checks pinned:\s*/, "") : event.detail;
  return detail ? `${label} (${detail})` : label;
}
