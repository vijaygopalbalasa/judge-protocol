# Judge Protocol — Arc Testnet Wallets

## Owner / Guardian (YOUR wallet — controls the protocol)
| Role | Address |
|------|---------|
| **Guardian / Owner** | `0x427C62eDCae20DDc8c5e875De39D4E4845491458` — funded 20 USDC ✅ |

The guardian can pause the judge, rotate/revoke verdict signers, and administer the
deployed contracts. Only the **address** is used — its private key never touches this repo.

## Service keys (throwaway, generated 2026-08-07 — testnet only, keys in gitignored `.env`)
| Role | Address | Purpose | Needs funding |
|------|---------|---------|---------------|
| Deployer | `0xf629006403580E2A7d94B666daA8374353a1d368` | pays gas to publish contracts | **~5 USDC** |
| Verdict signer | `0xACD5a92c2bD5B5D30A91A49190936dCf85Dfe200` | signs + submits verdicts on-chain | **~3 USDC** |
| Test client | `0xA3f1b2503838fc061af842eD2C719559E12ad973` | creates + escrows e2e test jobs | **~5 USDC** (2×2 USDC escrow + gas) |
| Test provider | `0x5e14c9E5278ee370D764d03d314e92B3d9fFC04F` | submits deliverables | **~2 USDC** |

## How to fund (from your wallet, MetaMask on Arc Testnet)
Send plain USDC transfers from `0x427C…1458` to each address above (amounts in the
table — ~15 USDC total of your 20). Gas on Arc is ~$0.005/tx, so these amounts are
generous. Alternatively each address can be funded at https://faucet.circle.com
(rate-limited to ~1 request/address/day).

> Old throwaway wallets (0xd079…, 0x3943…, 0x3252… from the v1 draft) are retired —
> never funded, safe to ignore.

## After funding
```
cd judge-protocol && forge script script/Deploy.s.sol --broadcast --rpc-url $ARC_RPC_URL   # deploy
cd ../judge-service && node src/index.js   # start judge service
node src/e2e.js                            # real judged job end-to-end (PASS + REJECT paths)
```
