# ERC-8183 escrow for chains that have none

`AgenticCommerce.sol` and `interfaces/IACPHook.sol` are copied unchanged from ArcBounty's repository,
https://github.com/Sofiia7/ARC at commit `ef5d100882a4bfe475c685586902ecc72da420e8`
(`contracts/src/base/`). `AgenticCommerce.sol` is MIT (see `LICENSE`, Copyright (c) 2026 ArcBounty
Contributors); `IACPHook.sol` is CC0-1.0, as its header says.

This is the escrow code Circle runs on Arc testnet (`0x0747EEf0706327138c69792bF28Cd525089e4583`) and the
code ArcBounty runs on Arc mainnet (`0x64cA39Fc57315D0D488acCaC07c37C6E841CD058`), which JudgeEvaluator
serves. It is an older version of the ERC-8183 reference implementation, not the current one: its own header
explains the difference. JudgeEvaluator reads this contract's `Job` layout unchanged.

It is here so Judge can run on a chain that has no ERC-8183 escrow of its own: deploy it behind an
`ERC1967Proxy`, call `initialize(paymentToken, treasury, admin)`, and whitelist any hook with
`setHookWhitelist`. Fees start at 0.

sha256 at copy time:
- `AgenticCommerce.sol` `98586787d67da201c8f63efcfad3f87f0a5170f5f08daf74088f037a0640ca9a`
- `interfaces/IACPHook.sol` `fba2717e6cea7dfa71ca010d8bb71bd376cac0db6d98892c2a7a926363f025ad`
