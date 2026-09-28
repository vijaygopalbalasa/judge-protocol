// The hosted API's landing pages must state the deployment they serve, with the same addresses the
// verifier uses (web/app.js NETWORKS), and the mainnet host must be the one that shows the mainnet page.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
const { NETWORKS } = await import("../../web/app.js");

test("the Arc mainnet landing page names the mainnet judge and escrow, and keeps paid rulings to testnet", () => {
  const page = read("../public/mainnet.html");
  const net = NETWORKS["arc-mainnet"];
  assert.match(page, /CHAIN 5042\b/);
  assert.ok(page.includes(net.judge), "the judge address");
  assert.ok(page.includes(net.acp), "the escrow address");
  assert.ok(!page.includes(NETWORKS["arc-testnet"].judge), "never the testnet judge");
  assert.match(page, /\/api\/x402\/judge<\/code><\/td><td>[^<]*Arc testnet only/, "the paid route is documented as testnet-only");
  assert.match(page, /\?network=arc-mainnet/, "points to the in-browser check for mainnet rulings");
  assert.ok(!new RegExp(`[${String.fromCharCode(0x2014, 0x2013)}]`).test(page), "no em or en dashes");
});

test("the mainnet host serves the mainnet page; every other host keeps the testnet page", () => {
  const vercel = JSON.parse(read("../vercel.json"));
  const r = (vercel.rewrites || []).find((x) => x.destination === "/mainnet.html");
  assert.ok(r, "a rewrite to the mainnet page");
  assert.equal(r.source, "/");
  assert.deepEqual(r.has, [{ type: "host", value: "judge-protocol-api-mainnet.vercel.app" }]);
  assert.match(read("../public/index.html"), /ARC TESTNET · CHAIN 5042002/);
});
