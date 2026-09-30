// JudgeArbitrator rulings (contracts/src/JudgeArbitrator.sol, docs/ARBITRATOR.md): turn a fresh Judge ruling on a
// disputed ArcBounty bounty into an EIP-712 Ruling signed by the arbitrator's signer key, and relay it if asked.
//
// It signs only when everything holds, read fresh from the chain: Judge ruled (did not abstain) on the bounty as it
// stands, the bounty is in dispute and unresolved, the pinned ruling record is exactly this ruling (same rulingHash,
// fetched by its CID and checked against it), our contract holds the adapter's arbitrator role for this adapter, is not
// paused or handing the role back, trusts the signer, and computes the same digest we do. The penalty is always 0
// (ArcBounty's call, Sofiia7/ARC#4, 2026-09-30). issuedAt is the chain head's timestamp: the contract refuses a ruling
// dated after its block or more than a day old, so sign and relay in one sitting.
//
//   node src/arbitrate.js <jobId> --network arc-testnet --arbitrator 0x... --cid Qm... [--relay] [--out FILE]
//
// Keys come from the environment only and are never printed: ARBITRATOR_SIGNER_KEY signs; with --relay,
// ARBITRATOR_RELAYER_KEY (a key with gas) sends resolve(ruling, signature). Anyone may relay a signed ruling.
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, hashTypedData, http, keccak256, parseAbi, stringToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARCBOUNTY_NETWORKS, fetchVerified, parseIpfsLink, readBounty, runCli as ruleCli } from "./arcbounty.js";

/** JudgeArbitrator.MAX_CID_LEN, the adapter's own bound on a ruling reference. */
export const MAX_CID_LEN = 96;

/** The EIP-712 type JudgeArbitrator signs over: the adapter first, then the Ruling's fields. */
export const RULING_TYPES = {
  Ruling: [
    { name: "adapter", type: "address" },
    { name: "jobId", type: "uint256" },
    { name: "submissionHash", type: "bytes32" },
    { name: "descriptionHash", type: "bytes32" },
    { name: "payProvider", type: "bool" },
    { name: "rulingCid", type: "string" },
    { name: "reputationPenalty", type: "uint8" },
    { name: "issuedAt", type: "uint64" },
  ],
};

const ARBITRATOR_ABI = parseAbi([
  "struct Ruling { uint256 jobId; bytes32 submissionHash; bytes32 descriptionHash; bool payProvider; string rulingCid; uint8 reputationPenalty; uint64 issuedAt; }",
  "function adapter() view returns (address)",
  "function isActiveSigner(address s) view returns (bool)",
  "function paused() view returns (bool)",
  "function handingBack() view returns (bool)",
  "function rulingDigest(Ruling r) view returns (bytes32)",
  "function resolve(Ruling r, bytes sig)",
]);
const ADAPTER_ROLE_ABI = parseAbi(["function arbitrator() view returns (address)"]);

export const rulingDomain = (chainId, arbitrator) => ({ name: "JudgeArbitrator", version: "1", chainId, verifyingContract: arbitrator });

/** The digest JudgeArbitrator.rulingDigest returns for `ruling` on `arbitrator`, computed locally. */
export function localDigest(chainId, arbitrator, adapter, ruling) {
  return hashTypedData({ domain: rulingDomain(chainId, arbitrator), types: RULING_TYPES, primaryType: "Ruling",
    message: { adapter, ...ruling } });
}

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const refuse = (reason) => { throw new Error(`refused: ${reason}`); };

/**
 * Everything a signer needs, checked. Throws "refused: ..." on any condition that does not hold.
 * `client` is a viem public client (or a fake with the same methods) for the network's chain.
 */
export async function prepareRuling({ jobId, network, arbitrator, cid, signerAddress, client, fetchImpl, now }) {
  if (!Object.hasOwn(ARCBOUNTY_NETWORKS, network)) refuse(`unknown network "${network}"`);
  const net = ARCBOUNTY_NETWORKS[network];
  if (!/^[0-9]{1,30}$/.test(String(jobId))) refuse("jobId must be a positive integer");
  const id = BigInt(jobId).toString();
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(arbitrator))) refuse("--arbitrator must be an address");
  const p = parseIpfsLink(String(cid ?? ""));
  if (p.error) refuse(`the ruling CID: ${p.error}`);
  const rulingCid = `ipfs://${p.cid}`;
  if (rulingCid.length > MAX_CID_LEN) refuse(`the ruling CID is longer than ${MAX_CID_LEN} characters`);

  const chain = Number(await client.getChainId());
  if (chain !== net.chainId) throw new Error(`the RPC serves chain ${chain}, not ${network} (${net.chainId})`);

  // 1. Judge's ruling, recomputed now from chain data and the two IPFS files.
  const fresh = (await ruleCli([id, "--network", network], { makeClient: () => client, fetchImpl, now })).result;
  if (fresh.status !== "ruled") refuse(`Judge did not rule on job ${id} (${fresh.status}${fresh.reason ? `: ${fresh.reason}` : ""})`);

  // 2. The bounty as it stands.
  const { meta } = await readBounty(client, net, id);
  if (!meta.inDispute || meta.resolved) refuse(`job ${id} is not in dispute (inDispute ${meta.inDispute}, resolved ${meta.resolved})`);

  // 3. The pinned record must be this ruling.
  let pinned;
  try {
    pinned = JSON.parse((await fetchVerified(p.cid, { fetchImpl })).bytes.toString("utf8"));
  } catch (e) {
    refuse(`the pinned record at ${rulingCid} could not be read and checked against its CID (${e.message})`);
  }
  const pinnedHash = pinned?.ruling?.rulingHash ?? pinned?.rulingHash;
  if (pinnedHash !== fresh.ruling.rulingHash) {
    refuse(`the pinned record is not this ruling (pinned ${pinnedHash ?? "none"}, fresh ${fresh.ruling.rulingHash})`);
  }

  // 4. Our contract, as deployed.
  const read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args });
  if (!same(await read(arbitrator, ARBITRATOR_ABI, "adapter"), net.adapter)) refuse(`${arbitrator} serves another adapter`);
  if (!same(await read(net.adapter, ADAPTER_ROLE_ABI, "arbitrator"), arbitrator)) {
    refuse(`${arbitrator} does not hold the adapter's arbitrator role`);
  }
  if (await read(arbitrator, ARBITRATOR_ABI, "paused")) refuse("the arbitrator is paused");
  if (await read(arbitrator, ARBITRATOR_ABI, "handingBack")) refuse("the arbitrator is handing the role back");
  if (!(await read(arbitrator, ARBITRATOR_ABI, "isActiveSigner", [signerAddress]))) refuse(`${signerAddress} is not an active signer`);

  // 5. The ruling, dated by the chain.
  const head = await client.getBlock();
  const ruling = {
    jobId: BigInt(id),
    submissionHash: keccak256(stringToBytes(meta.submittedResultHash)),
    descriptionHash: keccak256(stringToBytes(meta.ipfsDescHash)),
    payProvider: fresh.ruling.pass === true,
    rulingCid,
    reputationPenalty: 0,
    issuedAt: BigInt(head.timestamp),
  };
  const digest = localDigest(net.chainId, arbitrator, net.adapter, ruling);
  const onChain = await read(arbitrator, ARBITRATOR_ABI, "rulingDigest", [ruling]);
  if (!same(onChain, digest)) refuse(`the contract's digest differs (${onChain} vs ${digest})`);

  return { network, chainId: net.chainId, adapter: net.adapter, arbitrator, jobId: id, ruling, digest,
    rulingHash: fresh.ruling.rulingHash, pass: fresh.ruling.pass, score: fresh.ruling.score };
}

/** Sign a prepared ruling with `account` (a viem local account). */
export async function signRuling(prepared, account) {
  const signature = await account.signTypedData({ domain: rulingDomain(prepared.chainId, prepared.arbitrator), types: RULING_TYPES,
    primaryType: "Ruling", message: { adapter: prepared.adapter, ...prepared.ruling } });
  return { ...prepared, signer: account.address, signature };
}

const USAGE = "usage: node src/arbitrate.js <jobId> --network arc-testnet --arbitrator 0x... --cid Qm... [--relay] [--rpc URL] [--out FILE]";
const OPTIONS = new Set(["--network", "--arbitrator", "--cid", "--rpc", "--out"]);

function defaultClient(rpc, chainId, network) {
  return createPublicClient({
    chain: { id: chainId, name: network, nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } },
    transport: http(rpc, { retryCount: 3, retryDelay: 1500 }),
  });
}

/** The command line, with its chain client, file source, clock and environment injectable for tests. */
export async function runArbitrateCli(argv, { client, fetchImpl, now = () => BigInt(Math.floor(Date.now() / 1000)), env = process.env } = {}) {
  const opts = { network: "arc-testnet", relay: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--relay") { opts.relay = true; continue; }
    if (a.startsWith("--")) {
      if (!OPTIONS.has(a)) throw new Error(`unknown option ${a}\n${USAGE}`);
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value\n${USAGE}`);
      opts[a.slice(2)] = argv[++i];
    } else rest.push(a);
  }
  if (rest.length !== 1 || !opts.arbitrator || !opts.cid) throw new Error(USAGE);
  if (!env.ARBITRATOR_SIGNER_KEY) throw new Error("ARBITRATOR_SIGNER_KEY is not set");
  if (opts.relay && !env.ARBITRATOR_RELAYER_KEY) throw new Error("--relay needs ARBITRATOR_RELAYER_KEY (a key with gas)");
  const net = ARCBOUNTY_NETWORKS[opts.network];
  if (!net) throw new Error(`unknown network "${opts.network}"`);
  const pub = client ?? defaultClient(opts.rpc || net.rpc, net.chainId, opts.network);
  const signer = privateKeyToAccount(env.ARBITRATOR_SIGNER_KEY);

  const prepared = await prepareRuling({ jobId: rest[0], network: opts.network, arbitrator: opts.arbitrator, cid: opts.cid,
    signerAddress: signer.address, client: pub, fetchImpl, now });
  const signed = await signRuling(prepared, signer);

  let txHash = null;
  if (opts.relay) {
    const relayer = privateKeyToAccount(env.ARBITRATOR_RELAYER_KEY);
    const wallet = createWalletClient({ account: relayer, chain: pub.chain, transport: http(opts.rpc || net.rpc) });
    txHash = await wallet.writeContract({ address: opts.arbitrator, abi: ARBITRATOR_ABI, functionName: "resolve",
      args: [signed.ruling, signed.signature] });
    const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") throw new Error(`resolve reverted (${txHash})`);
  }

  const record = {
    kind: "judge-protocol/arcbounty-arbitration@1",
    network: signed.network, chainId: signed.chainId, adapter: signed.adapter, arbitrator: signed.arbitrator, jobId: signed.jobId,
    pass: signed.pass, score: signed.score, rulingHash: signed.rulingHash, rulingCid: signed.ruling.rulingCid,
    ruling: Object.fromEntries(Object.entries(signed.ruling).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])),
    digest: signed.digest, signer: signed.signer, signature: signed.signature, relayed: txHash !== null, txHash,
  };
  if (opts.out) await writeFile(opts.out, JSON.stringify(record, null, 2) + "\n");
  return { record };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runArbitrateCli(process.argv.slice(2))
    .then(({ record }) => console.log(JSON.stringify(record, null, 2)))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
