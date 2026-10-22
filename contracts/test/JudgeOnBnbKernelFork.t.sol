// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../src/bnb/JudgeDeterministicPolicy.sol";
import "../src/bnb/JudgeRouter.sol";
import "../src/interfaces/IBnbCommerce.sol";

/// @notice JudgeRouter and JudgeDeterministicPolicy driven by BNB Chain's REAL ERC-8183 kernel (bnbagent-sdk's
///         AgenticCommerceUpgradeable on BSC testnet, chain 97), on a local fork: nothing is sent to the chain. The
///         kernel's own ERC-165 check on the hook, its hook call encodings, its auth and status gates, and its token
///         transfers are the real ones; only the router and policy are ours. Runs only when BSC_TESTNET_RPC is set,
///         and skips otherwise:
///           BSC_TESTNET_RPC=https://data-seed-prebsc-1-s1.bnbchain.org:8545 forge test --match-contract JudgeOnBnbKernelFork -vv
contract JudgeOnBnbKernelFork is Test {
    uint256 constant BSC_TESTNET = 97;
    address constant KERNEL = 0xa206c0517B6371C6638CD9e4a42Cc9f02A33B0DE; // the kernel proxy on BSC testnet

    IBnbCommerce commerce = IBnbCommerce(KERNEL);
    IERC20 token;
    JudgeRouter router;
    JudgeDeterministicPolicy policy;
    bool forked;

    address guardian = makeAddr("guardian");
    uint256 signerKey = 0xA11CE;
    address signer = vm.addr(signerKey);
    address client = makeAddr("client");
    address provider = makeAddr("provider");
    address relayer = makeAddr("relayer");

    uint256 constant BUDGET = 5e18; // the testnet kernel's token has 18 decimals
    bytes32 constant CRITERIA = keccak256("criteria-json-v1");
    bytes32 constant DELIVERABLE = keccak256("manifest-canonical-json");
    bytes32 constant EVIDENCE = keccak256("verdict-core-json");

    function setUp() public {
        string memory rpc = vm.envOr("BSC_TESTNET_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        assertEq(block.chainid, BSC_TESTNET, "BSC_TESTNET_RPC must serve BSC testnet");
        forked = true;

        (bool ok, bytes memory ret) = KERNEL.staticcall(abi.encodeWithSignature("paymentToken()"));
        require(ok, "paymentToken()");
        token = IERC20(abi.decode(ret, (address)));

        router = new JudgeRouter(KERNEL);
        address[] memory signers = new address[](1);
        signers[0] = signer;
        policy = new JudgeDeterministicPolicy(address(router), KERNEL, guardian, signers);
        router.setPolicyWhitelist(address(policy), true);

        deal(address(token), client, 100e18);
        vm.prank(client);
        token.approve(KERNEL, type(uint256).max);
    }

    /// The flow an SDK client and provider run: create with the router as evaluator and hook (the kernel checks the
    /// hook's ERC-165 answer here), bind the policy, budget, fund, submit.
    function _submittedJob() internal returns (uint256 jobId) {
        vm.prank(client);
        jobId = commerce.createJob(provider, address(router), block.timestamp + 2 days, "job with a judge-criteria block", address(router));
        vm.prank(client);
        router.registerJob(jobId, address(policy));
        vm.prank(provider);
        commerce.setBudget(jobId, BUDGET, "");
        vm.prank(client);
        commerce.fund(jobId, BUDGET, "");
        vm.prank(provider);
        commerce.submit(jobId, DELIVERABLE, bytes('{"deliverable_url":"https://p.example/m.json"}'));
    }

    function _verdict(uint256 jobId, bool pass) internal view returns (JudgeDeterministicPolicy.Verdict memory v) {
        v = JudgeDeterministicPolicy.Verdict({
            jobId: jobId, criteriaHash: CRITERIA, deliverable: DELIVERABLE, score: pass ? 100 : 40, threshold: 100,
            pass: pass, evidenceHash: EVIDENCE, timestamp: uint64(block.timestamp)
        });
    }

    function _evidence(JudgeDeterministicPolicy.Verdict memory v, uint256 key) internal view returns (bytes memory) {
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(key, policy.verdictDigest(v));
        return abi.encode(v, abi.encodePacked(r, s, vv));
    }

    function _platformFee(uint256 amount) internal view returns (uint256) {
        (bool ok, bytes memory ret) = KERNEL.staticcall(abi.encodeWithSignature("platformFeeBP()"));
        require(ok, "platformFeeBP()");
        return (amount * abi.decode(ret, (uint256))) / 10_000;
    }

    function test_theKernelAcceptsTheRouterAsHookAndRecordsTheSubmissionThroughIt() public {
        vm.skip(!forked);
        uint256 jobId = _submittedJob();
        IBnbCommerce.Job memory job = commerce.getJob(jobId);
        assertEq(uint8(job.status), uint8(IBnbCommerce.JobStatus.Submitted));
        assertEq(job.evaluator, address(router));
        assertEq(job.hook, address(router));
        assertEq(job.deliverable, DELIVERABLE, "the kernel's own record");
        assertEq(policy.submitted(jobId), DELIVERABLE, "what the kernel's submit hook told the policy");
        assertEq(policy.submittedAt(jobId), uint64(job.submittedAt));
    }

    function test_aPassVerdictRelayedByAnyonePaysTheProviderOnTheRealKernel() public {
        vm.skip(!forked);
        uint256 jobId = _submittedJob();
        uint256 before = token.balanceOf(provider);
        vm.prank(relayer);
        router.settle(jobId, _evidence(_verdict(jobId, true), signerKey));
        assertEq(uint8(commerce.getJob(jobId).status), uint8(IBnbCommerce.JobStatus.Completed));
        assertEq(token.balanceOf(provider) - before, BUDGET - _platformFee(BUDGET), "escrow released, minus the kernel's fee");
    }

    function test_aRejectVerdictRefundsTheClientOnTheRealKernel() public {
        vm.skip(!forked);
        uint256 jobId = _submittedJob();
        uint256 before = token.balanceOf(client);
        router.settle(jobId, _evidence(_verdict(jobId, false), signerKey));
        assertEq(uint8(commerce.getJob(jobId).status), uint8(IBnbCommerce.JobStatus.Rejected));
        assertEq(token.balanceOf(client) - before, BUDGET, "refunded in full");
    }

    function test_badEvidenceMovesNothingOnTheRealKernel() public {
        vm.skip(!forked);
        uint256 jobId = _submittedJob();
        bytes memory unknownKey = _evidence(_verdict(jobId, true), 0xB0B);
        vm.expectRevert(JudgeRouter.NotDecided.selector);
        router.settle(jobId, unknownKey);
        JudgeDeterministicPolicy.Verdict memory v = _verdict(jobId, true);
        v.deliverable = keccak256("other bytes");
        bytes memory otherBytes = _evidence(v, signerKey);
        vm.expectRevert(JudgeRouter.NotDecided.selector);
        router.settle(jobId, otherBytes);
        vm.expectRevert(JudgeRouter.NotDecided.selector);
        router.settle(jobId, "");
        assertEq(uint8(commerce.getJob(jobId).status), uint8(IBnbCommerce.JobStatus.Submitted), "nothing moved");
    }

    function test_registeredCriteriaBindTheVerdictOnTheRealKernel() public {
        vm.skip(!forked);
        vm.prank(client);
        uint256 jobId = commerce.createJob(provider, address(router), block.timestamp + 2 days, "job", address(router));
        vm.prank(client);
        router.registerJob(jobId, address(policy));
        vm.prank(signer);
        policy.registerCriteria(jobId, CRITERIA);
        vm.prank(provider);
        commerce.setBudget(jobId, BUDGET, "");
        vm.prank(client);
        commerce.fund(jobId, BUDGET, "");
        vm.prank(provider);
        commerce.submit(jobId, DELIVERABLE, "");
        JudgeDeterministicPolicy.Verdict memory other = _verdict(jobId, true);
        other.criteriaHash = keccak256("criteria nobody agreed to");
        bytes memory otherCriteria = _evidence(other, signerKey);
        vm.expectRevert(JudgeRouter.NotDecided.selector);
        router.settle(jobId, otherCriteria);
        router.settle(jobId, _evidence(_verdict(jobId, true), signerKey));
        assertEq(uint8(commerce.getJob(jobId).status), uint8(IBnbCommerce.JobStatus.Completed));
    }

    function test_hooksNeverBlockTheKernelAndExpiryRefundsAnUnsettledJob() public {
        vm.skip(!forked);
        // A job naming the router as evaluator and hook but never registered: every kernel step still goes through,
        // nothing can settle it, and the kernel's own claimRefund returns the escrow after expiry.
        vm.prank(client);
        uint256 jobId = commerce.createJob(provider, address(router), block.timestamp + 1 days, "job", address(router));
        vm.prank(provider);
        commerce.setBudget(jobId, BUDGET, "");
        vm.prank(client);
        commerce.fund(jobId, BUDGET, "");
        vm.prank(provider);
        commerce.submit(jobId, DELIVERABLE, "");
        assertEq(policy.submitted(jobId), bytes32(0), "unregistered: the policy recorded nothing");
        bytes memory good = _evidence(_verdict(jobId, true), signerKey);
        vm.expectRevert(JudgeRouter.PolicyNotSet.selector);
        router.settle(jobId, good);
        uint256 before = token.balanceOf(client);
        vm.warp(block.timestamp + 1 days + 1);
        commerce.claimRefund(jobId);
        assertEq(token.balanceOf(client) - before, BUDGET);
        router.markExpired(jobId);
    }
}
