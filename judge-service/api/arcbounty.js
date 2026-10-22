// GET /api/arcbounty?jobId=18&network=arc-mainnet
//   The score for the latest submission on an ArcBounty bounty whose description carries a judge-criteria
//   block: the same answer `node src/arcbounty.js <jobId> --network <network>` prints, computed from the
//   adapter's record, the escrow's commitment and the pinned IPFS files. Keyless and read-only: it never
//   signs, settles or writes. Answers (HTTP 200): "ruled" (ruling.score, ruling.pass, ruling.criteriaHash,
//   ruling.rulingHash and each check's result), "no-submission", or "abstained" with the reason no ruling is
//   possible. A job id that is not an ArcBounty bounty is a 404; a chain or IPFS read failure is a 503.
//   Only a job id and a known network are taken from the caller: never an RPC, a file or a gateway.
import { runCli, ARCBOUNTY_NETWORKS } from "../src/arcbounty.js";
import { cors } from "../src/vercel-util.js";

const PARAMS = new Set(["jobId", "network"]);
// A settled submission's score never changes; one still under review only changes its reviewer decision.
const CACHE_OK = "public, s-maxage=300, stale-while-revalidate=3600";

const plain = (o) => JSON.parse(JSON.stringify(o, (_, x) => (typeof x === "bigint" ? x.toString() : x)));

export function createArcbountyHandler({ run = runCli } = {}) {
  return async function handler(req, res) {
    cors(res);
    if (req.method === "OPTIONS") { res.status(204).end(); return; }
    if (req.method !== "GET") { res.status(405).json({ error: "use GET" }); return; }
    const q = req.query || {};
    const unknown = Object.keys(q).find((k) => !PARAMS.has(k));
    if (unknown !== undefined) {
      res.status(400).json({ error: `unknown parameter ${JSON.stringify(unknown)} (use jobId and network)` });
      return;
    }
    const jobId = q.jobId;
    if (typeof jobId !== "string" || !/^[0-9]{1,30}$/.test(jobId) || BigInt(jobId) === 0n) {
      res.status(400).json({ error: "jobId must be a positive whole number" });
      return;
    }
    const network = q.network === undefined ? "arc-mainnet" : q.network;
    if (typeof network !== "string" || !Object.hasOwn(ARCBOUNTY_NETWORKS, network)) {
      res.status(400).json({ error: `network must be one of ${Object.keys(ARCBOUNTY_NETWORKS).join(", ")}` });
      return;
    }
    let out;
    try {
      out = await run([jobId, "--network", network]);
    } catch (e) {
      if (/is not an ArcBounty bounty/.test(String(e?.message))) {
        res.setHeader("cache-control", "public, s-maxage=60");
        res.status(404).json({ status: "not-found", jobId: BigInt(jobId).toString(), network, error: `job ${BigInt(jobId)} is not an ArcBounty bounty on ${network}` });
        return;
      }
      res.status(503).json({ error: "could not read the chain or IPFS right now; try again shortly", jobId: BigInt(jobId).toString(), network });
      return;
    }
    res.setHeader("cache-control", CACHE_OK);
    res.status(200).json(plain(out.result));
  };
}

export default createArcbountyHandler();
