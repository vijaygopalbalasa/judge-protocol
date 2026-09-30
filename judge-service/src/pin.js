// Pin a ruling record to IPFS through Pinata, for JudgeArbitrator rulings (docs/ARBITRATOR.md): ArcBounty asked for
// the CID and a gateway link before any ruling is signed. The file is pinned as CIDv0, the CID Pinata reports must equal
// the file's own CID computed here, and a public gateway must serve exactly these bytes before the CID is handed out.
//
//   node src/pin.js <file> [--name NAME]
//
// The key comes from the environment (PINATA_JWT_KEY, or PINATA_JWT) and is never printed.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { cidV0, fetchVerified } from "./arcbounty.js";

export const PINATA_PIN_URL = "https://api.pinata.cloud/pinning/pinFileToIPFS";
export const PINATA_GATEWAY = "https://gateway.pinata.cloud/ipfs/";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Pin `bytes` and prove they are readable at the CID. Fresh pins can take a moment to reach a gateway, so the read
 * is retried. Returns { cid, link, gateway, size }.
 */
export async function pinFile(bytes, { jwt, name = "judge-protocol ruling record", fetchImpl = fetch, gatewayFetch,
  retries = 6, retryDelayMs = 5000 } = {}) {
  if (!jwt) throw new Error("PINATA_JWT_KEY is not set");
  const cid = cidV0(bytes); // refuses a file IPFS would split into several blocks

  const form = new FormData();
  form.append("file", new Blob([bytes]), "ruling.json");
  form.append("pinataOptions", JSON.stringify({ cidVersion: 0 }));
  form.append("pinataMetadata", JSON.stringify({ name }));
  const res = await fetchImpl(PINATA_PIN_URL, { method: "POST", headers: { Authorization: `Bearer ${jwt}` }, body: form });
  if (!res.ok) throw new Error(`Pinata answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  if (body.IpfsHash !== cid) throw new Error(`Pinata reported ${body.IpfsHash} but the file's CID is ${cid}`);

  let lastError = null;
  for (let i = 0; i < retries; i++) {
    try {
      await fetchVerified(cid, { sources: [PINATA_GATEWAY], ...(gatewayFetch ? { fetchImpl: gatewayFetch } : {}) });
      return { cid, link: `ipfs://${cid}`, gateway: `${PINATA_GATEWAY}${cid}`, size: bytes.length };
    } catch (e) {
      lastError = e;
      if (i + 1 < retries) await sleep(retryDelayMs);
    }
  }
  throw new Error(`pinned ${cid}, but no gateway served its bytes yet (${lastError?.message}); do not send the CID`);
}

/** The command line, with its file reader, network and environment injectable for tests. */
export async function runPinCli(argv, { env = process.env, readFileImpl = readFile, fetchImpl, gatewayFetch } = {}) {
  let name;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--name") name = argv[++i];
    else if (argv[i].startsWith("--")) throw new Error(`unknown option ${argv[i]}`);
    else rest.push(argv[i]);
  }
  if (rest.length !== 1) throw new Error("usage: node src/pin.js <file> [--name NAME]");
  const bytes = await readFileImpl(rest[0]);
  return pinFile(bytes, { jwt: env.PINATA_JWT_KEY || env.PINATA_JWT, name, ...(fetchImpl ? { fetchImpl } : {}), gatewayFetch });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runPinCli(process.argv.slice(2))
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
