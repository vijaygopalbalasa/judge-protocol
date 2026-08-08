// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/JudgeEvaluator.sol";
import "../src/JudgeReputationHook.sol";

/// @notice Deploys the Judge protocol against the canonical Arc ACP. Chain-agnostic:
///         point ACP_ADDRESS at the testnet or mainnet ACP and broadcast to that chain.
///         Env: ACP_ADDRESS, GUARDIAN, SIGNER, REPUTATION (opt).
contract Deploy is Script {
    function run() external {
        address acp = vm.envAddress("ACP_ADDRESS");
        address guardian = vm.envAddress("GUARDIAN");
        address signer = vm.envAddress("SIGNER");
        address reputation = vm.envOr("REPUTATION", address(0));

        vm.startBroadcast();

        address[] memory signers = new address[](1);
        signers[0] = signer;
        JudgeEvaluator judge = new JudgeEvaluator(acp, guardian, signers);
        console2.log("JudgeEvaluator:", address(judge));

        JudgeReputationHook hook = new JudgeReputationHook(acp, reputation);
        console2.log("JudgeReputationHook:", address(hook));

        vm.stopBroadcast();
    }
}
