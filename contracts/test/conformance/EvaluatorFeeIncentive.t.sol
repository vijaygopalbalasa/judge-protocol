// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../../src/mocks/MockUSDC.sol";
import "./vendor/erc8183-base-contracts/ERC8183.sol";

/// @notice What a third-party evaluator earns under the evaluator fee of the ERC-8183 authors' implementation
///         (erc-8183/base-contracts at 142e669, vendored unchanged). eip.md: the evaluator fee is "paid to the job's
///         evaluator address" on completion and settlement, and "Fees SHALL NOT be taken on refunds". So for the same
///         job, the evaluator is paid if it completes and paid nothing if it rejects.
contract EvaluatorFeeIncentiveTest is Test {
    MockUSDC usdc;
    ERC8183 escrow;

    address admin = makeAddr("admin");
    address client = makeAddr("client");
    address provider = makeAddr("provider");
    address evaluator = makeAddr("evaluator");

    uint256 constant BUDGET = 1_000_000; // 1 USDC
    uint256 constant EVALUATOR_FEE_BP = 500; // 5%, the value live on Virtuals' ACP core (0x238E...) on Base and Arc

    function setUp() public {
        usdc = new MockUSDC();
        ERC8183 impl = new ERC8183();
        escrow = ERC8183(address(new ERC1967Proxy(address(impl), abi.encodeCall(ERC8183.initialize, (makeAddr("treasury"), admin)))));
        vm.startPrank(admin);
        escrow.setPaymentTokenAllowed(address(usdc), true);
        escrow.setEvaluatorFee(EVALUATOR_FEE_BP);
        vm.stopPrank();
        usdc.mint(client, 100e6);
        vm.prank(client);
        usdc.approve(address(escrow), type(uint256).max);
    }

    function _submitted() internal returns (uint256 jobId) {
        vm.prank(client);
        jobId = escrow.createJob(provider, evaluator, uint48(block.timestamp + 1 days), "job", address(0), 0);
        vm.prank(provider);
        escrow.setBudget(jobId, address(usdc), BUDGET, "");
        vm.prank(client);
        escrow.fund(jobId, address(usdc), BUDGET, "");
        vm.prank(provider);
        escrow.submit(jobId, keccak256("deliverable"), "");
    }

    function test_theEvaluatorIsPaidOnlyWhenItCompletes() public {
        uint256 passed = _submitted();
        vm.prank(evaluator);
        escrow.complete(passed, bytes32(0), "");
        uint256 earnedOnPass = usdc.balanceOf(evaluator);

        uint256 failed = _submitted();
        uint256 clientBefore = usdc.balanceOf(client);
        vm.prank(evaluator);
        escrow.reject(failed, bytes32(0), "");
        uint256 earnedOnReject = usdc.balanceOf(evaluator) - earnedOnPass;

        assertEq(earnedOnPass, BUDGET * EVALUATOR_FEE_BP / 10000, "5% of the budget for completing");
        assertEq(earnedOnReject, 0, "nothing for rejecting the same kind of job");
        assertEq(usdc.balanceOf(client), clientBefore + BUDGET, "the client gets the whole budget back");
    }

    function test_expiryAlsoPaysTheEvaluatorNothing() public {
        uint256 jobId = _submitted();
        vm.warp(block.timestamp + 1 days + escrow.EVALUATION_GRACE_PERIOD());
        escrow.claimRefund(jobId);
        assertEq(usdc.balanceOf(evaluator), 0);
    }
}
