// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/bnb/JudgeDeterministicPolicy.sol";
import "../src/bnb/JudgeRouter.sol";
import "../src/mocks/MockBnbCommerce.sol";
import "../src/mocks/MockUSDC.sol";

/// @notice Judge Protocol as a policy behind a router on BNB Chain's ERC-8183 kernel layout: a signed Judge
///         verdict, relayed by anyone as settle's evidence, is the only thing that settles a job; everything
///         else answers PENDING and the router reverts NotDecided, so no bad relay moves funds either way.
contract JudgeDeterministicPolicyTest is Test {
    MockUSDC usdc;
    MockBnbCommerce commerce;
    JudgeRouter router;
    JudgeDeterministicPolicy policy;

    address guardian = makeAddr("guardian");
    uint256 signerKey = 0xA11CE;
    address signer = vm.addr(signerKey);
    uint256 strangerKey = 0xB0B;
    address client = makeAddr("client");
    address provider = makeAddr("provider");
    address relayer = makeAddr("relayer");

    uint256 constant BUDGET = 5_000_000;
    bytes32 constant CRITERIA = keccak256("criteria-json-v1");
    bytes32 constant DELIVERABLE = keccak256("manifest-canonical-json");
    bytes32 constant EVIDENCE = keccak256("verdict-core-json");

    function setUp() public {
        usdc = new MockUSDC();
        commerce = new MockBnbCommerce(address(usdc));
        router = new JudgeRouter(address(commerce));
        address[] memory signers = new address[](1);
        signers[0] = signer;
        policy = new JudgeDeterministicPolicy(address(router), address(commerce), guardian, signers);
        router.setPolicyWhitelist(address(policy), true);
        usdc.mint(client, 100e6);
        vm.prank(client);
        usdc.approve(address(commerce), type(uint256).max);
        vm.warp(1_700_000_000);
    }

    /// A job the SDK would accept: router as evaluator and hook, policy registered before fund, then submitted.
    function _submittedJob() internal returns (uint256 jobId) {
        vm.prank(client);
        jobId = commerce.createJob(provider, address(router), block.timestamp + 7 days, "job with a judge-criteria block", address(router));
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

    function _sign(JudgeDeterministicPolicy.Verdict memory v, uint256 key) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(policy.VERDICT_TYPEHASH(), v.jobId, v.criteriaHash, v.deliverable, v.score, v.threshold, v.pass, v.evidenceHash, v.timestamp));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, vv);
    }

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("JudgeDeterministicPolicy"), keccak256("1"), block.chainid, address(policy)
        ));
    }

    function _evidence(JudgeDeterministicPolicy.Verdict memory v, uint256 key) internal view returns (bytes memory) {
        return abi.encode(v, _sign(v, key));
    }

    // ── the happy paths ──────────────────────────────────────────────────────

    function test_passVerdictRelayedByAnyonePaysTheProvider() public {
        uint256 jobId = _submittedJob();
        JudgeDeterministicPolicy.Verdict memory v = _verdict(jobId, true);
        vm.prank(relayer);
        router.settle(jobId, _evidence(v, signerKey));
        assertEq(usdc.balanceOf(provider), BUDGET, "escrow released to the provider");
        assertEq(uint8(commerce.getJob(jobId).status), uint8(IBnbCommerce.JobStatus.Completed));
    }

    function test_rejectVerdictRefundsTheClient() public {
        uint256 jobId = _submittedJob();
        uint256 before = usdc.balanceOf(client);
        vm.prank(relayer);
        router.settle(jobId, _evidence(_verdict(jobId, false), signerKey));
        assertEq(usdc.balanceOf(client), before + BUDGET, "escrow refunded to the client");
        assertEq(usdc.balanceOf(provider), 0);
        assertEq(uint8(commerce.getJob(jobId).status), uint8(IBnbCommerce.JobStatus.Rejected));
    }

    function test_theVerdictDigestMatchesWhatTheServiceSigns() public {
        uint256 jobId = _submittedJob();
        JudgeDeterministicPolicy.Verdict memory v = _verdict(jobId, true);
        bytes32 structHash = keccak256(abi.encode(policy.VERDICT_TYPEHASH(), v.jobId, v.criteriaHash, v.deliverable, v.score, v.threshold, v.pass, v.evidenceHash, v.timestamp));
        assertEq(policy.verdictDigest(v), keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash)));
    }

    function test_settleRecordsTheEvidenceHashAsTheReasonOnChain() public {
        uint256 jobId = _submittedJob();
        vm.expectEmit(true, true, true, true, address(router));
        emit JudgeRouter.JobSettled(jobId, address(policy), 1, EVIDENCE);
        router.settle(jobId, _evidence(_verdict(jobId, true), signerKey));
    }

    // ── what must never settle ───────────────────────────────────────────────

    function _assertNotDecided(uint256 jobId, bytes memory evidence) internal {
        (uint8 verdict, bytes32 reason) = policy.check(jobId, evidence);
        assertEq(verdict, 0, "PENDING");
        assertEq(reason, bytes32(0));
        vm.expectRevert(JudgeRouter.NotDecided.selector);
        router.settle(jobId, evidence);
        assertEq(uint8(commerce.getJob(jobId).status), uint8(IBnbCommerce.JobStatus.Submitted), "nothing moved");
    }

    function test_aSignatureFromAnUnknownKeyIsNotAVerdict() public {
        uint256 jobId = _submittedJob();
        _assertNotDecided(jobId, _evidence(_verdict(jobId, true), strangerKey));
    }

    function test_aVerdictForAnotherJobIsNotAVerdictForThisOne() public {
        uint256 a = _submittedJob();
        uint256 b = _submittedJob();
        bytes memory forB = _evidence(_verdict(b, true), signerKey);
        _assertNotDecided(a, forB);
        vm.prank(relayer);
        router.settle(b, forB); // and it still works for the job it names
        assertEq(uint8(commerce.getJob(b).status), uint8(IBnbCommerce.JobStatus.Completed));
    }

    function test_aVerdictOnOtherBytesThanTheProviderCommittedIsNotAVerdict() public {
        uint256 jobId = _submittedJob();
        JudgeDeterministicPolicy.Verdict memory v = _verdict(jobId, true);
        v.deliverable = keccak256("some other manifest");
        _assertNotDecided(jobId, _evidence(v, signerKey));
    }

    function test_aPassBelowTheThresholdIsNotAVerdict() public {
        uint256 jobId = _submittedJob();
        JudgeDeterministicPolicy.Verdict memory v = _verdict(jobId, true);
        v.score = 99; // pass claimed, bar not met: an inconsistent verdict is refused
        _assertNotDecided(jobId, _evidence(v, signerKey));
    }

    function test_aStaleVerdictIsNotAVerdict() public {
        uint256 jobId = _submittedJob();
        JudgeDeterministicPolicy.Verdict memory v = _verdict(jobId, true);
        bytes memory evidence = _evidence(v, signerKey);
        vm.warp(block.timestamp + 1 days + 1);
        _assertNotDecided(jobId, evidence);
    }

    function test_aVerdictFromBeforeTheSubmissionIsNotAVerdict() public {
        uint256 jobId = _submittedJob();
        JudgeDeterministicPolicy.Verdict memory v = _verdict(jobId, true);
        v.timestamp = uint64(block.timestamp - 1); // signed before the provider submitted
        _assertNotDecided(jobId, _evidence(v, signerKey));
    }

    function test_tamperedVerdictFieldsBreakTheSignature() public {
        uint256 jobId = _submittedJob();
        JudgeDeterministicPolicy.Verdict memory v = _verdict(jobId, false);
        bytes memory sig = _sign(v, signerKey);
        v.pass = true; v.score = 100; // flip the decision after signing
        _assertNotDecided(jobId, abi.encode(v, sig));
    }

    function test_aFutureDatedVerdictIsNotAVerdict() public {
        uint256 jobId = _submittedJob();
        JudgeDeterministicPolicy.Verdict memory v = _verdict(jobId, true);
        v.timestamp = uint64(block.timestamp + 1); // signed ahead of the chain's clock
        bytes memory evidence = _evidence(v, signerKey);
        _assertNotDecided(jobId, evidence);
        vm.warp(block.timestamp + 1); // the same bytes are a verdict once the chain reaches that time
        router.settle(jobId, evidence);
        assertEq(uint8(commerce.getJob(jobId).status), uint8(IBnbCommerce.JobStatus.Completed));
    }

    /// Whatever bytes arrive as evidence, an unsigned job never moves: settle either reverts or finds no verdict.
    function testFuzz_randomEvidenceNeverSettlesAJob(bytes calldata evidence) public {
        uint256 jobId = _submittedJob();
        try router.settle(jobId, evidence) {
            fail("random evidence settled a job");
        } catch {}
        assertEq(uint8(commerce.getJob(jobId).status), uint8(IBnbCommerce.JobStatus.Submitted), "nothing moved");
        assertEq(usdc.balanceOf(provider), 0);
    }

    function test_garbageAndShortEvidenceAreNotVerdicts() public {
        uint256 jobId = _submittedJob();
        _assertNotDecided(jobId, "");
        _assertNotDecided(jobId, hex"deadbeef");
        _assertNotDecided(jobId, abi.encode(_verdict(jobId, true))); // a verdict with no signature at all
    }

    function test_anUnsubmittedJobHasNothingToJudge() public {
        vm.prank(client);
        uint256 jobId = commerce.createJob(provider, address(router), block.timestamp + 7 days, "job", address(router));
        vm.prank(client);
        router.registerJob(jobId, address(policy));
        vm.prank(provider);
        commerce.setBudget(jobId, BUDGET, "");
        vm.prank(client);
        commerce.fund(jobId, BUDGET, "");
        bytes memory evidence = _evidence(_verdict(jobId, true), signerKey);
        (uint8 verdict,) = policy.check(jobId, evidence);
        assertEq(verdict, 0, "no submission recorded, so no verdict can bind to it");
        vm.expectRevert(JudgeRouter.NotDecided.selector);
        router.settle(jobId, evidence);
    }

    function test_aSettledJobCannotBeSettledAgain() public {
        uint256 jobId = _submittedJob();
        bytes memory evidence = _evidence(_verdict(jobId, true), signerKey);
        router.settle(jobId, evidence);
        vm.expectRevert(MockBnbCommerce.WrongStatus.selector); // the kernel refuses a second complete
        router.settle(jobId, evidence);
    }

    // ── pre-registered criteria (the same optional commitment JudgeEvaluator offers on Arc) ──

    /// A job that has the router as evaluator and hook and this policy registered, still Open.
    function _openRegisteredJob() internal returns (uint256 jobId) {
        vm.prank(client);
        jobId = commerce.createJob(provider, address(router), block.timestamp + 7 days, "job", address(router));
        vm.prank(client);
        router.registerJob(jobId, address(policy));
    }

    function _fundAndSubmit(uint256 jobId) internal {
        vm.prank(provider);
        commerce.setBudget(jobId, BUDGET, "");
        vm.prank(client);
        commerce.fund(jobId, BUDGET, "");
        vm.prank(provider);
        commerce.submit(jobId, DELIVERABLE, "");
    }

    function test_registeredCriteriaBindTheVerdict() public {
        uint256 jobId = _openRegisteredJob();
        vm.prank(signer);
        policy.registerCriteria(jobId, CRITERIA);
        assertEq(policy.jobCriteria(jobId), CRITERIA);
        _fundAndSubmit(jobId);
        JudgeDeterministicPolicy.Verdict memory other = _verdict(jobId, true);
        other.criteriaHash = keccak256("criteria the client never agreed to");
        _assertNotDecided(jobId, _evidence(other, signerKey));
        router.settle(jobId, _evidence(_verdict(jobId, true), signerKey)); // the registered criteria still settle
        assertEq(uint8(commerce.getJob(jobId).status), uint8(IBnbCommerce.JobStatus.Completed));
    }

    function test_withoutRegistrationAnyCriteriaHashIsAccepted() public {
        // Registration is optional, as on Arc: the criteria are also committed in the immutable job description.
        uint256 jobId = _submittedJob();
        assertEq(policy.jobCriteria(jobId), bytes32(0));
        router.settle(jobId, _evidence(_verdict(jobId, true), signerKey));
        assertEq(uint8(commerce.getJob(jobId).status), uint8(IBnbCommerce.JobStatus.Completed));
    }

    function test_criteriaAreWriteOnceAndNeverZero() public {
        uint256 jobId = _openRegisteredJob();
        vm.prank(signer);
        vm.expectRevert(JudgeDeterministicPolicy.ZeroCriteria.selector);
        policy.registerCriteria(jobId, bytes32(0));
        vm.prank(signer);
        policy.registerCriteria(jobId, CRITERIA);
        vm.prank(signer);
        vm.expectRevert(JudgeDeterministicPolicy.AlreadyRegistered.selector);
        policy.registerCriteria(jobId, keccak256("a later, different bar"));
        assertEq(policy.jobCriteria(jobId), CRITERIA);
    }

    function test_criteriaCannotBeRegisteredOnceTheProviderHasSubmitted() public {
        uint256 jobId = _submittedJob();
        vm.prank(signer);
        vm.expectRevert(JudgeDeterministicPolicy.NotOpen.selector);
        policy.registerCriteria(jobId, CRITERIA);
    }

    function test_criteriaCanBeRegisteredWhileFundedButNotSubmitted() public {
        uint256 jobId = _openRegisteredJob();
        vm.prank(provider);
        commerce.setBudget(jobId, BUDGET, "");
        vm.prank(client);
        commerce.fund(jobId, BUDGET, "");
        policy.registerCriteria(jobId, CRITERIA); // the owner (this test contract) may register too
        assertEq(policy.jobCriteria(jobId), CRITERIA);
    }

    function test_onlyASignerOrTheOwnerRegistersCriteria() public {
        uint256 jobId = _openRegisteredJob();
        vm.prank(client);
        vm.expectRevert(JudgeDeterministicPolicy.NotSigner.selector);
        policy.registerCriteria(jobId, CRITERIA);
        vm.prank(provider);
        vm.expectRevert(JudgeDeterministicPolicy.NotSigner.selector);
        policy.registerCriteria(jobId, CRITERIA);
    }

    function test_criteriaOnlyForJobsBoundToThisPolicy() public {
        vm.prank(client);
        uint256 unregistered = commerce.createJob(provider, address(router), block.timestamp + 7 days, "job", address(router));
        vm.prank(signer);
        vm.expectRevert(JudgeDeterministicPolicy.NotThisPolicy.selector);
        policy.registerCriteria(unregistered, CRITERIA);
    }

    function test_noCriteriaRegistrationWhilePaused() public {
        uint256 jobId = _openRegisteredJob();
        vm.prank(guardian);
        policy.setPaused(true);
        vm.prank(signer);
        vm.expectRevert(JudgeDeterministicPolicy.Paused_.selector);
        policy.registerCriteria(jobId, CRITERIA);
    }

    // ── pause, signers, roles ────────────────────────────────────────────────

    function test_pauseAnswersPendingAndTheKernelRefundStillWorks() public {
        uint256 jobId = _submittedJob();
        vm.prank(guardian);
        policy.setPaused(true);
        _assertNotDecided(jobId, _evidence(_verdict(jobId, true), signerKey));
        vm.warp(block.timestamp + 8 days);
        commerce.claimRefund(jobId); // funds are never locked by the judge
        assertEq(usdc.balanceOf(client), 100e6);
        vm.prank(guardian);
        policy.setPaused(false);
    }

    function test_onlyTheGuardianPausesAndOnlyTheOwnerRotatesSigners() public {
        vm.prank(client);
        vm.expectRevert(JudgeDeterministicPolicy.NotGuardian.selector);
        policy.setPaused(true);
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, client));
        policy.setSigner(client, true);
        vm.expectRevert(JudgeDeterministicPolicy.RenounceDisabled.selector);
        policy.renounceOwnership();
        policy.setSigner(signer, false);
        uint256 jobId = _submittedJob();
        _assertNotDecided(jobId, _evidence(_verdict(jobId, true), signerKey));
    }

    function test_onlyTheRouterRecordsSubmissions() public {
        vm.prank(client);
        vm.expectRevert(JudgeDeterministicPolicy.NotRouter.selector);
        policy.onSubmitted(1, DELIVERABLE, "");
    }

    // ── the router mirrors the official one where the SDK looks ─────────────

    function test_registerJobNeedsAWhitelistedPolicyTheClientAndRouterAsEvaluatorAndHook() public {
        JudgeDeterministicPolicy other = new JudgeDeterministicPolicy(address(router), address(commerce), guardian, new address[](0));
        vm.prank(client);
        uint256 good = commerce.createJob(provider, address(router), block.timestamp + 7 days, "job", address(router));
        vm.prank(client);
        vm.expectRevert(JudgeRouter.PolicyNotWhitelisted.selector);
        router.registerJob(good, address(other));
        vm.prank(provider);
        vm.expectRevert(JudgeRouter.NotJobClient.selector);
        router.registerJob(good, address(policy));
        vm.prank(client);
        uint256 wrongEvaluator = commerce.createJob(provider, client, block.timestamp + 7 days, "job", address(router));
        vm.prank(client);
        vm.expectRevert(JudgeRouter.RouterNotEvaluator.selector);
        router.registerJob(wrongEvaluator, address(policy));
        JudgeRouter otherRouter = new JudgeRouter(address(commerce)); // some other ERC-165 hook the kernel accepts
        vm.prank(client);
        uint256 wrongHook = commerce.createJob(provider, address(router), block.timestamp + 7 days, "job", address(otherRouter));
        vm.prank(client);
        vm.expectRevert(JudgeRouter.RouterNotHook.selector);
        router.registerJob(wrongHook, address(policy));
        vm.prank(client);
        router.registerJob(good, address(policy));
        vm.prank(client);
        vm.expectRevert(JudgeRouter.PolicyAlreadySet.selector);
        router.registerJob(good, address(policy));
        assertEq(router.jobPolicy(good), address(policy));
        assertTrue(router.policyWhitelist(address(policy)));
        assertFalse(router.policyWhitelist(address(other)));
    }

    function test_theMockKernelRequiresAnErc165HookLikeTheRealOne() public {
        vm.prank(client);
        vm.expectRevert(MockBnbCommerce.HookRequired.selector);
        commerce.createJob(provider, address(router), block.timestamp + 7 days, "job", address(0));
        vm.prank(client);
        vm.expectRevert(MockBnbCommerce.HookMissingInterface.selector);
        commerce.createJob(provider, address(router), block.timestamp + 7 days, "job", address(usdc));
    }

    function test_theClientMayAlsoSetTheBudgetAndTheRouterDoesNotMind() public {
        vm.prank(client);
        uint256 jobId = commerce.createJob(provider, address(router), block.timestamp + 7 days, "job", address(router));
        vm.prank(client);
        router.registerJob(jobId, address(policy));
        vm.prank(client); // the real kernel lets the client or the provider set the budget
        commerce.setBudget(jobId, BUDGET, "");
        vm.prank(client);
        commerce.fund(jobId, BUDGET, "");
        vm.prank(provider);
        commerce.submit(jobId, DELIVERABLE, "");
        router.settle(jobId, _evidence(_verdict(jobId, true), signerKey));
        assertEq(usdc.balanceOf(provider), BUDGET);
    }

    function test_hooksNeverBlockTheKernelForJobsTheRouterDoesNotKnow() public {
        // A job naming the router as hook but never registered: every kernel action still goes through.
        vm.prank(client);
        uint256 jobId = commerce.createJob(provider, address(router), block.timestamp + 7 days, "job", address(router));
        vm.prank(provider);
        commerce.setBudget(jobId, BUDGET, "");
        vm.prank(client);
        commerce.fund(jobId, BUDGET, "");
        vm.prank(provider);
        commerce.submit(jobId, DELIVERABLE, "");
        assertEq(policy.submitted(jobId), bytes32(0), "nothing recorded for an unregistered job");
        vm.expectRevert(JudgeRouter.PolicyNotSet.selector);
        router.settle(jobId, "");
    }

    function test_onlyTheKernelMayCallTheHooks() public {
        vm.expectRevert(JudgeRouter.NotCommerce.selector);
        router.afterAction(1, IBnbCommerce.submit.selector, abi.encode(DELIVERABLE, bytes("")));
        vm.expectRevert(JudgeRouter.NotCommerce.selector);
        router.beforeAction(1, IBnbCommerce.submit.selector, "");
        assertTrue(router.supportsInterface(type(IACPHook).interfaceId));
    }

    function test_markExpiredOnlyAfterTheKernelExpiredTheJob() public {
        uint256 jobId = _submittedJob();
        vm.expectRevert(JudgeRouter.NotExpired.selector);
        router.markExpired(jobId);
        vm.warp(block.timestamp + 8 days);
        commerce.claimRefund(jobId);
        router.markExpired(jobId);
    }
}
