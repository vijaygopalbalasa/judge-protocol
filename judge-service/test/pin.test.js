// Pinning a ruling record: the CID Pinata reports must be the CID we compute, and a public gateway must serve the
// exact bytes before anyone is told the CID.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cidV0, MAX_SINGLE_BLOCK } from "../src/arcbounty.js";
import { pinFile, runPinCli, PINATA_PIN_URL, PINATA_GATEWAY } from "../src/pin.js";

const record = Buffer.from(JSON.stringify({ status: "ruled", ruling: { rulingHash: "0x" + "ab".repeat(32) } }, null, 2) + "\n");
const JWT = "eyJ" + "x".repeat(40);

/** A fake Pinata: records the request and answers with `answer` (default: the right CID). */
function fakePinata(answer) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    const form = init.body;
    const file = form.get("file");
    const bytes = Buffer.from(await file.arrayBuffer());
    const body = answer ? answer(bytes) : { IpfsHash: cidV0(bytes), PinSize: bytes.length };
    return { ok: body.__status ? false : true, status: body.__status ?? 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return { fetchImpl, seen };
}
const gatewayServing = (bytes) => async (url) => ({ status: 200, content: bytes, url });

test("a record is pinned as CIDv0, checked against our own CID, and read back from the gateway", async () => {
  const p = fakePinata();
  const r = await pinFile(record, { jwt: JWT, name: "judge ruling job 7", fetchImpl: p.fetchImpl, gatewayFetch: gatewayServing(record) });
  assert.equal(r.cid, cidV0(record));
  assert.equal(r.link, `ipfs://${cidV0(record)}`);
  assert.equal(r.gateway, `${PINATA_GATEWAY}${cidV0(record)}`);
  assert.equal(p.seen.length, 1);
  assert.equal(p.seen[0].url, PINATA_PIN_URL);
  assert.equal(p.seen[0].init.method, "POST");
  assert.equal(p.seen[0].init.headers.Authorization, `Bearer ${JWT}`);
  assert.deepEqual(JSON.parse(p.seen[0].init.body.get("pinataOptions")), { cidVersion: 0 });
  assert.equal(JSON.parse(p.seen[0].init.body.get("pinataMetadata")).name, "judge ruling job 7");
});

test("a CID from Pinata that is not the file's own CID is refused", async () => {
  const p = fakePinata(() => ({ IpfsHash: cidV0(Buffer.from("something else")) }));
  await assert.rejects(pinFile(record, { jwt: JWT, fetchImpl: p.fetchImpl, gatewayFetch: gatewayServing(record) }),
    /Pinata reported .* but the file's CID is/);
});

test("a gateway that does not serve the exact bytes means the CID is not handed out", async () => {
  const p = fakePinata();
  await assert.rejects(pinFile(record, { jwt: JWT, fetchImpl: p.fetchImpl, gatewayFetch: gatewayServing(Buffer.from("other")),
    retries: 2, retryDelayMs: 1 }), /no gateway served/);
});

test("Pinata refusing the upload, a missing key, and a file too large for one block all fail loudly", async () => {
  const p = fakePinata(() => ({ __status: 401, error: "unauthorized" }));
  await assert.rejects(pinFile(record, { jwt: JWT, fetchImpl: p.fetchImpl, gatewayFetch: gatewayServing(record) }), /Pinata answered 401/);
  await assert.rejects(pinFile(record, { jwt: "", fetchImpl: fakePinata().fetchImpl }), /PINATA_JWT_KEY/);
  const big = Buffer.alloc(MAX_SINGLE_BLOCK + 1);
  await assert.rejects(pinFile(big, { jwt: JWT, fetchImpl: fakePinata().fetchImpl }), /several blocks/);
});

test("the CLI pins a file, never prints the key, and says where it can be read", async () => {
  const p = fakePinata();
  const out = await runPinCli(["ruling.json", "--name", "job 7"], {
    env: { PINATA_JWT_KEY: JWT }, readFileImpl: async () => record, fetchImpl: p.fetchImpl, gatewayFetch: gatewayServing(record),
  });
  assert.equal(out.cid, cidV0(record));
  assert.ok(!JSON.stringify(out).includes(JWT), "the key is not in the output");
});
