// The paymaster's wallet, reduced to four capabilities, each used only after
// the policy authorized it:
//   createJob  naming Judge Protocol as the evaluator
//   approve    USDC to the escrow contract, for an authorized amount
//   fund       an authorized job whose on-chain state still matches
//   claimRefund on the paymaster's own expired jobs (money back is always safe)
// Nothing else goes through: no transfer to anyone, no complete or reject. The
// only way a contractor gets paid is the judge releasing the escrow.
export function guardWallet(walletClient, { publicClient, acp, usdc, judge, abi }) {
  const ACP = acp.toLowerCase(), USDC = usdc.toLowerCase(), JUDGE = judge.toLowerCase();
  const me = walletClient.account.address.toLowerCase();
  let creates = 0;
  const funds = new Map(); // jobId -> authorized amount
  const approved = new Set(); // jobIds whose approve went through
  const refuse = (why) => { throw new Error(`refused: ${why}`); };
  const readJob = (jobId) => publicClient.readContract({ address: acp, abi, functionName: "getJob", args: [BigInt(jobId)] });

  return {
    account: walletClient.account,
    chain: walletClient.chain,
    allowCreate() { creates++; },
    allowFund(jobId, amount) { funds.set(String(jobId), BigInt(amount)); },
    async sendTransaction() { refuse("the paymaster never sends raw transactions"); },
    async writeContract(req) {
      const to = String(req.address).toLowerCase(), fn = req.functionName, args = req.args || [];
      if (to === ACP && fn === "createJob") {
        if (creates < 1) refuse("createJob was not authorized by policy");
        creates--; // any attempt uses the authorization, so an anomaly forces a fresh policy decision
        if (String(args[1]).toLowerCase() !== JUDGE) refuse("a job must name Judge Protocol as its evaluator");
        return walletClient.writeContract(req);
      }
      if (to === USDC && fn === "approve") {
        if (String(args[0]).toLowerCase() !== ACP) refuse("USDC may only be approved to the escrow contract");
        const match = [...funds.entries()].find(([id, amt]) => amt === BigInt(args[1]) && !approved.has(id));
        if (!match) refuse("this approval was not authorized by policy");
        approved.add(match[0]);
        return walletClient.writeContract(req);
      }
      if (to === ACP && fn === "fund") {
        const id = String(args[0]);
        if (!funds.has(id) || !approved.has(id)) refuse("funding this job was not authorized by policy");
        const agreed = funds.get(id);
        funds.delete(id); approved.delete(id); // one attempt per authorization
        const job = await readJob(id);
        if (String(job.evaluator).toLowerCase() !== JUDGE) refuse("the job does not name Judge Protocol");
        if (String(job.client).toLowerCase() !== me) refuse("the job is not the paymaster's own");
        if (BigInt(job.budget) !== agreed) refuse(`the job's budget changed to ${job.budget}; not what was agreed`);
        return walletClient.writeContract(req);
      }
      if (to === ACP && fn === "claimRefund") {
        const job = await readJob(args[0]);
        if (String(job.client).toLowerCase() !== me) refuse("only the paymaster's own escrow can be reclaimed");
        return walletClient.writeContract(req);
      }
      refuse(`the paymaster never calls ${fn} on ${req.address}`);
    },
  };
}
