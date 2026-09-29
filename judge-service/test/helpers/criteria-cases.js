// One list of acceptance-criteria cases shared by the judge's tests, the kit's
// parity tests and the verifier's parity tests, so all three validators are
// held to exactly the same answers. Each case: [label, criteria, valid].
// Invalid means the judge abstains: no score, no verdict, no escrow movement.

const HEX64 = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const one = (kind, params) => ({ checks: [params === undefined ? { kind } : { kind, params }] });
const many = (n, check) => ({ checks: Array.from({ length: n }, () => ({ ...check })) });

/** Nest `levels` objects under a free-form field (the root counts as level 1). */
function nestedExtra(levels) {
  let v = 1;
  for (let i = 0; i < levels - 1; i++) v = { a: v };
  return { meta: v, checks: [{ kind: "length" }] };
}
/** A very deep value built from text, the way it would arrive in a job description. */
export const DEEP_TEXT = `{"checks":[{"kind":"length","params":{"x":${'{"a":'.repeat(5000)}1${"}".repeat(5000)}}}]}`;

export const CRITERIA_CASES = [
  // --- valid ---
  ["length with min and max", one("length", { min: 1, max: 10 }), true],
  ["length in chars", one("length", { min: 0, unit: "chars" }), true],
  ["length in words, explicit", one("length", { max: 400, unit: "words" }), true],
  ["length with fractional bounds", one("length", { min: 1.5, max: 2.5 }), true],
  ["length with no params", one("length"), true],
  ["length with null params", one("length", null), true],
  ["length with null bounds (treated as absent)", one("length", { min: null, max: null, unit: null }), true],
  ["contains with an empty list", one("contains", { all: [] }), true],
  ["contains with terms", one("contains", { all: ["ERC-8183", "USDC"] }), true],
  ["contains with a 1024-char term", one("contains", { all: ["x".repeat(1024)] }), true],
  ["contains with whole words", one("contains", { all: ["Arc", "ERC-8183"], wholeWords: true }), true],
  ["contains with whole words off", one("contains", { all: ["Arc"], wholeWords: false }), true],
  ["contains with 256 terms", one("contains", { all: Array.from({ length: 256 }, (_, i) => `t${i}`) }), true],
  ["schema with required and all four types", one("schema", { required: ["a"], types: { a: "string", b: "number", c: "boolean", d: "object" } }), true],
  ["schema with no params", one("schema"), true],
  ["checksum lower-case hex", one("checksum", { sha256: HEX64 }), true],
  ["checksum upper-case hex", one("checksum", { sha256: HEX64.toUpperCase() }), true],
  ["http-endpoint with every param", one("http-endpoint", { url: "https://example.com/x", expectStatus: 200, bodyIncludes: ["ok"], timeoutMs: 5000 }), true],
  ["http-endpoint with no params (probes the deliverable URL)", one("http-endpoint"), true],
  ["four http-endpoint probes", many(4, { kind: "http-endpoint" }), true],
  ["64 checks", many(64, { kind: "length" }), true],
  ["free-form version and jobType", { version: "1.0.2", jobType: "doc", checks: [{ kind: "length" }] }, true],
  ["weighted checks", { passThreshold: 67, checks: [{ kind: "length", weight: 2.5 }, { kind: "contains", params: { all: [] } }] }, true],
  ["free-form metadata nested 12 levels", nestedExtra(12), true],
  ["passThreshold 0 with an always-passing check", { passThreshold: 0, checks: [{ kind: "contains", params: { all: [] } }] }, true],

  // --- invalid: structure (unchanged rules) ---
  ["null", null, false],
  ["empty object", {}, false],
  ["empty checks", { checks: [] }, false],
  ["checks not an array", { checks: "x" }, false],
  ["a null check", { checks: [null] }, false],
  ["an unknown kind", one("code-test"), false],
  ["weight 0", { checks: [{ kind: "length", weight: 0 }] }, false],
  ["weight negative", { checks: [{ kind: "length", weight: -1 }] }, false],
  ["weight as a string", { checks: [{ kind: "length", weight: "2" }] }, false],
  ["passThreshold 101", { passThreshold: 101, checks: [{ kind: "length" }] }, false],
  ["passThreshold -1", { passThreshold: -1, checks: [{ kind: "length" }] }, false],
  ["passThreshold fractional", { passThreshold: 99.5, checks: [{ kind: "length" }] }, false],

  ["weight at the cap (1000)", { checks: [{ kind: "length", weight: 1000 }] }, true],

  // --- invalid: unknown param names (a misspelling would otherwise pass vacuously) ---
  ["contains with a misspelled list (terms)", one("contains", { terms: ["USDC"] }), false],
  ["length with a misspelled bound (minimum)", one("length", { minimum: 500 }), false],
  ["schema with a misspelled key (require)", one("schema", { require: ["id"] }), false],
  ["checksum with a misspelled key (hash)", one("checksum", { hash: "a".repeat(64) }), false],
  ["http-endpoint with a misspelled key (status)", one("http-endpoint", { status: 200 }), false],
  ["weight above the cap", { checks: [{ kind: "length", weight: 1001 }] }, false],
  ["weight 1e308 (overflows the score)", { checks: [{ kind: "length", weight: 1e308 }, { kind: "length", weight: 1e308 }] }, false],

  // --- invalid: bounds (new) ---
  ["65 checks", many(65, { kind: "length" }), false],
  ["five http-endpoint probes", many(5, { kind: "http-endpoint" }), false],
  ["free-form metadata nested 13 levels", nestedExtra(13), false],
  ["params nested 5000 levels", JSON.parse(DEEP_TEXT), false],

  // --- invalid: params of the wrong type (new; each crashed or silently steered escrow) ---
  ["params as an array", one("length", []), false],
  ["params as a string", one("length", "x"), false],
  ["length min as a string", one("length", { min: "10" }), false],
  ["length min negative", one("length", { min: -1 }), false],
  ["length max negative", one("length", { max: -5 }), false],
  ["length min above max", one("length", { min: 10, max: 5 }), false],
  ["length unknown unit", one("length", { unit: "tokens" }), false],
  ["contains all as a string", one("contains", { all: "ERC" }), false],
  ["contains all as a number", one("contains", { all: 5 }), false],
  ["contains a non-string term", one("contains", { all: [1] }), false],
  ["contains a 1025-char term", one("contains", { all: ["x".repeat(1025)] }), false],
  ["contains 257 terms", one("contains", { all: Array.from({ length: 257 }, (_, i) => `t${i}`) }), false],
  ["contains wholeWords as a string", one("contains", { all: ["Arc"], wholeWords: "yes" }), false],
  ["contains wholeWords as a number", one("contains", { all: ["Arc"], wholeWords: 1 }), false],
  ["schema required as a string", one("schema", { required: "id" }), false],
  ["schema required with a number", one("schema", { required: [1] }), false],
  ["schema 257 required keys", one("schema", { required: Array.from({ length: 257 }, (_, i) => `k${i}`) }), false],
  ["schema types as a string", one("schema", { types: "string" }), false],
  ["schema types as an array", one("schema", { types: ["string"] }), false],
  ["schema an unknown type name", one("schema", { types: { a: "array" } }), false],
  ["schema a non-string type name", one("schema", { types: { a: 5 } }), false],
  ["checksum missing sha256", one("checksum", {}), false],
  ["checksum with a 0x prefix", one("checksum", { sha256: `0x${HEX64}` }), false],
  ["checksum too short", one("checksum", { sha256: HEX64.slice(1) }), false],
  ["checksum not hex", one("checksum", { sha256: `${HEX64.slice(1)}g` }), false],
  ["http-endpoint url as a number", one("http-endpoint", { url: 5 }), false],
  ["http-endpoint url too long", one("http-endpoint", { url: `https://example.com/${"x".repeat(2048)}` }), false],
  ["http-endpoint expectStatus 99", one("http-endpoint", { expectStatus: 99 }), false],
  ["http-endpoint expectStatus 600", one("http-endpoint", { expectStatus: 600 }), false],
  ["http-endpoint expectStatus fractional", one("http-endpoint", { expectStatus: 200.5 }), false],
  ["http-endpoint expectStatus as a string", one("http-endpoint", { expectStatus: "200" }), false],
  ["http-endpoint bodyIncludes as a string", one("http-endpoint", { bodyIncludes: "ok" }), false],
  ["http-endpoint bodyIncludes with a number", one("http-endpoint", { bodyIncludes: [1] }), false],
  ["a misspelled params (param): the check would silently pass", { checks: [{ kind: "length", param: { min: 50 } }] }, false],
  ["a misspelled params (Params)", { checks: [{ kind: "contains", Params: { all: ["USDC"] } }] }, false],
  ["a misspelled weight (wieght)", { checks: [{ kind: "length", params: { min: 1 }, wieght: 3 }] }, false],
  ["an extra field on a check (note)", { checks: [{ kind: "length", note: "why" }] }, false],
  ["kind, params and weight together", { checks: [{ kind: "length", params: { min: 1 }, weight: 2 }] }, true],
  ["a free-form top-level field stays allowed (hashed with the rest)", { note: "anything", checks: [{ kind: "length" }] }, true],
  ["http-endpoint bodyIncludes string of 1025 characters", one("http-endpoint", { bodyIncludes: ["x".repeat(1025)] }), false],
  ["http-endpoint bodyIncludes string of exactly 1024 characters", one("http-endpoint", { bodyIncludes: ["x".repeat(1024)] }), true],
  ["schema field name of 1025 characters", one("schema", { required: ["k".repeat(1025)] }), false],
  ["schema field name of exactly 1024 characters", one("schema", { required: ["k".repeat(1024)] }), true],
  ["http-endpoint timeoutMs 0", one("http-endpoint", { timeoutMs: 0 }), false],
  ["http-endpoint timeoutMs above 10 s", one("http-endpoint", { timeoutMs: 10001 }), false],
  ["http-endpoint timeoutMs as a string", one("http-endpoint", { timeoutMs: "5000" }), false],

  // --- invalid: a member named __proto__ (assignment drops it, so it would hash like criteria without it) ---
  // Built with JSON.parse, as criteria arrive from a job description: that makes __proto__ an own member.
  ["a top-level member named __proto__", JSON.parse('{"__proto__":{"x":1},"checks":[{"kind":"length"}]}'), false],
  ["a free-form member named __proto__, nested", JSON.parse('{"meta":{"a":{"__proto__":1}},"checks":[{"kind":"length"}]}'), false],
  ["a schema type for a field named __proto__", JSON.parse('{"checks":[{"kind":"schema","params":{"types":{"__proto__":"number"}}}]}'), false],
  ["a __proto__ member inside a check", JSON.parse('{"checks":[{"kind":"length","__proto__":{}}]}'), false],
  ["a required field named __proto__ stays allowed (a string, not a member)", one("schema", { required: ["__proto__"] }), true],
  ["a schema type for a field named constructor stays allowed", one("schema", { types: { constructor: "string", toString: "number" } }), true],

  // --- json: a pinned subset of JSON Schema (json-shape.js) ---
  ["json with no params (valid JSON is enough)", one("json"), true],
  ["json with an empty shape", one("json", { shape: {} }), true],
  ["json with a null shape (treated as absent)", one("json", { shape: null }), true],
  ["json: ten leads with distinct domains", one("json", { shape: { type: "array", minItems: 10, maxItems: 10, uniqueBy: { field: "website", key: "domain" },
    items: { type: "object", additionalProperties: false, required: ["name", "website", "network", "contact"], properties: {
      name: { type: "string", minLength: 1 }, website: { type: "string", format: "url" }, network: { enum: ["Arc", "Base"] },
      contact: { anyOf: [{ type: "string", format: "email" }, { type: "string", format: "url" }] } } } } }), true],
  ["json: integer bounds", one("json", { shape: { type: "integer", minimum: 1, maximum: 20 } }), true],
  ["json: a field named constructor is a field, not a keyword", one("json", { shape: { type: "object", required: ["constructor"], properties: { constructor: {} } } }), true],
  ["json with a misspelled param (schema)", one("json", { schema: {} }), false],
  ["json: an unknown keyword (minItem)", one("json", { shape: { type: "array", minItem: 1 } }), false],
  ["json: an inherited name used as a keyword (toString)", one("json", { shape: { type: "string", toString: 1 } }), false],
  ["json: a keyword without its type", one("json", { shape: { minItems: 1 } }), false],
  ["json: a keyword for another type", one("json", { shape: { type: "string", maxItems: 1 } }), false],
  ["json: an unknown type", one("json", { shape: { type: "list" } }), false],
  ["json: anyOf beside another keyword", one("json", { shape: { anyOf: [{}, {}], type: "string" } }), false],
  ["json: anyOf with one shape", one("json", { shape: { anyOf: [{}] } }), false],
  ["json: anyOf with five shapes", one("json", { shape: { anyOf: [{}, {}, {}, {}, {}] } }), false],
  ["json: anyOf directly inside anyOf", one("json", { shape: { anyOf: [{ anyOf: [{}, {}] }, {}] } }), false],
  ["json: an empty enum", one("json", { shape: { enum: [] } }), false],
  ["json: an enum holding an object", one("json", { shape: { enum: [{}] } }), false],
  ["json: minItems above maxItems", one("json", { shape: { type: "array", minItems: 3, maxItems: 2 } }), false],
  ["json: a fractional minLength", one("json", { shape: { type: "string", minLength: 0.5 } }), false],
  ["json: a null minimum", one("json", { shape: { type: "number", minimum: null } }), false],
  ["json: an unknown format", one("json", { shape: { type: "string", format: "phone" } }), false],
  ["json: uniqueBy with an unknown key", one("json", { shape: { type: "array", uniqueBy: { field: "a", key: "host" } } }), false],
  ["json: additionalProperties as a string", one("json", { shape: { type: "object", additionalProperties: "no" } }), false],
  ["json: a bad shape deep inside", one("json", { shape: { type: "array", items: { type: "object", properties: { "a b": { type: "strin" } } } } }), false],
  ["json: a shape that is a list", one("json", { shape: [] }), false],
  ["json: 129 shapes", one("json", { shape: { type: "object", properties: Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`f${i}`, {}])) } }), false],
];
