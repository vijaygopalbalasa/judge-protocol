// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/JudgeEvaluator.sol";
import "../src/mocks/MockACP.sol";
import "../src/mocks/MockUSDC.sol";

contract JudgeEvaluatorTest is Test {
    MockUSDC usdc;
    MockACP acp;
    JudgeEvaluator judge;

    address owner = address(this);
    address guardian = makeAddr("guardian");
    uint256 signerKey = 0xA11CE;
    address signer = vm.addr(signerKey);
    address client = makeAddr("client");
    address provider = makeAddr("provider");

    uint256 constant BUDGET = 5_000_000; // 5 USDC, 6 decimals

    bytes32 constant CRITERIA = keccak256("criteria-json-v1");
    bytes32 constant DELIVERABLE = keccak256("deliverable-payload");
    bytes32 constant EVIDENCE = keccak256("verdict-json");

    function setUp() public {
        usdc = new MockUSDC();
        acp = new MockACP(address(usdc));
        address[] memory signers = new address[](1);
        signers[0] = signer;
        judge = new JudgeEvaluator(address(acp), guardian, signers);

        usdc.mint(client, 100e6);
        vm.prank(client);
        usdc.approve(address(acp), type(uint256).max);
    }

    // Helper: run a job through to Submitted, with judge as evaluator.
    function _toSubmitted() internal returns (uint256 jobId) {
        vm.prank(client);
        jobId = acp.createJob(provider, address(judge), block.timestamp + 1 days, "job", address(0));
        vm.prank(provider);
        acp.setBudget(jobId, BUDGET, "");
        vm.prank(client);
        acp.fund(jobId, "");
        vm.prank(provider);
        acp.submit(jobId, DELIVERABLE, "");
    }

    // Helper: create + fund, register criteria while still Funded, then submit.
    function _toSubmittedWithCriteria(bytes32 c) internal returns (uint256 jobId) {
        vm.prank(client);
        jobId = acp.createJob(provider, address(judge), block.timestamp + 1 days, "job", address(0));
        vm.prank(provider);
        acp.setBudget(jobId, BUDGET, "");
        vm.prank(client);
        acp.fund(jobId, "");
        vm.prank(signer);
        judge.registerCriteria(jobId, c); // allowed: status is Funded (< Submitted)
        vm.prank(provider);
        acp.submit(jobId, DELIVERABLE, "");
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
        bytes32 digest = _hashTypedDataV4(structHash);
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        return abi.encodePacked(r, s, vv);
    }

    // Mirror OZ EIP712 domain separator for the JudgeEvaluator.
    function _hashTypedDataV4(bytes32 structHash) internal view returns (bytes32) {
        bytes32 domainSeparator = judge.DOMAIN_SEPARATOR();
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function _verdict(uint256 jobId, bool pass) internal view returns (JudgeEvaluator.Verdict memory) {
        return JudgeEvaluator.Verdict({
            jobId: jobId,
            criteriaHash: CRITERIA,
            deliverable: DELIVERABLE,
            score: pass ? 100 : 20,
            threshold: 100,
            pass: pass,
            evidenceHash: EVIDENCE,
            timestamp: uint64(block.timestamp)
        });
    }

    /* ------------------------- happy path: complete ------------------------- */

    function test_complete_releasesEscrowToProvider() public {
        uint256 jobId = _toSubmitted();
        JudgeEvaluator.Verdict memory v = _verdict(jobId, true);
        bytes memory sig = _sign(v);

        vm.prank(signer);
        judge.submitVerdict(v, sig);

        IACP.Job memory job = acp.getJob(jobId);
        assertEq(uint256(job.status), uint256(IACP.JobStatus.Completed));
        assertEq(usdc.balanceOf(provider), BUDGET);
        assertEq(judge.completedCount(), 1);

        JudgeEvaluator.Verdict memory stored = judge.getVerdict(jobId);
        assertEq(stored.evidenceHash, EVIDENCE);
    }

    /* ------------------------- happy path: reject --------------------------- */

    function test_reject_refundsClient() public {
        uint256 jobId = _toSubmitted();
        uint256 clientBefore = usdc.balanceOf(client);

        JudgeEvaluator.Verdict memory v = _verdict(jobId, false);
        vm.prank(signer);
        judge.submitVerdict(v, _sign(v));

        IACP.Job memory job = acp.getJob(jobId);
        assertEq(uint256(job.status), uint256(IACP.JobStatus.Rejected));
        assertEq(usdc.balanceOf(client), clientBefore + BUDGET);
        assertEq(judge.rejectedCount(), 1);
    }

    /* ------------------------- relay (permissionless) ----------------------- */

    function test_relay_acceptsValidSignatureFromAnyone() public {
        uint256 jobId = _toSubmitted();
        JudgeEvaluator.Verdict memory v = _verdict(jobId, true);
        bytes memory sig = _sign(v);

        address relayer = makeAddr("relayer");
        vm.prank(relayer);
        judge.relay(v, sig);

        assertEq(uint256(acp.getJob(jobId).status), uint256(IACP.JobStatus.Completed));
    }

    /* ------------------------- failure modes -------------------------------- */

    function test_reverts_onBadSigner() public {
        uint256 jobId = _toSubmitted();
        JudgeEvaluator.Verdict memory v = _verdict(jobId, true);

        // Sign with a non-allowlisted key.
        uint256 badKey = 0xBAD;
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
        bytes32 digest = _hashTypedDataV4(structHash);
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(badKey, digest);
        bytes memory sig = abi.encodePacked(r, s, vv);

        vm.prank(signer);
        vm.expectRevert(JudgeEvaluator.BadSignature.selector);
        judge.submitVerdict(v, sig);
    }

    function test_reverts_onDoubleResolution() public {
        uint256 jobId = _toSubmitted();
        JudgeEvaluator.Verdict memory v = _verdict(jobId, true);
        vm.prank(signer);
        judge.submitVerdict(v, _sign(v));

        // Second verdict on same job: ACP state is now Completed → JobNotSubmitted.
        bytes memory sig = _sign(v);
        vm.prank(signer);
        vm.expectRevert(JudgeEvaluator.JobNotSubmitted.selector);
        judge.submitVerdict(v, sig);
    }

    function test_reverts_whenPaused() public {
        uint256 jobId = _toSubmitted();
        vm.prank(guardian);
        judge.setPaused(true);

        JudgeEvaluator.Verdict memory v = _verdict(jobId, true);
        bytes memory sig = _sign(v);
        vm.prank(signer);
        vm.expectRevert(JudgeEvaluator.Paused_.selector);
        judge.submitVerdict(v, sig);
    }

    function test_reverts_onCriteriaMismatch() public {
        // Criteria registered while Funded (before submission).
        uint256 jobId = _toSubmittedWithCriteria(CRITERIA);

        JudgeEvaluator.Verdict memory v = _verdict(jobId, true);
        v.criteriaHash = keccak256("different-criteria");

        bytes memory sig = _sign(v);
        vm.prank(signer);
        vm.expectRevert(JudgeEvaluator.CriteriaMismatch.selector);
        judge.submitVerdict(v, sig);
    }

    function test_reverts_onStaleVerdict() public {
        vm.warp(10 days); // ensure headroom so timestamp-2d doesn't underflow
        uint256 jobId = _toSubmitted();
        JudgeEvaluator.Verdict memory v = _verdict(jobId, true);
        v.timestamp = uint64(block.timestamp - 2 days); // older than 1 day window

        bytes memory sig = _sign(v);
        vm.prank(signer);
        vm.expectRevert(JudgeEvaluator.StaleVerdict.selector);
        judge.submitVerdict(v, sig);
    }

    /* ------------------------- guardian / admin ----------------------------- */

    function test_onlyGuardianCanPause() public {
        vm.expectRevert(JudgeEvaluator.NotGuardian.selector);
        judge.setPaused(true);
    }

    function test_ownerCanRotateSigner() public {
        address newSigner = makeAddr("newSigner");
        judge.setSigner(newSigner, true);
        assertTrue(judge.isSigner(newSigner));
        judge.setSigner(newSigner, false);
        assertFalse(judge.isSigner(newSigner));
    }

    /* ------------------------- threshold enforcement ------------------------ */

    // A PASS whose score is below its own declared threshold must revert: the
    // on-chain record can never claim "pass" while failing its own bar.
    function test_reverts_whenPassScoreBelowThreshold() public {
        uint256 jobId = _toSubmitted();
        JudgeEvaluator.Verdict memory v = _verdict(jobId, true);
        v.score = 40;
        v.threshold = 80; // pass=true but 40 < 80
        bytes memory sig = _sign(v);
        vm.prank(signer);
        vm.expectRevert(JudgeEvaluator.ScoreBelowThreshold.selector);
        judge.submitVerdict(v, sig);
    }

    function test_pass_atExactThreshold_succeeds() public {
        uint256 jobId = _toSubmitted();
        JudgeEvaluator.Verdict memory v = _verdict(jobId, true);
        v.score = 80;
        v.threshold = 80; // exactly at bar → allowed
        vm.prank(signer);
        judge.submitVerdict(v, _sign(v));
        assertEq(uint256(acp.getJob(jobId).status), uint256(IACP.JobStatus.Completed));
    }

    // A REJECT is unconstrained by threshold (score may be anything).
    function test_reject_belowThreshold_succeeds() public {
        uint256 jobId = _toSubmitted();
        JudgeEvaluator.Verdict memory v = _verdict(jobId, false);
        v.score = 10;
        v.threshold = 80;
        vm.prank(signer);
        judge.submitVerdict(v, _sign(v));
        assertEq(uint256(acp.getJob(jobId).status), uint256(IACP.JobStatus.Rejected));
    }

    /* --------------------- registerCriteria gating -------------------------- */

    // The exploit the gate closes: registering mismatched criteria AFTER a
    // provider submits would force a permanent CriteriaMismatch and strand the
    // work. Registration must be rejected once status >= Submitted.
    function test_registerCriteria_revertsAfterSubmission() public {
        uint256 jobId = _toSubmitted(); // already Submitted
        vm.prank(signer);
        vm.expectRevert(JudgeEvaluator.NotOpen.selector);
        judge.registerCriteria(jobId, CRITERIA);
    }

    function test_registerCriteria_isWriteOnce() public {
        vm.prank(client);
        uint256 jobId = acp.createJob(provider, address(judge), block.timestamp + 1 days, "job", address(0));
        vm.prank(signer);
        judge.registerCriteria(jobId, CRITERIA);
        vm.prank(signer);
        vm.expectRevert(JudgeEvaluator.AlreadyRegistered.selector);
        judge.registerCriteria(jobId, keccak256("other"));
    }

    function test_registerCriteria_onlySigner() public {
        vm.prank(client);
        uint256 jobId = acp.createJob(provider, address(judge), block.timestamp + 1 days, "job", address(0));
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(JudgeEvaluator.NotSigner.selector);
        judge.registerCriteria(jobId, CRITERIA);
    }

    // With matching registered criteria, a valid verdict settles normally.
    function test_registeredCriteria_matchingVerdict_completes() public {
        uint256 jobId = _toSubmittedWithCriteria(CRITERIA);
        JudgeEvaluator.Verdict memory v = _verdict(jobId, true); // criteriaHash == CRITERIA
        vm.prank(signer);
        judge.submitVerdict(v, _sign(v));
        assertEq(uint256(acp.getJob(jobId).status), uint256(IACP.JobStatus.Completed));
    }

    /* ----------------------------- withdraw --------------------------------- */

    function test_withdraw_ownerRecoversTokens() public {
        usdc.mint(address(judge), 1_000_000);
        address to = makeAddr("treasury");
        judge.withdraw(address(usdc), to, 1_000_000);
        assertEq(usdc.balanceOf(to), 1_000_000);
    }

    function test_withdraw_onlyOwner() public {
        usdc.mint(address(judge), 1_000_000);
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(); // Ownable: caller is not the owner
        judge.withdraw(address(usdc), stranger, 1_000_000);
    }

    /* ------------------------- deliverable binding -------------------------- */

    // The verdict's deliverable field is recorded verbatim; a verdict for a
    // different deliverable than submitted still settles the named job, but the
    // on-chain record shows the mismatch. (The service-side hash assertion is
    // what prevents grading substituted content; this documents the contract's
    // recorded evidence.)
    function test_verdict_recordsDeliverableAndScore() public {
        uint256 jobId = _toSubmitted();
        JudgeEvaluator.Verdict memory v = _verdict(jobId, true);
        vm.prank(signer);
        judge.submitVerdict(v, _sign(v));
        JudgeEvaluator.Verdict memory stored = judge.getVerdict(jobId);
        assertEq(stored.deliverable, DELIVERABLE);
        assertEq(stored.score, 100);
        assertEq(stored.threshold, 100);
    }

    /* ---------------- pre-mainnet review fixes (2026-09-28) ---------------- */

    // Renouncing ownership would freeze signer rotation, the guardian and withdraw forever.
    function test_renounceOwnership_isDisabled() public {
        vm.expectRevert(JudgeEvaluator.RenounceDisabled.selector);
        judge.renounceOwnership();
        assertEq(judge.owner(), owner);
    }

    // Ownership moves in two steps, so a typo cannot hand the judge to an address nobody controls.
    function test_ownershipTransfer_needsAcceptance() public {
        address next = makeAddr("next owner");
        judge.transferOwnership(next);
        assertEq(judge.owner(), owner, "unchanged until accepted");
        vm.prank(makeAddr("someone else"));
        vm.expectRevert();
        judge.acceptOwnership();
        vm.prank(next);
        judge.acceptOwnership();
        assertEq(judge.owner(), next);
    }

    // While paused nothing can bind criteria, so a leaked key cannot poison jobs in that window.
    function test_registerCriteria_blockedWhilePaused() public {
        vm.prank(client);
        uint256 jobId = acp.createJob(provider, address(judge), block.timestamp + 1 days, "job", address(0));
        vm.prank(guardian);
        judge.setPaused(true);
        vm.prank(signer);
        vm.expectRevert(JudgeEvaluator.Paused_.selector);
        judge.registerCriteria(jobId, CRITERIA);
    }

    // Criteria bind only jobs that name this judge.
    function test_registerCriteria_onlyForJobsNamingThisJudge() public {
        vm.prank(client);
        uint256 jobId =
            acp.createJob(provider, makeAddr("other evaluator"), block.timestamp + 1 days, "job", address(0));
        vm.prank(signer);
        vm.expectRevert(JudgeEvaluator.NotThisJudge.selector);
        judge.registerCriteria(jobId, CRITERIA);
    }

    // Criteria a leaked key registered before the pause can be cleared by the owner, and only the owner;
    // the job then settles on the honest verdict.
    function test_owner_canClearPoisonedCriteria() public {
        uint256 jobId = _toSubmittedWithCriteria(keccak256("poison"));
        JudgeEvaluator.Verdict memory v = _verdict(jobId, true); // the honest criteria, CRITERIA
        bytes memory sig = _sign(v);
        vm.expectRevert(JudgeEvaluator.CriteriaMismatch.selector);
        judge.relay(v, sig);
        vm.prank(signer);
        vm.expectRevert(); // Ownable: a signer is not the owner
        judge.clearCriteria(jobId);
        vm.expectEmit(true, false, false, true);
        emit JudgeEvaluator.CriteriaCleared(jobId, keccak256("poison"));
        judge.clearCriteria(jobId);
        assertEq(judge.jobCriteria(jobId), bytes32(0));
        vm.expectRevert(JudgeEvaluator.NothingRegistered.selector);
        judge.clearCriteria(jobId);
        judge.relay(v, sig);
        assertEq(uint8(acp.getJob(jobId).status), uint8(IACP.JobStatus.Completed));
    }
}
