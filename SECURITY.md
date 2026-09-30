# Security

Judge Protocol signs verdicts that release or refund escrowed USDC, so security
reports matter even on testnet.

## Report a vulnerability

Please report privately through GitHub: open the repository's **Security** tab and
choose **Report a vulnerability**. Do not open a public issue for a security bug.
Include the affected file or endpoint, the steps to reproduce, and the impact you
expect.

## Scope

- The contracts in `contracts/src` (JudgeEvaluator, JudgeArbitrator, JudgeAttestor, JudgeReputationHookV2)
- The hosted judge and its API (`judge-service/`), including the x402 paid path
- The verifier (`web/`) and the kit (`kit/`)
- The paymaster agent (`agent/`)

## What to know first

- Arc testnet only. Nothing here is audited.
- The hosted judge's signing and relaying keys are testnet keys held by the
  operator; the contract accepts verdicts only from allowlisted signers, and a
  guardian can pause it.
- The known limits are listed in `docs/INTEGRATION.md` under "Limits, stated plainly".
