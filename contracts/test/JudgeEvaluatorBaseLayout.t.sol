// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../src/JudgeEvaluator.sol";
import "../src/JudgeEvaluatorBaseLayout.sol";
import "../src/mocks/MockUSDC.sol";
import "./conformance/vendor/erc8183-base-contracts/ERC8183.sol";

/// @notice Judge as the evaluator on the ERC-8183 authors' own implementation (erc-8183/base-contracts at 142e669,
///         vendored unchanged), end to end: a job is created, priced in a per-job token, funded and submitted, and a
///         signed Judge verdict completes it (provider paid) or rejects it (client refunded).
contract JudgeEvaluatorBaseLayoutTest is Test {
    MockUSDC usdc;
    ERC8183 escrow;
    JudgeEvaluatorBaseLayout judge;

    address admin = makeAddr("admin");
    address guardian = makeAddr("guardian");
    uint256 signerKey = 0xA11CE;
    address signer = vm.addr(signerKey);
    address client = makeAddr("client");
    address provider = makeAddr("provider");

    uint256 constant BUDGET = 5_000_000;
    bytes32 constant CRITERIA = keccak256("criteria-json-v1");
    bytes32 constant DELIVERABLE = keccak256("deliverable-payload");
    bytes32 constant EVIDENCE = keccak256("verdict-json");

    function setUp() public {
        usdc = new MockUSDC();
        ERC8183 impl = new ERC8183();
        escrow = ERC8183(address(new ERC1967Proxy(address(impl), abi.encodeCall(ERC8183.initialize, (makeAddr("treasury"), admin)))));
        vm.prank(admin);
        escrow.setPaymentTokenAllowed(address(usdc), true);
        address[] memory signers = new address[](1);
        signers[0] = signer;
        judge = new JudgeEvaluatorBaseLayout(address(escrow), guardian, signers);
        usdc.mint(client, 100e6);
        vm.prank(client);
        usdc.approve(address(escrow), type(uint256).max);
    }

    function _funded(address evaluator) internal returns (uint256 jobId) {
        vm.prank(client);
        jobId = escrow.createJob(provider, evaluator, uint48(block.timestamp + 1 days), "job", address(0), 0);
        vm.prank(provider);
        escrow.setBudget(jobId, address(usdc), BUDGET, "");
        vm.prank(client);
        escrow.fund(jobId, address(usdc), BUDGET, "");
    }

    function _submit(uint256 jobId) internal {
        vm.prank(provider);
        escrow.submit(jobId, DELIVERABLE, "");
    }

    function _verdict(uint256 jobId, bool pass) internal view returns (JudgeEvaluatorBaseLayout.Verdict memory) {
        return JudgeEvaluatorBaseLayout.Verdict({
            jobId: jobId, criteriaHash: CRITERIA, deliverable: DELIVERABLE, score: pass ? 100 : 20, threshold: 100,
            pass: pass, evidenceHash: EVIDENCE, timestamp: uint64(block.timestamp)
        });
    }

    function _sign(JudgeEvaluatorBaseLayout.Verdict memory v) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(judge.VERDICT_TYPEHASH(), v.jobId, v.criteriaHash, v.deliverable,
            v.score, v.threshold, v.pass, v.evidenceHash, v.timestamp));
        return _sig(judge.DOMAIN_SEPARATOR(), structHash);
    }

    function _sig(bytes32 domain, bytes32 structHash) internal view returns (bytes memory) {
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(signerKey, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        return abi.encodePacked(r, s, vv);
    }

    function test_passCompletesAndPaysTheProvider() public {
        uint256 jobId = _funded(address(judge));
        vm.prank(signer);
        judge.registerCriteria(jobId, CRITERIA);
        _submit(jobId);
        JudgeEvaluatorBaseLayout.Verdict memory v = _verdict(jobId, true);
        bytes memory sig = _sign(v);
        vm.prank(signer);
        judge.submitVerdict(v, sig);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(ERC8183.JobStatus.Completed));
        assertEq(usdc.balanceOf(provider), BUDGET, "provider paid the budget (no fees configured)");
        assertEq(judge.getVerdict(jobId).evidenceHash, EVIDENCE);
    }

    function test_failRejectsAndRefundsTheClient() public {
        uint256 jobId = _funded(address(judge));
        _submit(jobId);
        uint256 before = usdc.balanceOf(client);
        JudgeEvaluatorBaseLayout.Verdict memory v = _verdict(jobId, false);
        bytes memory sig = _sign(v);
        vm.prank(signer);
        judge.submitVerdict(v, sig);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(ERC8183.JobStatus.Rejected));
        assertEq(usdc.balanceOf(client), before + BUDGET, "client refunded in full");
        assertEq(usdc.balanceOf(provider), 0);
    }

    function test_refusesBeforeSubmission() public {
        uint256 jobId = _funded(address(judge));
        JudgeEvaluatorBaseLayout.Verdict memory v = _verdict(jobId, true);
        bytes memory sig = _sign(v);
        vm.prank(signer);
        vm.expectRevert(JudgeEvaluatorBaseLayout.JobNotSubmitted.selector);
        judge.submitVerdict(v, sig);
    }

    function test_refusesAJobThatNamesAnotherEvaluator() public {
        uint256 jobId = _funded(makeAddr("someoneElse"));
        _submit(jobId);
        JudgeEvaluatorBaseLayout.Verdict memory v = _verdict(jobId, true);
        bytes memory sig = _sign(v);
        vm.prank(signer);
        vm.expectRevert(JudgeEvaluatorBaseLayout.JobNotSubmitted.selector);
        judge.submitVerdict(v, sig);
        vm.prank(signer);
        vm.expectRevert(JudgeEvaluatorBaseLayout.NotThisJudge.selector);
        judge.registerCriteria(jobId, CRITERIA);
    }

    function test_criteriaCannotBeRegisteredOnceSubmitted() public {
        uint256 jobId = _funded(address(judge));
        _submit(jobId);
        vm.prank(signer);
        vm.expectRevert(JudgeEvaluatorBaseLayout.NotOpen.selector);
        judge.registerCriteria(jobId, CRITERIA);
    }

    function test_registeredCriteriaBindTheVerdict() public {
        uint256 jobId = _funded(address(judge));
        vm.prank(signer);
        judge.registerCriteria(jobId, keccak256("other criteria"));
        _submit(jobId);
        JudgeEvaluatorBaseLayout.Verdict memory v = _verdict(jobId, true);
        bytes memory sig = _sign(v);
        vm.prank(signer);
        vm.expectRevert(JudgeEvaluatorBaseLayout.CriteriaMismatch.selector);
        judge.submitVerdict(v, sig);
    }

    /// The published-layout judge cannot read this escrow's jobs, which is why the layout subclass exists.
    function test_thePublishedLayoutJudgeCannotReadThisEscrow() public {
        address[] memory signers = new address[](1);
        signers[0] = signer;
        JudgeEvaluator plain = new JudgeEvaluator(address(escrow), guardian, signers);
        uint256 jobId = _funded(address(plain));
        // registerCriteria needs no signature: it fails only because the 13-field job cannot be read as the 9-field one.
        vm.prank(signer);
        vm.expectRevert();
        plain.registerCriteria(jobId, CRITERIA);
        _submit(jobId);
        JudgeEvaluator.Verdict memory v = JudgeEvaluator.Verdict({
            jobId: jobId, criteriaHash: CRITERIA, deliverable: DELIVERABLE, score: 100, threshold: 100,
            pass: true, evidenceHash: EVIDENCE, timestamp: uint64(block.timestamp)
        });
        bytes memory sig = _sig(plain.DOMAIN_SEPARATOR(), keccak256(abi.encode(plain.VERDICT_TYPEHASH(), v.jobId,
            v.criteriaHash, v.deliverable, v.score, v.threshold, v.pass, v.evidenceHash, v.timestamp)));
        vm.prank(signer);
        vm.expectRevert();
        plain.submitVerdict(v, sig);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(ERC8183.JobStatus.Submitted), "nothing moved");
    }
}
