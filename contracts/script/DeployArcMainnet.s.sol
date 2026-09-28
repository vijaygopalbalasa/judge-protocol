// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/JudgeEvaluator.sol";
import "../src/interfaces/IACP.sol";

/// @notice Deploys JudgeEvaluator on Arc mainnet against an ERC-8183 escrow with Circle's Job layout.
///         Circle has no ERC-8183 escrow on Arc mainnet; the default is the reference implementation
///         ArcBounty deployed (0x64cA39Fc..., open to any client, fees 0), tested in
///         test/ArcMainnetFork.t.sol. No hook is deployed: that escrow whitelists none.
///         Env, all MAINNET_-prefixed so the testnet values forge loads from .env (ACP_ADDRESS, GUARDIAN,
///         SIGNER) can never be picked up by mistake: MAINNET_GUARDIAN (pauses), MAINNET_SIGNER (the verdict
///         key), MAINNET_OWNER (the broadcasting wallet, asserted after the deploy), MAINNET_ACP_ADDRESS (opt).
///         Simulate first, then broadcast with the deployer key:
///           forge script script/DeployArcMainnet.s.sol --rpc-url https://rpc.mainnet.arc.io
///           forge script script/DeployArcMainnet.s.sol --rpc-url https://rpc.mainnet.arc.io --broadcast --private-key $KEY
contract DeployArcMainnet is Script {
    uint256 constant ARC_MAINNET = 5042;
    address constant ARCBOUNTY_ESCROW = 0x64cA39Fc57315D0D488acCaC07c37C6E841CD058;

    function run() external returns (JudgeEvaluator judge) {
        address acp = vm.envOr("MAINNET_ACP_ADDRESS", ARCBOUNTY_ESCROW);
        address guardian = vm.envAddress("MAINNET_GUARDIAN");
        address signer = vm.envAddress("MAINNET_SIGNER");
        address expectedOwner = vm.envAddress("MAINNET_OWNER");

        // Before broadcasting: the right chain, a deployed escrow, and a Job layout we can read.
        require(block.chainid == ARC_MAINNET, "not Arc mainnet");
        require(acp.code.length > 0, "no escrow at MAINNET_ACP_ADDRESS");
        require(guardian != address(0) && signer != address(0), "MAINNET_GUARDIAN and MAINNET_SIGNER are required");
        require(guardian != signer, "the guardian must not be the verdict key");
        // Circle's layout returns (id, client, provider, evaluator, description, ...): after the tuple offset,
        // the first word is the id and the fifth is the description's offset (nine head words, 0x120).
        // Check the shape on the raw words first, since decoding another layout panics instead of failing.
        (bool ok, bytes memory ret) = acp.staticcall(abi.encodeCall(IACP.getJob, (1)));
        require(ok && ret.length >= 10 * 32, "getJob(1) failed");
        (uint256 tupleOffset, uint256 id,,,, uint256 descriptionOffset) =
            abi.decode(ret, (uint256, uint256, uint256, uint256, uint256, uint256));
        require(
            tupleOffset == 0x20 && id == 1 && descriptionOffset == 0x120,
            "the escrow's getJob does not have Circle's Job layout"
        );
        require(abi.decode(ret, (IACP.Job)).id == 1, "getJob(1) does not decode");

        address[] memory signers = new address[](1);
        signers[0] = signer;
        vm.startBroadcast();
        judge = new JudgeEvaluator(acp, guardian, signers);
        vm.stopBroadcast();

        // After: every role reads back as intended.
        require(address(judge.acp()) == acp, "acp");
        require(judge.guardian() == guardian, "guardian");
        require(judge.isSigner(signer), "signer");
        require(!judge.paused(), "paused");
        require(judge.owner() == expectedOwner, "the owner is not MAINNET_OWNER: broadcast from that wallet");
        require(judge.pendingOwner() == address(0), "pending owner");
        console2.log("JudgeEvaluator:", address(judge));
        console2.log("escrow:", acp);
        console2.log("owner and guardian:", judge.owner(), judge.guardian());
    }
}
