Measured 2026-10-23 on forks of Arc testnet (block 68690705), Arc mainnet (block 27454657) and Base (block 52984844).

| Rule | Level | ERC reference code | Circle, Arc testnet | ArcBounty, Arc mainnet | G2 Jobs, Arc mainnet | Virtuals V3, Base |
| --- | --- | --- | --- | --- | --- | --- |
| createJob opens an Open job with client = caller | SHALL | pass | pass | pass | pass | pass |
| createJob reverts if the evaluator is zero | SHALL | pass | pass | pass | pass | FAIL: a zero evaluator was accepted |
| createJob reverts unless expiredAt is in the future | SHALL | pass | pass | pass | pass | pass |
| setProvider: client only, once, never zero (when a job may start without one) | SHALL | pass | pass | pass | pass | pass |
| fund reverts while the provider is unset | SHALL | pass | pass | pass | pass | pass |
| setBudget may be called by the client | SHALL | FAIL: setBudget by the client reverts | FAIL: setBudget by the client reverts | FAIL: setBudget by the client reverts | pass | FAIL: setBudget by the client reverts |
| setBudget may be called by the provider | SHALL | pass | pass | pass | pass | pass |
| setBudget reverts for anyone else | SHALL | pass | pass | pass | pass | pass |
| setBudget reverts once the job is not Open | SHALL | pass | pass | pass | pass | pass |
| fund reverts unless the caller is the client | SHALL | pass | pass | pass | pass | pass |
| fund reverts if the budget is zero | SHALL | FAIL: a zero-budget job was funded | FAIL: a zero-budget job was funded | FAIL: a zero-budget job was funded | pass | FAIL: a zero-budget job was funded |
| fund reverts if budget != expectedBudget (front-running guard) | SHALL | FAIL: funded although expectedBudget differs from the budget | FAIL: funded although expectedBudget differs from the budget | FAIL: funded although expectedBudget differs from the budget | pass | pass |
| fund pulls exactly the budget into escrow and sets Funded | SHALL | pass | pass | pass | pass | pass |
| fund reverts unless the job is Open | SHALL | pass | pass | pass | pass | pass |
| submit reverts unless the caller is the provider | SHALL | pass | pass | pass | pass | pass |
| submit reverts unless the job is Funded | SHALL | FAIL: work was submitted on an unfunded job with no budget | FAIL: work was submitted on an unfunded job with no budget | FAIL: work was submitted on an unfunded job with no budget | pass | FAIL: work was submitted on an unfunded job with no budget |
| submit sets Submitted and emits the deliverable | SHALL | pass | pass | pass | pass | pass |
| complete reverts unless the caller is the evaluator | SHALL | pass | pass | pass | pass | pass |
| complete reverts unless the job is Submitted | SHALL | pass | pass | pass | pass | pass |
| complete pays the provider (fees only on completion) | SHALL | pass | pass | pass | pass | pass |
| reject of an Open job: client only | SHALL | pass | pass | pass | pass | FAIL: the provider rejected an Open job |
| reject of a Funded job: evaluator only, full refund | SHALL | pass | pass | pass | pass | pass |
| reject of a Submitted job: evaluator only, full refund | SHALL | pass | pass | pass | pass | pass |
| claimRefund reverts before expiredAt | SHALL | pass | pass | pass | pass | pass |
| claimRefund of a Funded job at expiredAt refunds in full | SHALL | pass | pass | pass | pass | pass |
| claimRefund of a Submitted job at expiredAt refunds in full | SHALL | pass | pass | pass | FAIL: claimRefund of submitted work at expiredAt reverts | FAIL: claimRefund of submitted work at expiredAt reverts |
| claimRefund reverts unless the job is Funded or Submitted | SHALL | pass | pass | pass | pass | FAIL: an Open job was refunded |
| Completed is terminal, and its money moves once | SHALL | pass | pass | pass | pass | pass |
| Rejected and Expired are terminal, and their money moves once | SHALL | pass | pass | pass | pass | pass |
| anyone may trigger a refund after expiry | RECOMMENDED | pass | pass | pass | pass | pass |
| SHALL rules passed |  | 25/29 | 25/29 | 25/29 | 28/29 | 22/29 |
