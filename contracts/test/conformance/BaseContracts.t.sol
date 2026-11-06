// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "./ERC8183Conformance.sol";
import "./vendor/erc8183-base-contracts/ERC8183.sol";
import "../../src/mocks/MockUSDC.sol";

/// @notice The ERC-8183 authors' own implementation, erc-8183/base-contracts at commit 142e669 (vendored unchanged
///         under ./vendor, MIT), behind a UUPS proxy as its initialize() expects, with MockUSDC on its token allowlist.
///         Its call shapes follow the eip.md in that repository, not the text on eips.ethereum.org: a per-job token
///         (setBudget(jobId, token, amount, optParams), fund(jobId, expectedToken, expectedBudget, optParams)), an
///         ERC-8004 agent id on createJob and setProvider, and a 13-field Job.
///           ERC8183_CONFORMANCE=1 forge test --match-contract ConformanceBaseContracts142e669 -vv
contract ConformanceBaseContracts142e669 is ERC8183Conformance {
    MockUSDC internal usdc;
    address internal escrow;

    struct BaseJob {
        address client;
        uint8 status;
        address provider;
        uint48 expiredAt;
        address evaluator;
        uint48 submittedAt;
        uint256 budget;
        address hook;
        address paymentToken;
        uint256 providerAgentId;
        string description;
        uint256 settledAmount;
        address payoutReceiver;
    }

    function _setUpTarget() internal override returns (bool) {
        usdc = new MockUSDC();
        address admin = makeAddr("admin");
        ERC8183 impl = new ERC8183();
        escrow = address(new ERC1967Proxy(address(impl), abi.encodeCall(ERC8183.initialize, (makeAddr("treasury"), admin))));
        vm.prank(admin);
        ERC8183(escrow).setPaymentTokenAllowed(address(usdc), true);
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

    function _createJobData(address provider_, address evaluator_, uint256 expiredAt) internal pure override returns (bytes memory) {
        return abi.encodeWithSignature("createJob(address,address,uint48,string,address,uint256)", provider_, evaluator_,
            uint48(expiredAt), "erc8183 conformance", address(0), uint256(0));
    }

    function _setProviderData(uint256 jobId, address provider_) internal pure override returns (bytes memory) {
        return abi.encodeWithSignature("setProvider(uint256,address,uint256)", jobId, provider_, uint256(0));
    }

    function _setBudgetData(uint256 jobId, uint256 amount) internal view override returns (bytes memory) {
        return abi.encodeWithSignature("setBudget(uint256,address,uint256,bytes)", jobId, address(usdc), amount, bytes(""));
    }

    function _fundData(uint256 jobId, uint256 expected) internal view override returns (bytes memory) {
        return abi.encodeWithSignature("fund(uint256,address,uint256,bytes)", jobId, address(usdc), expected, bytes(""));
    }

    function _submitData(uint256 jobId, bytes32 deliverable) internal pure override returns (bytes memory) {
        return abi.encodeWithSignature("submit(uint256,bytes32,bytes)", jobId, deliverable, bytes(""));
    }

    function _completeData(uint256 jobId, bytes32 reason) internal pure override returns (bytes memory) {
        return abi.encodeWithSignature("complete(uint256,bytes32,bytes)", jobId, reason, bytes(""));
    }

    function _rejectData(uint256 jobId, bytes32 reason) internal pure override returns (bytes memory) {
        return abi.encodeWithSignature("reject(uint256,bytes32,bytes)", jobId, reason, bytes(""));
    }

    function _claimRefundData(uint256 jobId) internal pure override returns (bytes memory) {
        return abi.encodeWithSignature("claimRefund(uint256)", jobId);
    }

    function _job(uint256 jobId) internal view override returns (JobView memory v) {
        (bool ok, bytes memory ret) = escrow.staticcall(abi.encodeWithSignature("getJob(uint256)", jobId));
        require(ok, "getJob reverted");
        BaseJob memory j = abi.decode(ret, (BaseJob));
        v = JobView(j.client, j.provider, j.evaluator, j.budget, j.expiredAt, Status(j.status));
    }
}
