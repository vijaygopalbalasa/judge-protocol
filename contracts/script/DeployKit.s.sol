// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../src/JudgeEvaluator.sol";
import "../src/JudgeReputationHookV2.sol";
import "../src/interfaces/IACP.sol";
import "../src/mocks/TestDollar.sol";
import {AgenticCommerce} from "../vendor/erc8183-escrow/AgenticCommerce.sol";

/// @notice Puts Judge on an EVM chain that has no ERC-8183 escrow: a token (an existing one, or a no-value test
///         dollar), the escrow Judge serves on Arc (vendor/erc8183-escrow, behind an ERC1967 proxy, fees 0), the
///         unchanged JudgeEvaluator, and, where the chain has the ERC-8004 registries, JudgeReputationHookV2,
///         whitelisted on the escrow. The broadcasting wallet becomes the escrow's admin (upgrades, fees, hook
///         whitelist): fine for a demo, hand it to a multisig for anything more.
///
///         Env, all KIT_-prefixed so the testnet values forge loads from .env can never be picked up by mistake:
///           KIT_CHAIN_ID    the chain this must run on (checked before anything is sent)
///           KIT_OWNER       the broadcasting wallet (checked after the deploy)
///           KIT_GUARDIAN    pauses the judge; must differ from the signer
///           KIT_SIGNER      the verdict key
///           KIT_TOKEN       (opt) the escrow's payment token; unset deploys a TestDollar
///           KIT_ESCROW      (opt) an existing escrow with Circle's Job layout; unset deploys one
///           KIT_IDENTITY, KIT_REPUTATION  (opt) ERC-8004 registries; unset uses the canonical addresses when they
///                           have code on this chain, and skips the hook when they do not
///         Simulate first, then broadcast:
///           forge script script/DeployKit.s.sol --rpc-url $RPC
///           forge script script/DeployKit.s.sol --rpc-url $RPC --broadcast --private-key $KEY
contract DeployKit is Script {
    // The same addresses on every chain the ERC-8004 team deployed to (erc-8004/erc-8004-contracts README).
    address constant ERC8004_IDENTITY_TESTNET = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    address constant ERC8004_REPUTATION_TESTNET = 0x8004B663056A597Dffe9eCcC1965A193B7388713;
    address constant ERC8004_IDENTITY_MAINNET = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address constant ERC8004_REPUTATION_MAINNET = 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63;

    struct Deployed {
        address token;
        address escrow;
        address judge;
        address hook; // 0 when the chain has no ERC-8004 registries
        bool escrowDeployed;
    }

    function run() external returns (Deployed memory d) {
        uint256 chainId = vm.envUint("KIT_CHAIN_ID");
        address owner = vm.envAddress("KIT_OWNER");
        address guardian = vm.envAddress("KIT_GUARDIAN");
        address signer = vm.envAddress("KIT_SIGNER");
        address token = vm.envOr("KIT_TOKEN", address(0));
        address escrow = vm.envOr("KIT_ESCROW", address(0));
        (address identity, address reputation) = _registries();

        // Before broadcasting.
        require(block.chainid == chainId, "not the chain in KIT_CHAIN_ID");
        require(owner != address(0) && guardian != address(0) && signer != address(0), "KIT_ roles are required");
        require(guardian != signer, "the guardian must not be the verdict key");
        require(token == address(0) || token.code.length > 0, "no code at KIT_TOKEN");
        if (escrow != address(0)) _requireCircleLayout(escrow);

        address[] memory signers = new address[](1);
        signers[0] = signer;

        vm.startBroadcast();
        if (token == address(0)) token = address(new TestDollar());
        if (escrow == address(0)) {
            AgenticCommerce impl = new AgenticCommerce();
            escrow = address(
                new ERC1967Proxy(address(impl), abi.encodeCall(AgenticCommerce.initialize, (token, owner, owner)))
            );
            d.escrowDeployed = true;
        }
        JudgeEvaluator judge = new JudgeEvaluator(escrow, guardian, signers);
        JudgeReputationHookV2 hook;
        if (identity != address(0)) {
            hook = new JudgeReputationHookV2(escrow, address(judge), identity, reputation);
            if (d.escrowDeployed) AgenticCommerce(escrow).setHookWhitelist(address(hook), true);
        }
        vm.stopBroadcast();

        // After: every role reads back as intended.
        require(address(judge.acp()) == escrow, "acp");
        require(judge.guardian() == guardian, "guardian");
        require(judge.isSigner(signer), "signer");
        require(!judge.paused(), "paused");
        require(judge.owner() == owner, "the judge's owner is not KIT_OWNER: broadcast from that wallet");
        if (d.escrowDeployed) {
            AgenticCommerce e = AgenticCommerce(escrow);
            require(address(e.paymentToken()) == token, "escrow token");
            require(e.hasRole(e.DEFAULT_ADMIN_ROLE(), owner), "escrow admin");
            require(e.platformFeeBP() == 0 && e.evaluatorFeeBP() == 0, "escrow fees");
            if (address(hook) != address(0)) require(e.whitelistedHooks(address(hook)), "hook whitelist");
        }

        d.token = token;
        d.escrow = escrow;
        d.judge = address(judge);
        d.hook = address(hook);
        console2.log("chain:", block.chainid);
        console2.log("token:", token);
        console2.log("escrow:", escrow, d.escrowDeployed ? "(deployed)" : "(existing)");
        console2.log("JudgeEvaluator:", address(judge));
        if (address(hook) != address(0)) console2.log("JudgeReputationHookV2:", address(hook));
        else console2.log("JudgeReputationHookV2: skipped, no ERC-8004 registries on this chain");
    }

    /// @dev The explicit KIT_ registries, else the canonical ones that have code here, else none.
    function _registries() internal view returns (address identity, address reputation) {
        identity = vm.envOr("KIT_IDENTITY", address(0));
        reputation = vm.envOr("KIT_REPUTATION", address(0));
        if (identity != address(0) || reputation != address(0)) {
            require(identity.code.length > 0 && reputation.code.length > 0, "no code at KIT_IDENTITY/KIT_REPUTATION");
            return (identity, reputation);
        }
        if (ERC8004_IDENTITY_TESTNET.code.length > 0 && ERC8004_REPUTATION_TESTNET.code.length > 0) {
            return (ERC8004_IDENTITY_TESTNET, ERC8004_REPUTATION_TESTNET);
        }
        if (ERC8004_IDENTITY_MAINNET.code.length > 0 && ERC8004_REPUTATION_MAINNET.code.length > 0) {
            return (ERC8004_IDENTITY_MAINNET, ERC8004_REPUTATION_MAINNET);
        }
        return (address(0), address(0));
    }

    /// @dev Same check as DeployArcMainnet: Circle's Job layout on the raw words of getJob(1).
    function _requireCircleLayout(address acp) internal view {
        require(acp.code.length > 0, "no escrow at KIT_ESCROW");
        (bool ok, bytes memory ret) = acp.staticcall(abi.encodeCall(IACP.getJob, (1)));
        require(ok && ret.length >= 10 * 32, "getJob(1) failed");
        (uint256 tupleOffset, uint256 id,,,, uint256 descriptionOffset) =
            abi.decode(ret, (uint256, uint256, uint256, uint256, uint256, uint256));
        require(
            tupleOffset == 0x20 && id == 1 && descriptionOffset == 0x120,
            "the escrow's getJob does not have Circle's Job layout"
        );
    }
}
