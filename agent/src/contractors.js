// Scripted contractor agents for the demo. Each has its own wallet and acts
// only through the chain: it quotes the price (setBudget), waits to be funded,
// then submits. "careful" checks its own draft with the judge's dry run and
// revises until it passes (or declines to submit); "sloppy" never checks.
// Their writing is scripted in the brief (milestone.demoWork): the agent under
// test here is the paymaster, not these writers.
import * as defaultKit from "../../kit/judge-kit.js";

export function scriptedContractor({ name, style, wallet, publicClient, dryRun = defaultKit.dryRun, kit = defaultKit, log = () => {} }) {
  return {
    name,
    async onOffer({ jobId, amount, criteria, milestone }) {
      await kit.setBudget({ walletClient: wallet, publicClient, jobId, amount });
      log(`${name} quoted ${Number(amount) / 1e6} USDC for job ${jobId}`);
      return async function afterFunded() {
        const work = milestone.demoWork || {};
        if (style === "sloppy") {
          await kit.submitDeliverable({ walletClient: wallet, publicClient, jobId, content: work.bad ?? work.good, mediaType: "text/plain" });
          log(`${name} submitted without checking`);
          return;
        }
        for (const [label, content] of [["draft", work.draft], ["revision", work.good]]) {
          if (content === undefined) continue;
          const r = await dryRun({ criteria, content });
          if (r.pass) {
            log(`${name}: dry run passed on the ${label} (score ${r.score}), submitting`);
            await kit.submitDeliverable({ walletClient: wallet, publicClient, jobId, content, mediaType: work.mediaType ?? "text/plain" });
            return;
          }
          log(`${name}: dry run failed on the ${label} (score ${r.score}), revising`);
        }
        log(`${name}: no version passed its own dry run, so it does not submit`);
      };
    },
  };
}
