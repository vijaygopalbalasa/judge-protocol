// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/bnb/JudgeRouter.sol";
import "../src/bnb/JudgeDeterministicPolicy.sol";
import "../src/interfaces/IBnbCommerce.sol";

/// @notice Puts Judge on BNB Chain's ERC-8183 kernel (bnbagent-sdk): a JudgeRouter of our own, and one
///         JudgeDeterministicPolicy whitelisted on it, on top of the official kernel, unchanged. An SDK user
///         points at them with ERC8183_ROUTER_ADDRESS and ERC8183_POLICY_ADDRESS; no permission from BNB is needed.
///
///         Env, all BNB_-prefixed so no other deployment's values can be picked up by mistake:
///           BNB_CHAIN_ID    56 (BSC mainnet) or 97 (BSC testnet); checked before anything is sent
///           BNB_COMMERCE    the kernel proxy (mainnet 0xea4daa3100a767e86fded867729ae7446476eba6,
///                           testnet 0xa206c0517b6371c6638cd9e4a42cc9f02a33b0de); its Job layout is checked
///           BNB_OWNER       the broadcasting wallet (checked after the deploy)
///           BNB_GUARDIAN    pauses the policy; must differ from the signer
///           BNB_SIGNER      the verdict key
///         Simulate first, then broadcast:
///           forge script script/DeployBnb.s.sol --rpc-url $RPC
///           forge script script/DeployBnb.s.sol --rpc-url $RPC --broadcast --private-key $KEY
contract DeployBnb is Script {
    struct Deployed {
        address commerce;
        address router;
        address policy;
    }

    function run() external returns (Deployed memory d) {
        uint256 chainId = vm.envUint("BNB_CHAIN_ID");
        address commerce = vm.envAddress("BNB_COMMERCE");
        address owner = vm.envAddress("BNB_OWNER");
        address guardian = vm.envAddress("BNB_GUARDIAN");
        address signer = vm.envAddress("BNB_SIGNER");

        require(block.chainid == chainId, "not the chain in BNB_CHAIN_ID");
        require(chainId == 56 || chainId == 97, "BNB_CHAIN_ID must be 56 or 97");
        require(owner != address(0) && guardian != address(0) && signer != address(0), "BNB_ roles are required");
        require(guardian != signer, "the guardian must not be the verdict key");
        _requireBnbLayout(commerce);

        address[] memory signers = new address[](1);
        signers[0] = signer;

        vm.startBroadcast();
        JudgeRouter router = new JudgeRouter(commerce);
        JudgeDeterministicPolicy policy = new JudgeDeterministicPolicy(address(router), commerce, guardian, signers);
        router.setPolicyWhitelist(address(policy), true);
        vm.stopBroadcast();

        require(address(router.commerce()) == commerce, "router commerce");
        require(router.policyWhitelist(address(policy)), "policy whitelist");
        require(router.owner() == owner, "the router's owner is not BNB_OWNER: broadcast from that wallet");
        require(policy.owner() == owner, "policy owner");
        require(policy.router() == address(router) && policy.commerce() == commerce, "policy wiring");
        require(policy.guardian() == guardian && policy.isSigner(signer) && !policy.paused(), "policy roles");

        d = Deployed({commerce: commerce, router: address(router), policy: address(policy)});
        console2.log("chain:", block.chainid);
        console2.log("kernel:", commerce);
        console2.log("JudgeRouter:", address(router));
        console2.log("JudgeDeterministicPolicy:", address(policy));
    }

    /// @dev BNB's Job struct has 11 fields: the description offset in getJob(1)'s raw words is 0x160, not Circle's
    ///      0x120. A kernel with another layout is refused before anything is sent.
    function _requireBnbLayout(address commerce) internal view {
        require(commerce.code.length > 0, "no code at BNB_COMMERCE");
        (bool ok, bytes memory ret) = commerce.staticcall(abi.encodeCall(IBnbCommerce.getJob, (1)));
        require(ok && ret.length >= 12 * 32, "getJob(1) failed");
        (uint256 tupleOffset, uint256 id,,,, uint256 descriptionOffset) =
            abi.decode(ret, (uint256, uint256, uint256, uint256, uint256, uint256));
        require(tupleOffset == 0x20 && id == 1 && descriptionOffset == 0x160, "the kernel's getJob does not have BNB's Job layout");
    }
}
