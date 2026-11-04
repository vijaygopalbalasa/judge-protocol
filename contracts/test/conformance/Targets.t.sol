// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "./ERC8183Conformance.sol";
import "./reference/AgenticCommerce.sol";
import "../../src/mocks/MockUSDC.sol";
import "./helpers/SpecEscrow.sol";

interface IApprove {
    function approve(address spender, uint256 amount) external returns (bool);
}

/// @notice The call shapes of the ERC-8183 reference implementation: fund(jobId, optParams) with no expectedBudget, and
///         getJob returning the reference's 9-field Job. Circle's Arc testnet deployment and ArcBounty's Arc mainnet
///         escrow use the same shapes.
abstract contract ReferenceShapes is ERC8183Conformance {
    struct ReferenceJob {
        uint256 id;
        address client;
        address provider;
        address evaluator;
        string description;
        uint256 budget;
        uint256 expiredAt;
        uint8 status;
        address hook;
    }

    function _createJobData(address provider_, address evaluator_, uint256 expiredAt) internal view virtual override returns (bytes memory) {
        return abi.encodeWithSignature("createJob(address,address,uint256,string,address)", provider_, evaluator_, expiredAt,
            "erc8183 conformance", address(0));
    }

    function _setProviderData(uint256 jobId, address provider_) internal view virtual override returns (bytes memory) {
        return abi.encodeWithSignature("setProvider(uint256,address)", jobId, provider_);
    }

    function _setBudgetData(uint256 jobId, uint256 amount) internal view virtual override returns (bytes memory) {
        return abi.encodeWithSignature("setBudget(uint256,uint256,bytes)", jobId, amount, bytes(""));
    }

    function _fundData(uint256 jobId, uint256) internal view virtual override returns (bytes memory) {
        return abi.encodeWithSignature("fund(uint256,bytes)", jobId, bytes(""));
    }

    function _submitData(uint256 jobId, bytes32 deliverable) internal view virtual override returns (bytes memory) {
        return abi.encodeWithSignature("submit(uint256,bytes32,bytes)", jobId, deliverable, bytes(""));
    }

    function _completeData(uint256 jobId, bytes32 reason) internal view virtual override returns (bytes memory) {
        return abi.encodeWithSignature("complete(uint256,bytes32,bytes)", jobId, reason, bytes(""));
    }

    function _rejectData(uint256 jobId, bytes32 reason) internal view virtual override returns (bytes memory) {
        return abi.encodeWithSignature("reject(uint256,bytes32,bytes)", jobId, reason, bytes(""));
    }

    function _claimRefundData(uint256 jobId) internal view virtual override returns (bytes memory) {
        return abi.encodeWithSignature("claimRefund(uint256)", jobId);
    }

    function _job(uint256 jobId) internal view virtual override returns (JobView memory v) {
        (bool ok, bytes memory ret) = _escrow().staticcall(abi.encodeWithSignature("getJob(uint256)", jobId));
        require(ok, "getJob reverted");
        ReferenceJob memory j = abi.decode(ret, (ReferenceJob));
        v = JobView(j.client, j.provider, j.evaluator, j.budget, j.expiredAt, Status(j.status));
    }
}

/// @notice A target whose payment token is Arc's USDC (0x3600...). A local fork cannot move Arc's native USDC, so the
///         tests put a standard ERC-20 at that address, as test/ArcMainnetFork.t.sol does. The escrow under test is
///         still the deployed bytecode on real chain state.
abstract contract ArcFork is ReferenceShapes {
    address internal constant ARC_USDC = 0x3600000000000000000000000000000000000000;

    function _rpcVar() internal pure virtual returns (string memory);
    function _chainId() internal pure virtual returns (uint256);

    function _setUpTarget() internal virtual override returns (bool) {
        string memory rpc = vm.envOr(_rpcVar(), string(""));
        if (bytes(rpc).length == 0) return false;
        vm.createSelectFork(rpc);
        assertEq(block.chainid, _chainId(), string.concat(_rpcVar(), " serves another chain"));
        assertGt(_escrow().code.length, 0, "no escrow at this address");
        (bool ok, bytes memory ret) = _escrow().staticcall(abi.encodeWithSignature("paymentToken()"));
        assertTrue(ok && abi.decode(ret, (address)) == ARC_USDC, "the escrow does not pay in Arc USDC");
        vm.etch(ARC_USDC, address(new MockUSDC()).code);
        return true;
    }

    function _token() internal pure override returns (address) {
        return ARC_USDC;
    }

    function _giveTokens(address who, uint256 amount) internal override {
        MockUSDC(ARC_USDC).mint(who, amount);
        vm.prank(who);
        IApprove(ARC_USDC).approve(_escrow(), type(uint256).max);
    }
}

/// @notice The reference implementation the ERC publishes (vendored under ./reference, CC0), behind a UUPS proxy with no
///         fees, exactly as its initialize() sets it up.
contract ConformanceReferenceImplementation is ReferenceShapes {
    MockUSDC internal usdc;
    address internal escrow;

    function _setUpTarget() internal override returns (bool) {
        usdc = new MockUSDC();
        AgenticCommerce impl = new AgenticCommerce();
        escrow = address(new ERC1967Proxy(address(impl), abi.encodeCall(AgenticCommerce.initialize, (address(usdc), makeAddr("treasury")))));
        return true;
    }

    function _escrow() internal view override returns (address) {
        return escrow;
    }

    function _token() internal view override returns (address) {
        return address(usdc);
    }

    function _giveTokens(address who, uint256 amount) internal override {
        usdc.mint(who, amount);
        vm.prank(who);
        usdc.approve(escrow, type(uint256).max);
    }
}

/// @notice The suite's own check, run on every plain `forge test` (no flag, no network): an escrow written from the
///         Specification section must pass every test, with and without a platform fee. If one of these fails, the
///         suite is wrong, not the implementations it measures.
contract ConformanceSuiteSelfCheck is ReferenceShapes {
    MockUSDC internal usdc;
    address internal escrow;

    function _feeBP() internal pure virtual returns (uint256) {
        return 0;
    }

    function _setUpTarget() internal override returns (bool) {
        usdc = new MockUSDC();
        escrow = address(new SpecEscrow(IERC20(address(usdc)), makeAddr("treasury"), _feeBP()));
        return true;
    }

    function _escrow() internal view override returns (address) {
        return escrow;
    }

    function _token() internal view override returns (address) {
        return address(usdc);
    }

    function _giveTokens(address who, uint256 amount) internal override {
        usdc.mint(who, amount);
        vm.prank(who);
        usdc.approve(escrow, type(uint256).max);
    }

    function _fundData(uint256 jobId, uint256 expected) internal pure override returns (bytes memory) {
        return abi.encodeWithSignature("fund(uint256,uint256,bytes)", jobId, expected, bytes(""));
    }

    function _enabled() internal pure override returns (bool) {
        return true;
    }
}

/// @notice The same check with a 2.5% platform fee taken on completion.
contract ConformanceSuiteSelfCheckWithFee is ConformanceSuiteSelfCheck {
    function _feeBP() internal pure override returns (uint256) {
        return 250;
    }
}

/// @notice Circle's ERC-8183 deployment on Arc testnet (the canonical one Circle's docs point to).
///           ERC8183_CONFORMANCE=1 ARC_TESTNET_RPC=https://rpc.testnet.arc.io forge test --match-contract ConformanceCircleArcTestnet
contract ConformanceCircleArcTestnet is ArcFork {
    function _rpcVar() internal pure override returns (string memory) {
        return "ARC_TESTNET_RPC";
    }

    function _chainId() internal pure override returns (uint256) {
        return 5042002;
    }

    function _escrow() internal pure override returns (address) {
        return 0x0747EEf0706327138c69792bF28Cd525089e4583;
    }
}

/// @notice ArcBounty's ERC-8183 escrow on Arc mainnet, the one JudgeEvaluator serves there.
///           ERC8183_CONFORMANCE=1 ARC_MAINNET_RPC=https://rpc.mainnet.arc.io forge test --match-contract ConformanceArcBountyArcMainnet
contract ConformanceArcBountyArcMainnet is ArcFork {
    function _rpcVar() internal pure override returns (string memory) {
        return "ARC_MAINNET_RPC";
    }

    function _chainId() internal pure override returns (uint256) {
        return 5042;
    }

    function _escrow() internal pure override returns (address) {
        return 0x64cA39Fc57315D0D488acCaC07c37C6E841CD058;
    }
}

/// @notice G2 Jobs on Arc mainnet: an ownerless ERC-8183 escrow with fund(jobId, expectedBudget, optParams), a review
///         window after submission and settle-on-silence (Sourcify exact, contracts/G2Jobs.sol).
contract ConformanceG2JobsArcMainnet is ArcFork {
    function _rpcVar() internal pure override returns (string memory) {
        return "ARC_MAINNET_RPC";
    }

    function _chainId() internal pure override returns (uint256) {
        return 5042;
    }

    function _escrow() internal pure override returns (address) {
        return 0xac1d948e8127A173f6a594445277476aaE5353EB;
    }

    function _fundData(uint256 jobId, uint256 expected) internal pure override returns (bytes memory) {
        return abi.encodeWithSignature("fund(uint256,uint256,bytes)", jobId, expected, bytes(""));
    }
}

/// @notice Virtuals' AgenticCommerceV3 on Base, the ERC-8183 escrow with the most jobs (Sourcify exact,
///         contracts/AgenticCommerceV3.sol). Its getJob returns an 8-field Job in another order, and it pays in Base USDC.
///           ERC8183_CONFORMANCE=1 BASE_RPC=https://mainnet.base.org forge test --match-contract ConformanceVirtualsBase
contract ConformanceVirtualsBase is ReferenceShapes {
    address internal constant ESCROW = 0x238E541BfefD82238730D00a2208E5497F1832E0;
    address internal constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    struct V3Job {
        address client;
        uint8 status;
        address provider;
        uint48 expiredAt;
        address evaluator;
        address hook;
        uint256 budget;
        string description;
    }

    function _setUpTarget() internal override returns (bool) {
        string memory rpc = vm.envOr("BASE_RPC", string(""));
        if (bytes(rpc).length == 0) return false;
        vm.createSelectFork(rpc);
        assertEq(block.chainid, 8453, "BASE_RPC serves another chain");
        (bool ok, bytes memory ret) = ESCROW.staticcall(abi.encodeWithSignature("paymentToken()"));
        assertTrue(ok && abi.decode(ret, (address)) == BASE_USDC, "the escrow does not pay in Base USDC");
        (ok, ret) = ESCROW.staticcall(abi.encodeWithSignature("paused()"));
        return !(ok && abi.decode(ret, (bool))); // a paused escrow cannot be measured
    }

    function _escrow() internal pure override returns (address) {
        return ESCROW;
    }

    function _token() internal pure override returns (address) {
        return BASE_USDC;
    }

    function _giveTokens(address who, uint256 amount) internal override {
        deal(BASE_USDC, who, IERC20Balance(BASE_USDC).balanceOf(who) + amount);
        vm.prank(who);
        IApprove(BASE_USDC).approve(ESCROW, type(uint256).max);
    }

    function _fundData(uint256 jobId, uint256 expected) internal pure override returns (bytes memory) {
        return abi.encodeWithSignature("fund(uint256,uint256,bytes)", jobId, expected, bytes(""));
    }

    function _job(uint256 jobId) internal view override returns (JobView memory v) {
        (bool ok, bytes memory ret) = ESCROW.staticcall(abi.encodeWithSignature("getJob(uint256)", jobId));
        require(ok, "getJob reverted");
        V3Job memory j = abi.decode(ret, (V3Job));
        v = JobView(j.client, j.provider, j.evaluator, j.budget, j.expiredAt, Status(j.status));
    }
}
