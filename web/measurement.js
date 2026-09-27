// The market measurement shown on the page. Source of truth:
// judge-service/acp-measurement.json (web/test/copy.test.mjs keeps these in
// sync). Reproduce with: node judge-service/src/measure-acp.js 2500
// Counts of addresses and jobs are counts INSIDE the sample, not totals for
// the whole contract, and are labeled that way.
export const MEASURED = [
  ['Sample (Aug 7, 2026)', '2,524 of 171,593 jobs', 'every 68th job id on the canonical contract; counts below are inside this sample'],
  ['Self-evaluated jobs', '70.6% ± 1.8pp', 'the party paying also decides whether the work passed'],
  ['Delegate to a third party', '29.4% ± 1.8pp', '247 distinct evaluator addresses within the sample'],
  ['Third-party evaluators paid through', '54 addresses, 281 jobs (sample)', 'sample counts, not contract-wide totals; delegated evaluation already settles testnet escrow'],
  ['Rejection rate', '1.56% of decided jobs', 'the reject path is barely exercised in the wild'],
  ['Jobs using any hook', '0 of 2,524', 'no sampled job used a hook; of the hook addresses we checked, address(0) is the only one whitelisted'],
  ['Median funded budget', '1.00 USDC', 'why percentage fees cannot work at this job size'],
];
