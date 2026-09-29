// The json check: a JSON deliverable whose shape is pinned in the criteria (docs/CRITERIA.md, "json").
// Written against ArcBounty's first trial bounty ("Poster leads"): a JSON array of exactly 10 objects with
// fixed fields, a network from a list, URL and email fields, and no two websites on the same domain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toBytes } from "viem";
import { runAllChecks, validateCriteria, LIMITS } from "../src/checkers/index.js";
import { isUrl, isEmail, domainOf, SHAPE_LIMITS, SHAPE_KEYWORDS } from "../src/checkers/json-shape.js";
import { ruleOnSubmission, cidV0, criteriaFromDescription } from "../src/arcbounty.js";

const lead = {
  type: "object", additionalProperties: false,
  required: ["name", "website", "network", "paid_work_evidence", "contact"],
  properties: {
    name: { type: "string", minLength: 1 },
    website: { type: "string", format: "url" },
    network: { enum: ["Arc", "Base"] },
    paid_work_evidence: { type: "string", format: "url" },
    contact: { anyOf: [{ type: "string", format: "email" }, { type: "string", format: "url" }] },
  },
};
const POSTER_LEADS = { version: 1, passThreshold: 100, checks: [{ kind: "json", params: { shape: {
  type: "array", minItems: 10, maxItems: 10, items: lead, uniqueBy: { field: "website", key: "domain" } } } }] };

const leads = () => Array.from({ length: 10 }, (_, i) => ({
  name: `Team ${i}`, website: `https://team${i}.xyz`, network: i % 2 ? "Base" : "Arc",
  paid_work_evidence: `https://team${i}.xyz/bounties`, contact: i % 3 ? `hello@team${i}.xyz` : `https://team${i}.xyz/contact`,
}));
const judge = (value, criteria = POSTER_LEADS) =>
  runAllChecks(criteria, { content: Buffer.from(typeof value === "string" ? value : JSON.stringify(value)) });
const detailOf = (r) => r.results[0].detail;

test("Poster leads: ten well-formed leads on ten domains pass", async () => {
  const r = await judge(leads());
  assert.equal(r.pass, true, detailOf(r));
  assert.equal(r.score, 100);
});

test("nine or eleven leads fail, and the detail says how many there were", async () => {
  let r = await judge(leads().slice(0, 9));
  assert.equal(r.pass, false);
  assert.match(detailOf(r), /\$: 9 items, need at least 10/);
  r = await judge([...leads(), { ...leads()[0], website: "https://eleven.xyz" }]);
  assert.equal(r.pass, false);
  assert.match(detailOf(r), /\$: 11 items, need at most 10/);
});

test("two websites on one domain fail, whatever the letter case, a leading www. or the path", async () => {
  const l = leads();
  l[7].website = "https://WWW.Team2.xyz/about";
  const r = await judge(l);
  assert.equal(r.pass, false);
  assert.match(detailOf(r), /\$\[7\]\.website: same domain as \$\[2\] \(team2\.xyz\)/);
});

test("a subdomain is a different domain: no public-suffix list, so the rule is the host itself", async () => {
  const l = leads();
  l[7].website = "https://blog.team2.xyz";
  assert.equal((await judge(l)).pass, true);
});

test('the network is matched exactly: "arc" is not "Arc"', async () => {
  const l = leads();
  l[3].network = "arc";
  const r = await judge(l);
  assert.equal(r.pass, false);
  assert.match(detailOf(r), /\$\[3\]\.network: "arc" is not one of "Arc", "Base"/);
});

test("a contact that is neither an email nor a URL fails, and so does a mailto: link", async () => {
  for (const contact of ["call us", "mailto:hello@team1.xyz", "hello at team1.xyz", ""]) {
    const l = leads();
    l[1].contact = contact;
    const r = await judge(l);
    assert.equal(r.pass, false, contact);
    assert.match(detailOf(r), /\$\[1\]\.contact: matches none of the 2 allowed shapes/, contact);
  }
});

test("a missing field, an extra field or an empty name fails", async () => {
  let l = leads();
  delete l[1].contact;
  assert.match(detailOf(await judge(l)), /\$\[1\]: missing "contact"/);
  l = leads();
  l[0].email = "hello@team0.xyz";
  assert.match(detailOf(await judge(l)), /\$\[0\]: unexpected field "email"/);
  l = leads();
  l[5].name = "";
  assert.match(detailOf(await judge(l)), /\$\[5\]\.name: 0 characters, need at least 1/);
});

test("a lead that is not an object, and a top-level object instead of a list, fail as checks", async () => {
  const l = leads();
  l[4] = "Team 4, https://team4.xyz";
  assert.match(detailOf(await judge(l)), /\$\[4\]: expected object, got string/);
  const r = await judge({ leads: leads() });
  assert.equal(r.pass, false);
  assert.match(detailOf(r), /\$: expected array, got object/);
});

test("a value of the wrong type is one problem, not also judged by the rules for the type it is not", async () => {
  const l = leads();
  l[4] = "Team 4, https://team4.xyz";
  assert.equal(detailOf(await judge(l)), "1 problem: $[4]: expected object, got string");
  const c = { checks: [{ kind: "json", params: { shape: { type: "string", minLength: 1, format: "url" } } }] };
  for (const v of ["null", "12", "[]", "{}"]) {
    const r = await judge(v, c);
    assert.equal(r.pass, false, v);
    assert.match(detailOf(r), /^1 problem: \$: expected string, got /, v);
  }
});

test("a deliverable that is not JSON is a failed check, never a crash", async () => {
  const r = await judge("name,website\nTeam 0,https://team0.xyz");
  assert.equal(r.pass, false);
  assert.match(detailOf(r), /not valid JSON/);
});

test("every problem is counted and the first five found are shown, item by item", async () => {
  const l = leads();
  for (const i of [0, 2, 4, 6, 8, 9]) l[i].network = "Solana";
  const d = detailOf(await judge(l));
  assert.match(d, /^6 problems: \$\[0\]\.network/);
  assert.equal(d.split("; ").length, 5);
  assert.ok(!d.includes("$[9]"), "the sixth is counted, not shown");
});

test("a value copied from the deliverable into the detail is cut short", async () => {
  const l = leads();
  l[0].network = "x".repeat(5000);
  assert.ok(detailOf(await judge(l)).length < 400);
});

test("urls: http or https, a host with a dot, an optional port, then printable ASCII only", () => {
  for (const u of ["https://a.co", "http://sub.example.org:8080/path?q=1#f", "https://xn--80ak6aa92e.com", "HTTPS://EXAMPLE.COM",
    "https://team0.xyz/", "https://a-b.c-d.io/x_y~z%20"]) assert.equal(isUrl(u), true, u);
  for (const u of ["ftp://a.co", "https://localhost", "https://a.co/a b", "https://user@a.co", "https://a..co", "https://-a.co",
    "https://a-.co", "https://a.co.", "https://1.2.3.4", "https://a.co:123456", "https://a.co:", "https://[::1]/", "https://", "a.co",
    "https://exämple.com", "https://a.co/é", " https://a.co", "https://a.co\n", "https://" + "a".repeat(64) + ".co",
    "https://a.co/" + "x".repeat(LIMITS.urlChars), 42, null]) assert.equal(isUrl(u), false, String(u));
});

test("emails: one @, a plain local part, and the same host rule as urls", () => {
  for (const e of ["hello@team.xyz", "first.last+tag@sub.example.org", "o'brien@x.io", "a@b.co"]) assert.equal(isEmail(e), true, e);
  for (const e of ["@a.co", "a@", "a@@b.co", "a@b@c.co", "a.@b.co", ".a@b.co", "a..b@c.co", "a b@c.co", "a@localhost",
    "mailto:a@b.co", "x".repeat(65) + "@b.co", "a@b.co ", "a@1.2.3.4", 7]) assert.equal(isEmail(e), false, String(e));
});

test("the domain of a url is its host, lowercased, with one leading www. removed", () => {
  assert.equal(domainOf("https://WWW.Example.COM:8080/x"), "example.com");
  assert.equal(domainOf("https://www.www.a.co"), "www.a.co");
  assert.equal(domainOf("https://blog.a.co/x"), "blog.a.co");
  assert.equal(domainOf("https://www.co"), "www.co", "a host that is only www. plus one label keeps its www.");
});

test("the Poster leads block passes the criteria gate and survives the trip through a description", () => {
  assert.deepEqual(validateCriteria(POSTER_LEADS), { valid: true, reason: "ok" });
  const md = "# Poster leads\n\n```judge-criteria\n" + JSON.stringify(POSTER_LEADS, null, 2) + "\n```\n";
  assert.deepEqual(criteriaFromDescription(Buffer.from(md)).criteria, POSTER_LEADS);
});

const shapeCase = (shape) => validateCriteria({ checks: [{ kind: "json", params: { shape } }] });
test("the gate refuses a malformed shape and names the place", () => {
  const cases = [
    [{ type: "array", minItem: 3 }, /shape: unknown keyword "minItem"/],
    [{ minItems: 3 }, /shape: minItems needs "type": "array"/],
    [{ type: "string", minItems: 1 }, /shape: minItems needs "type": "array"/],
    [{ type: "list" }, /shape: type must be one of object, array, string, number, integer, boolean, null/],
    [{ type: "array", items: { type: "object", properties: { a: { type: "strin" } } } }, /shape\.items\.properties\.a: type must be one of/],
    [{ anyOf: [{ type: "string" }, { type: "number" }], type: "string" }, /shape: anyOf stands alone/],
    [{ anyOf: [{ type: "string" }] }, /shape: anyOf needs 2 to 4 shapes/],
    [{ anyOf: [{}, {}, {}, {}, {}] }, /shape: anyOf needs 2 to 4 shapes/],
    [{ anyOf: [{ anyOf: [{}, {}] }, {}] }, /shape\.anyOf\[0\]: anyOf directly inside anyOf/],
    [{ enum: [] }, /shape: enum must be a list of 1 to 256 strings, numbers, booleans or nulls/],
    [{ enum: [{ a: 1 }] }, /shape: enum must be a list of 1 to 256/],
    [{ type: "array", minItems: 5, maxItems: 3 }, /shape: minItems must not be above maxItems/],
    [{ type: "array", minItems: 1.5 }, /shape: minItems must be a whole number >= 0/],
    [{ type: "string", minLength: -1 }, /shape: minLength must be a whole number >= 0/],
    [{ type: "number", minimum: 2, maximum: 1 }, /shape: minimum must not be above maximum/],
    [{ type: "string", format: "phone" }, /shape: format must be "url" or "email"/],
    [{ type: "array", uniqueBy: { field: "website", key: "host" } }, /shape: uniqueBy must be \{ field, key \}/],
    [{ type: "array", uniqueBy: { key: "domain" } }, /shape: uniqueBy must be \{ field, key \}/],
    [{ type: "object", additionalProperties: "no" }, /shape: additionalProperties must be true or false/],
    [{ type: "object", required: "name" }, /shape: required must be a list of up to 256 field names/],
    [{ type: "object", properties: [] }, /shape: properties must be an object of field: shape/],
    [{ type: "string", minLength: null }, /shape: minLength must be a whole number >= 0/],
    [[], /shape must be an object/],
    ["array", /shape must be an object/],
    [{ type: "string", toString: 1 }, /shape: unknown keyword "toString"/],
    [{ type: "object", constructor: {} }, /shape: unknown keyword "constructor"/],
  ];
  for (const [shape, reason] of cases) {
    const v = shapeCase(shape);
    assert.equal(v.valid, false, JSON.stringify(shape));
    assert.match(v.reason, reason, JSON.stringify(shape));
    assert.match(v.reason, /^checks\[0\] \(json\): /);
  }
});

test("the gate caps a shape's size, and still refuses a __proto__ member inside it", () => {
  const wide = (n) => ({ type: "object", properties: Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, {}])) });
  assert.equal(shapeCase(wide(SHAPE_LIMITS.nodes - 1)).valid, true, "the root and 127 fields make 128 shapes, the most allowed");
  assert.match(shapeCase(wide(SHAPE_LIMITS.nodes)).reason, new RegExp(`at most ${SHAPE_LIMITS.nodes} shapes`));
  const proto = JSON.parse('{"checks":[{"kind":"json","params":{"shape":{"type":"object","properties":{"__proto__":{}}}}}]}');
  assert.equal(validateCriteria(proto).valid, false);
});

test("a json check with no shape only asks for valid JSON, and an empty shape allows any JSON", async () => {
  for (const params of [undefined, {}, { shape: null }, { shape: {} }]) {
    const c = { checks: [params === undefined ? { kind: "json" } : { kind: "json", params }] };
    assert.equal(validateCriteria(c).valid, true, JSON.stringify(params));
    assert.equal((await judge("[1, 2]", c)).pass, true);
    assert.equal((await judge("{nope", c)).pass, false);
  }
});

test("integers are whole numbers, a number too large for a double is no number, and bounds hold at the edges", async () => {
  const c = (shape) => ({ checks: [{ kind: "json", params: { shape } }] });
  const n = c({ type: "integer", minimum: 1, maximum: 20 });
  for (const [v, ok] of [["1", true], ["20", true], ["1.0", true], ["0", false], ["21", false], ["1.5", false], ['"5"', false], ["true", false], ["1e400", false]]) {
    assert.equal((await judge(v, n)).pass, ok, v);
  }
  for (const v of ["1e400", "-1e400"]) {
    const r = await judge(v, c({ type: "number" }));
    assert.equal(r.pass, false, v);
    assert.equal(detailOf(r), "1 problem: $: expected number, got non-finite number", v);
  }
  assert.match(detailOf(await judge("1e400", c({ enum: [1] }))), /a non-finite number is not one of 1/);
  const s = c({ type: "string", minLength: 2, maxLength: 3 });
  for (const [v, ok] of [['"ab"', true], ['"abc"', true], ['"a"', false], ['"abcd"', false], ['"\u{1F600}\u{1F600}"', true]]) {
    assert.equal((await judge(v, s)).pass, ok, v);
  }
});

test("enum compares type and value exactly: the string \"1\" is not the number 1, and true is not 1", async () => {
  const c = { checks: [{ kind: "json", params: { shape: { enum: [1, "two", null] } } }] };
  for (const [v, ok] of [["1", true], ["1.0", true], ['"two"', true], ["null", true], ['"1"', false], ["true", false], ['"Two"', false], ["[1]", false]]) {
    assert.equal((await judge(v, c)).pass, ok, v);
  }
});

test("uniqueBy value compares strings, numbers and booleans exactly and skips items that lack the field", async () => {
  const c = { checks: [{ kind: "json", params: { shape: { type: "array", uniqueBy: { field: "id", key: "value" } } } }] };
  assert.equal((await judge([{ id: 1 }, { id: 2 }, { id: "1" }, { other: 1 }, 5], c)).pass, true);
  assert.match(detailOf(await judge([{ id: "a" }, { id: "b" }, { id: "a" }], c)), /\$\[2\]\.id: same value as \$\[0\]/);
});

test("docs/CRITERIA.md documents every shape keyword and both formats", async () => {
  const { readFileSync } = await import("node:fs");
  const md = readFileSync(new URL("../../docs/CRITERIA.md", import.meta.url), "utf8");
  const section = md.slice(md.indexOf("### `json`"), md.indexOf("### `checksum`"));
  for (const k of SHAPE_KEYWORDS) assert.ok(section.includes("`" + k + "`"), `keyword ${k}`);
  for (const f of ["**url**", "**email**", "**domain**", "at most 128 shapes"]) assert.ok(section.includes(f), f);
  assert.ok(section.includes(`at most ${SHAPE_LIMITS.nodes} shapes`));
});

test("the grammar's bounds are the judge's bounds", () => {
  assert.equal(SHAPE_LIMITS.terms, LIMITS.terms);
  assert.equal(SHAPE_LIMITS.termChars, LIMITS.termChars);
  assert.equal(SHAPE_LIMITS.urlChars, LIMITS.urlChars);
});

const describe = (c) => Buffer.from("# Poster leads\n\nTen teams that pay for work.\n\n```judge-criteria\n" + JSON.stringify(c, null, 2) + "\n```\n");
const link = (b) => `ipfs://${cidV0(b)}`;
const input = (sub) => ({
  network: "arc-mainnet", jobId: "18", descriptionLink: link(describe(POSTER_LEADS)), descriptionBytes: describe(POSTER_LEADS),
  submissionLink: link(sub), submissionBytes: sub, escrowCommitment: keccak256(toBytes(link(sub))), decision: "awaiting-review",
});

test("ArcBounty: a Poster leads submission is ruled from its IPFS bytes, PASS for good leads and REJECT for a duplicate domain", async () => {
  const good = Buffer.from(JSON.stringify(leads(), null, 2));
  let r = await ruleOnSubmission(input(good));
  assert.equal(r.status, "ruled", r.reason);
  assert.equal(r.ruling.pass, true);
  assert.equal(r.ruling.score, 100);
  const l = leads();
  l[9].website = "https://team0.xyz/pricing";
  r = await ruleOnSubmission(input(Buffer.from(JSON.stringify(l))));
  assert.equal(r.status, "ruled", r.reason);
  assert.equal(r.ruling.pass, false);
  assert.equal(r.ruling.score, 0);
});
