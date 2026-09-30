// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/JudgeArbitrator.sol";
import "../src/interfaces/IBountyAdapter.sol";

/// @notice Deploys JudgeArbitrator for one ArcBounty BountyAdapter. The adapter's current arbitrator must be the
///         principal, so the principal can hand the role over (transferArbitrator, then acceptRole) and take it back.
///         The signer is set in the constructor: a signer added later waits SIGNER_DELAY.
///
///         Env, all ARB_-prefixed so values forge loads from .env can never be picked up by mistake:
///           ARB_CHAIN_ID    the chain this must run on (checked before anything is sent)
///           ARB_ADAPTER     ArcBounty's BountyAdapter
///           ARB_PRINCIPAL   the adapter's arbitrator today (ArcBounty's key or Safe)
///           ARB_SIGNER      the Judge key that signs rulings
///           ARB_OWNER       the broadcasting wallet (checked after the deploy)
///         Simulate first, then broadcast:
///           forge script script/DeployArbitrator.s.sol --rpc-url $RPC
///           forge script script/DeployArbitrator.s.sol --rpc-url $RPC --broadcast --private-key $KEY
contract DeployArbitrator is Script {
    function run() external returns (JudgeArbitrator arb) {
        uint256 chainId = vm.envUint("ARB_CHAIN_ID");
        address adapter = vm.envAddress("ARB_ADAPTER");
        address principal = vm.envAddress("ARB_PRINCIPAL");
        address signer = vm.envAddress("ARB_SIGNER");
        address owner = vm.envAddress("ARB_OWNER");

        // Before broadcasting.
        require(block.chainid == chainId, "not the chain in ARB_CHAIN_ID");
        require(adapter.code.length > 0, "no adapter at ARB_ADAPTER");
        require(IBountyAdapter(adapter).arbitrator() == principal, "ARB_PRINCIPAL is not the adapter's arbitrator");
        (bool ok, bytes memory ret) = adapter.staticcall(abi.encodeWithSignature("MAX_CID_LEN()"));
        require(ok && ret.length == 32 && abi.decode(ret, (uint256)) == 96, "the adapter's CID bound is not 96");
        require(signer != address(0) && signer != principal && signer != owner, "the signer must be its own key");

        address[] memory signers = new address[](1);
        signers[0] = signer;
        vm.startBroadcast();
        arb = new JudgeArbitrator(adapter, principal, signers);
        vm.stopBroadcast();

        // After: every role reads back as intended.
        require(address(arb.adapter()) == adapter, "adapter");
        require(arb.principal() == principal, "principal");
        require(arb.isActiveSigner(signer), "signer");
        require(arb.owner() == owner, "the owner is not ARB_OWNER: broadcast from that wallet");
        require(!arb.paused() && !arb.handingBack(), "state");
        console2.log("JudgeArbitrator:", address(arb));
        console2.log("adapter:", adapter);
        console2.log("principal:", principal);
    }
}
