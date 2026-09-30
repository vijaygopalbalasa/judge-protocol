# Running Judge on another EVM chain

Judge runs on Arc. On a chain with no ERC-8183 escrow, `contracts/script/DeployKit.s.sol` puts up the whole
stack in one script:

1. a payment token: an existing one (`KIT_TOKEN`), or `TestDollar`, a no-value test token named
   "Judge Test Dollar (no value)" that anyone can mint;
2. the ERC-8183 escrow Judge serves on Arc (`contracts/vendor/erc8183-escrow`, ArcBounty's MIT copy of the code
   Circle runs on Arc testnet), behind an ERC1967 proxy, fees 0;
3. `JudgeEvaluator`, unchanged;
4. `JudgeReputationHookV2`, if the chain has the ERC-8004 registries, whitelisted on the escrow. It records each
   verdict as ERC-8004 feedback for the provider's agent.

The wallet that broadcasts becomes the escrow's admin (upgrades, fees, hook whitelist). That is fine for a demo;
hand it to a multisig for anything more.

## Deploy

```bash
cd contracts
export KIT_CHAIN_ID=<chain id> KIT_OWNER=<broadcasting wallet> KIT_GUARDIAN=<pause key> KIT_SIGNER=<verdict key>
forge script script/DeployKit.s.sol --rpc-url $RPC                                       # simulate
forge script script/DeployKit.s.sol --rpc-url $RPC --broadcast --private-key $DEPLOYER_KEY
```

Optional: `KIT_TOKEN` (use this token instead of TestDollar), `KIT_ESCROW` (use an existing escrow with Circle's
Job layout; the script checks it), `KIT_IDENTITY` and `KIT_REPUTATION` (ERC-8004 registries; by default the
canonical addresses are used when they have code on the chain). The script refuses the wrong chain, a guardian
equal to the signer, and addresses without code, and it reads every role back after deploying.

## Run the judge against it

The judge service is configured by environment (the RPC variable keeps its old name):

```bash
cd judge-service
export ARC_RPC_URL=$RPC CHAIN_ID=<chain id> ACP_ADDRESS=<escrow> JUDGE_ADDRESS=<JudgeEvaluator>
export JUDGE_SIGNER_KEY=<verdict key> JUDGE_RELAYER_KEY=<a funded key>
npm start
```

One judged job end to end, with the hook attached (`CLIENT_KEY` holds the token, both keys hold gas):

```bash
E2E_TOKEN=<token> E2E_HOOK=<JudgeReputationHookV2> CLIENT_KEY=... PROVIDER_KEY=... node src/e2e.js --judge-now
```

## Reputation

A provider links its wallet to its ERC-8004 agent once; it must own or operate the agent, or be its verified
wallet:

```bash
cast send <JudgeReputationHookV2> "linkAgent(uint256)" <agentId> --private-key $PROVIDER_KEY
```

A job counts for the agent if it is funded while the wallet is linked, names the JudgeEvaluator as evaluator, has
a budget and the hook attached, and its client is not the provider. Its verdict is then counted whatever happens to the link
later, and written to the ReputationRegistry: value 100 for PASS and 0 for REJECT, tag1 `judge-verdict`, tag2 `pass`
or `reject`, and the verdict's evidence hash as the feedback hash. A job with no budget never
counts, even when funded. The average over this hook's feedback is the agent's pass rate:

```bash
cast call <ReputationRegistry> "getSummary(uint256,address[],string,string)(uint64,int128,uint8)" \
  <agentId> "[<JudgeReputationHookV2>]" judge-verdict ""
```

The hook also keeps its own count, `tally(agentId)` (passes, rejects, and how many the registry did not take). The
registry refuses feedback from an operator of the agent, so an owner who approves the hook can keep a verdict out of
the registry, but not out of the tally. Only the judge's own verdicts are counted: a client cancelling an open job,
or grading its own job, writes nothing. A registry failure never blocks a payout. A verdict shows the delivery met
the client's criteria, not that the criteria were demanding, so weigh this feedback by who the clients were.

## Rehearse first

Rehearse on a local fork before spending real gas: `anvil --fork-url $RPC`, then the same commands against
`http://127.0.0.1:8545` with fresh keys funded through `anvil_setBalance`. Do not use anvil's default accounts on
a fork of a public testnet: their keys are public, and those addresses carry EIP-7702 delegations on Monad
testnet, Arbitrum Sepolia, Base Sepolia and Celo Sepolia (checked 2026-09-30); on Monad testnet that code forwards
whatever it receives, so an agent NFT minted to one of them fails. Delete `contracts/broadcast/DeployKit.s.sol`
after a rehearsal so fork receipts are never committed.
