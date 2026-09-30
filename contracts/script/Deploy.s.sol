// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/JudgeEvaluator.sol";

/// @notice Deploys JudgeEvaluator against an ERC-8183 escrow with Circle's Job layout, as on Arc testnet in August 2026
///         (broadcast/Deploy.s.sol/5042002). That run also deployed the first reputation hook, which was written
///         against an earlier ERC-8004 draft and has since been removed from this repo; JudgeReputationHookV2 and
///         script/DeployKit.s.sol replace it.
///         Env: ACP_ADDRESS, GUARDIAN, SIGNER.
contract Deploy is Script {
    function run() external {
        address acp = vm.envAddress("ACP_ADDRESS");
        address guardian = vm.envAddress("GUARDIAN");
        address signer = vm.envAddress("SIGNER");

        vm.startBroadcast();

        address[] memory signers = new address[](1);
        signers[0] = signer;
        JudgeEvaluator judge = new JudgeEvaluator(acp, guardian, signers);
        console2.log("JudgeEvaluator:", address(judge));

        vm.stopBroadcast();
    }
}
