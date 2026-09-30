# ERC-8004 registries (tests only)

`IdentityRegistryUpgradeable.sol` and `ReputationRegistryUpgradeable.sol` are copied unchanged from https://github.com/erc-8004/erc-8004-contracts at commit
`b9e466c250744a7e06b13dff9d3c2844ed64f825` (`contracts/`). Each file carries `SPDX-License-Identifier: MIT`;
that repository has no separate LICENSE file.

Both registries report `getVersion()` = "2.0.0", the version deployed at IdentityRegistry
`0x8004A818BFB912233c491871b3d84c89A494BD9e` and ReputationRegistry `0x8004B663056A597Dffe9eCcC1965A193B7388713`
(implementation `0x16e0fa7f7c56b9a767e34b192b51f921be31da34`) on Monad testnet, Arbitrum Sepolia, Base Sepolia,
Celo Sepolia and Arc testnet (read from each chain on 2026-09-30). JudgeReputationHookV2's tests run against it, so the
hook is checked against the registry as deployed, not against a mock of it. Not deployed by this repo.

sha256 at copy time:
- `IdentityRegistryUpgradeable.sol` `18c8ca8c88493b46e54d000c96eaf7470d1f9dbfe55493fd7fa923bae543ff75`
- `ReputationRegistryUpgradeable.sol` `9063eba192391c3e6959edcad452184f07a6c1b3975391e7c4d77dbf1eaabf09`

Their proxies start on a placeholder implementation (`MinimalUUPS.sol` in that repository) whose initializer sets
the owner; the owner then upgrades to the real registry and calls its `reinitializer(2)` initialize. MinimalUUPS
calls `__UUPSUpgradeable_init`, which OpenZeppelin removed after 5.4 (that repository builds with ^5.4.0), so the
tests use `test/helpers/Erc8004Placeholder.sol`, which does the same thing against this repo's 5.7.0.
