// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/JudgeEvaluator.sol";
import "../src/interfaces/IACP.sol";
import "../src/mocks/MockUSDC.sol";

/// @notice JudgeEvaluator against a live ERC-8183 escrow on Arc mainnet, on a fork of the chain.
///         The escrow is the one ArcBounty deployed (0x64cA39Fc...): the ERC-8183 reference
///         implementation, open to any client, with Circle's Job layout and both fees at 0.
///         Runs only when ARC_MAINNET_RPC is set, and skips otherwise:
///           ARC_MAINNET_RPC=https://rpc.mainnet.arc.io forge test --match-contract ArcMainnetFork -vv
///         Zero-budget jobs run on the chain's contracts unchanged. Arc's USDC moves native balances in a
///         way a local fork cannot execute, so the paid-job tests put a standard ERC-20 at the USDC
///         address; the escrow and JudgeEvaluator are still the real code on real mainnet state.
contract ArcMainnetForkTest is Test {
    address constant ESCROW = 0x64cA39Fc57315D0D488acCaC07c37C6E841CD058;
    address constant USDC = 0x3600000000000000000000000000000000000000;
    uint256 constant ARC_MAINNET = 5042;

    IACP acp = IACP(ESCROW);
    JudgeEvaluator judge;
    uint256 signerKey = 0xA11CE;
    address signer = vm.addr(0xA11CE);
    address guardian = makeAddr("guardian");
    address client = makeAddr("client");
    address provider = makeAddr("provider");
    bytes32 constant CRITERIA = keccak256("criteria");
    bytes32 constant DELIVERABLE = keccak256("deliverable");
    bytes32 constant EVIDENCE = keccak256("evidence");

    function setUp() public {
        string memory rpc = vm.envOr("ARC_MAINNET_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        assertEq(block.chainid, ARC_MAINNET, "ARC_MAINNET_RPC must serve Arc mainnet");
        assertGt(ESCROW.code.length, 0, "the escrow is deployed");
        address[] memory signers = new address[](1);
        signers[0] = signer;
        judge = new JudgeEvaluator(ESCROW, guardian, signers);
    }

    modifier onFork() {
        vm.skip(address(judge) == address(0)); // reported as skipped, never as a pass, without ARC_MAINNET_RPC
        _;
    }

    function _newJob(address evaluator) internal returns (uint256 jobId) {
        vm.prank(client);
        jobId = acp.createJob(provider, evaluator, block.timestamp + 1 days, "fork test job", address(0));
    }

    function _verdict(uint256 jobId, bool pass) internal view returns (JudgeEvaluator.Verdict memory) {
        return JudgeEvaluator.Verdict({
            jobId: jobId,
            criteriaHash: CRITERIA,
            deliverable: DELIVERABLE,
            score: pass ? 100 : 40,
            threshold: 100,
            pass: pass,
            evidenceHash: EVIDENCE,
            timestamp: uint64(block.timestamp)
        });
    }

    function _sign(JudgeEvaluator.Verdict memory v) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                judge.VERDICT_TYPEHASH(),
                v.jobId,
                v.criteriaHash,
                v.deliverable,
                v.score,
                v.threshold,
                v.pass,
                v.evidenceHash,
                v.timestamp
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", judge.DOMAIN_SEPARATOR(), structHash));
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        return abi.encodePacked(r, s, vv);
    }

    // A zero-budget job moves no USDC, so it runs on the chain's own contracts, unchanged.
    function testFork_zeroBudgetPassCompletesOnTheLiveEscrow() public onFork {
        uint256 jobId = _newJob(address(judge));
        vm.prank(signer);
        judge.registerCriteria(jobId, CRITERIA);
        vm.prank(provider);
        acp.submit(jobId, DELIVERABLE, "");
        JudgeEvaluator.Verdict memory v = _verdict(jobId, true);
        judge.relay(v, _sign(v)); // anyone may relay a validly signed verdict
        assertEq(uint8(acp.getJob(jobId).status), uint8(IACP.JobStatus.Completed));
        assertEq(judge.getVerdict(jobId).evidenceHash, EVIDENCE);
    }

    function testFork_zeroBudgetRejectRejectsOnTheLiveEscrow() public onFork {
        uint256 jobId = _newJob(address(judge));
        vm.prank(provider);
        acp.submit(jobId, DELIVERABLE, "");
        JudgeEvaluator.Verdict memory v = _verdict(jobId, false);
        judge.relay(v, _sign(v));
        assertEq(uint8(acp.getJob(jobId).status), uint8(IACP.JobStatus.Rejected));
    }

    // False positives: a verdict never settles a job that names another evaluator, a verdict signed by a
    // key the judge does not trust never settles anything, and criteria registered for the job bind it.
    function testFork_aJobNamingAnotherEvaluatorIsNeverSettled() public onFork {
        uint256 jobId = _newJob(makeAddr("someone else"));
        vm.prank(provider);
        acp.submit(jobId, DELIVERABLE, "");
        JudgeEvaluator.Verdict memory v = _verdict(jobId, true);
        bytes memory sig = _sign(v);
        vm.expectRevert(JudgeEvaluator.JobNotSubmitted.selector);
        judge.relay(v, sig);
        assertEq(uint8(acp.getJob(jobId).status), uint8(IACP.JobStatus.Submitted));
    }

    function testFork_anUntrustedSignatureIsRefused() public onFork {
        uint256 jobId = _newJob(address(judge));
        vm.prank(provider);
        acp.submit(jobId, DELIVERABLE, "");
        JudgeEvaluator.Verdict memory v = _verdict(jobId, true);
        bytes32 structHash = keccak256(
            abi.encode(
                judge.VERDICT_TYPEHASH(),
                v.jobId,
                v.criteriaHash,
                v.deliverable,
                v.score,
                v.threshold,
                v.pass,
                v.evidenceHash,
                v.timestamp
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", judge.DOMAIN_SEPARATOR(), structHash));
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(0xB0B, digest);
        vm.expectRevert(JudgeEvaluator.BadSignature.selector);
        judge.relay(v, abi.encodePacked(r, s, vv));
    }

    function testFork_registeredCriteriaBindTheVerdict() public onFork {
        uint256 jobId = _newJob(address(judge));
        vm.prank(signer);
        judge.registerCriteria(jobId, keccak256("the criteria the client committed to"));
        vm.prank(provider);
        acp.submit(jobId, DELIVERABLE, "");
        JudgeEvaluator.Verdict memory v = _verdict(jobId, true); // signed over other criteria
        bytes memory sig = _sign(v);
        vm.expectRevert(JudgeEvaluator.CriteriaMismatch.selector);
        judge.relay(v, sig);
    }

    // Paid jobs: a standard ERC-20 stands in for Arc's USDC at the same address (see the contract note).
    function _standInUsdc() internal returns (MockUSDC token) {
        vm.etch(USDC, address(new MockUSDC()).code);
        vm.store(USDC, bytes32(uint256(2)), bytes32(0)); // total supply slot, left over from the real token
        token = MockUSDC(USDC);
        token.mint(client, 10e6);
        vm.prank(client);
        token.approve(ESCROW, type(uint256).max);
    }

    function _paidJob(MockUSDC token, uint256 budget) internal returns (uint256 jobId) {
        jobId = _newJob(address(judge));
        vm.prank(provider);
        acp.setBudget(jobId, budget, "");
        vm.prank(client);
        acp.fund(jobId, "");
        assertEq(token.balanceOf(ESCROW) >= budget, true, "escrow holds the budget");
        vm.prank(provider);
        acp.submit(jobId, DELIVERABLE, "");
    }

    function testFork_paidPassPaysTheProvider() public onFork {
        MockUSDC token = _standInUsdc();
        uint256 jobId = _paidJob(token, 1e6);
        JudgeEvaluator.Verdict memory v = _verdict(jobId, true);
        judge.relay(v, _sign(v));
        assertEq(token.balanceOf(provider), 1e6, "fees are 0 on this escrow, so the provider gets the whole budget");
        assertEq(token.balanceOf(client), 9e6);
    }

    function testFork_paidRejectRefundsTheClient() public onFork {
        MockUSDC token = _standInUsdc();
        uint256 jobId = _paidJob(token, 1e6);
        JudgeEvaluator.Verdict memory v = _verdict(jobId, false);
        judge.relay(v, _sign(v));
        assertEq(token.balanceOf(client), 10e6, "the whole budget comes back");
        assertEq(token.balanceOf(provider), 0);
    }

    // What a mainnet run costs in gas units, for the funding estimate.
    function testFork_gasForDeployAndRuling() public onFork {
        address[] memory signers = new address[](1);
        signers[0] = signer;
        uint256 g = gasleft();
        new JudgeEvaluator(ESCROW, guardian, signers);
        emit log_named_uint("deploy JudgeEvaluator, gas", g - gasleft());
        uint256 jobId = _newJob(address(judge));
        vm.prank(provider);
        acp.submit(jobId, DELIVERABLE, "");
        JudgeEvaluator.Verdict memory v = _verdict(jobId, true);
        bytes memory sig = _sign(v);
        g = gasleft();
        judge.relay(v, sig);
        emit log_named_uint("relay a ruling, gas", g - gasleft());
    }
}
