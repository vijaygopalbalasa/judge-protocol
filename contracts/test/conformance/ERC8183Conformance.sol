// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";

interface IERC20Balance {
    function balanceOf(address) external view returns (uint256);
}

/// @notice ERC-8183 (Agentic Commerce) conformance: each SHALL rule of the draft's Specification section
///         (ethereum/ERCs, ERCS/erc-8183.md at a078cab) is one test, run unchanged against every implementation.
///         A target contract says how to call its escrow (its ABI) and how to read a job; the tests never assume
///         more than the spec. A failing test is a finding about the implementation, not a broken build, so every
///         target skips unless ERC8183_CONFORMANCE=1 (and, on a fork, its RPC) is set:
///           ERC8183_CONFORMANCE=1 forge test --match-path 'test/conformance/*' -vv
///         Tests named test_should_ check SHOULD or RECOMMENDED rules; the rest check SHALL or MUST rules.
abstract contract ERC8183Conformance is Test {
    enum Status { Open, Funded, Submitted, Completed, Rejected, Expired }

    struct JobView {
        address client;
        address provider;
        address evaluator;
        uint256 budget;
        uint256 expiredAt;
        Status status;
    }

    address internal client = makeAddr("erc8183-client");
    address internal provider = makeAddr("erc8183-provider");
    address internal evaluator = makeAddr("erc8183-evaluator");
    address internal stranger = makeAddr("erc8183-stranger");
    uint256 internal constant BUDGET = 1_000_000; // 1.00 in a 6-decimal stablecoin
    uint256 internal constant LIFETIME = 2 days; // longer than any minimum lifetime an implementation enforces
    bytes32 internal constant DELIVERABLE = keccak256("erc8183 conformance deliverable");
    bytes32 internal constant REASON = keccak256("erc8183 conformance reason");

    bool internal ready;

    // ───────────── what each target provides ─────────────

    /// Fork or deploy the target; return false to skip (conformance not enabled, no RPC, or the escrow is paused).
    function _setUpTarget() internal virtual returns (bool);
    function _escrow() internal view virtual returns (address);
    function _token() internal view virtual returns (address);
    /// Give `who` `amount` of the payment token and approve the escrow for it.
    function _giveTokens(address who, uint256 amount) internal virtual;
    function _createJobData(address provider_, address evaluator_, uint256 expiredAt) internal view virtual returns (bytes memory);
    function _setProviderData(uint256 jobId, address provider_) internal view virtual returns (bytes memory);
    function _setBudgetData(uint256 jobId, uint256 amount) internal view virtual returns (bytes memory);
    /// Implementations without an expectedBudget argument ignore `expected`; the front-running test then fails, as it should.
    function _fundData(uint256 jobId, uint256 expected) internal view virtual returns (bytes memory);
    function _submitData(uint256 jobId, bytes32 deliverable) internal view virtual returns (bytes memory);
    function _completeData(uint256 jobId, bytes32 reason) internal view virtual returns (bytes memory);
    function _rejectData(uint256 jobId, bytes32 reason) internal view virtual returns (bytes memory);
    function _claimRefundData(uint256 jobId) internal view virtual returns (bytes memory);
    function _job(uint256 jobId) internal view virtual returns (JobView memory);

    /// Real implementations are measured only on request; the suite's self-check (an escrow written from the spec)
    /// always runs, so `forge test` and CI keep the suite honest.
    function _enabled() internal view virtual returns (bool) {
        return vm.envOr("ERC8183_CONFORMANCE", false);
    }

    function setUp() public {
        ready = _enabled() && _setUpTarget();
    }

    modifier conformance() {
        vm.skip(!ready);
        _;
    }

    // ───────────── helpers ─────────────

    function _call(address actor, bytes memory data) internal returns (bool ok, bytes memory ret) {
        vm.prank(actor);
        (ok, ret) = _escrow().call(data);
    }

    function _must(address actor, bytes memory data, string memory what) internal returns (bytes memory ret) {
        bool ok;
        (ok, ret) = _call(actor, data);
        assertTrue(ok, string.concat("this call must succeed: ", what));
    }

    function _create(address provider_) internal returns (uint256 jobId) {
        bytes memory ret = _must(client, _createJobData(provider_, evaluator, block.timestamp + LIFETIME), "createJob");
        jobId = abi.decode(ret, (uint256));
    }

    function _open() internal returns (uint256) {
        return _create(provider);
    }

    /// An Open job with its budget set. The provider sets it: every implementation so far lets the provider.
    function _budgeted() internal returns (uint256 jobId) {
        jobId = _open();
        _must(provider, _setBudgetData(jobId, BUDGET), "setBudget by the provider");
    }

    function _funded() internal returns (uint256 jobId) {
        jobId = _budgeted();
        _giveTokens(client, BUDGET);
        _must(client, _fundData(jobId, BUDGET), "fund by the client");
    }

    function _submitted() internal returns (uint256 jobId) {
        jobId = _funded();
        _must(provider, _submitData(jobId, DELIVERABLE), "submit by the provider");
    }

    /// Another client's funded job, so the escrow holds money that is not the job under test: a second payout or refund
    /// of a settled job then has funds to take, and a test sees it instead of an empty escrow reverting by accident.
    function _bystander() internal returns (uint256 jobId) {
        address other = makeAddr("erc8183-bystander-client");
        vm.prank(other);
        (bool ok, bytes memory ret) = _escrow().call(_createJobData(provider, evaluator, block.timestamp + LIFETIME * 4));
        assertTrue(ok, "createJob for the bystander");
        jobId = abi.decode(ret, (uint256));
        _must(provider, _setBudgetData(jobId, BUDGET), "setBudget for the bystander");
        _giveTokens(other, BUDGET);
        _must(other, _fundData(jobId, BUDGET), "fund the bystander job");
    }

    function _status(uint256 jobId) internal view returns (Status) {
        return _job(jobId).status;
    }

    function _bal(address who) internal view returns (uint256) {
        return IERC20Balance(_token()).balanceOf(who);
    }

    function _fails(address actor, bytes memory data) internal returns (bool) {
        (bool ok,) = _call(actor, data);
        return !ok;
    }

    // ───────────── createJob ─────────────

    /// createJob: "Creates job in Open with client = msg.sender, provider, evaluator, expiredAt".
    function test_createJob_opensAJobForTheCaller() public conformance {
        uint256 expiredAt = block.timestamp + LIFETIME;
        bytes memory ret = _must(client, _createJobData(provider, evaluator, expiredAt), "createJob");
        JobView memory j = _job(abi.decode(ret, (uint256)));
        assertEq(j.client, client, "client is the caller");
        assertEq(j.provider, provider, "provider as given");
        assertEq(j.evaluator, evaluator, "evaluator as given");
        assertEq(j.expiredAt, expiredAt, "expiredAt as given");
        assertEq(uint8(j.status), uint8(Status.Open), "status Open");
    }

    /// createJob: "SHALL revert if evaluator is zero".
    function test_createJob_revertsWithoutAnEvaluator() public conformance {
        assertTrue(_fails(client, _createJobData(provider, address(0), block.timestamp + LIFETIME)), "a zero evaluator was accepted");
    }

    /// createJob: "SHALL revert if ... expiredAt is not in the future".
    function test_createJob_revertsWhenExpiryIsNotInTheFuture() public conformance {
        assertTrue(_fails(client, _createJobData(provider, evaluator, block.timestamp)), "expiredAt == now was accepted");
        assertTrue(_fails(client, _createJobData(provider, evaluator, block.timestamp - 1)), "a past expiredAt was accepted");
    }

    // ───────────── setProvider (only where a job may start without a provider) ─────────────

    /// setProvider: client only, only while Open, only while the provider is unset, never to zero.
    function test_setProvider_clientOnlyOnceAndNeverZero() public conformance {
        (bool ok, bytes memory ret) = _call(client, _createJobData(address(0), evaluator, block.timestamp + LIFETIME));
        vm.skip(!ok); // "Provider MAY be zero at creation": not offered here, so setProvider does not apply
        uint256 jobId = abi.decode(ret, (uint256));
        assertTrue(_fails(stranger, _setProviderData(jobId, provider)), "a stranger set the provider");
        assertTrue(_fails(client, _setProviderData(jobId, address(0))), "the provider was set to zero");
        _must(client, _setProviderData(jobId, provider), "setProvider by the client");
        assertEq(_job(jobId).provider, provider);
        assertTrue(_fails(client, _setProviderData(jobId, stranger)), "the provider was replaced");
    }

    /// fund: "SHALL revert if job.provider == address(0) (provider MUST be set before funding)".
    function test_fund_revertsWhileTheProviderIsUnset() public conformance {
        (bool ok, bytes memory ret) = _call(client, _createJobData(address(0), evaluator, block.timestamp + LIFETIME));
        vm.skip(!ok);
        uint256 jobId = abi.decode(ret, (uint256));
        _call(client, _setBudgetData(jobId, BUDGET)); // a client may set the budget; if this one may not, the job stays at 0
        _giveTokens(client, BUDGET);
        assertTrue(_fails(client, _fundData(jobId, _job(jobId).budget)), "a job without a provider was funded");
    }

    // ───────────── setBudget ─────────────

    /// setBudget: "Called by client or provider" (the client may set the price).
    function test_setBudget_theClientMaySetIt() public conformance {
        uint256 jobId = _open();
        _must(client, _setBudgetData(jobId, BUDGET), "setBudget by the client");
        assertEq(_job(jobId).budget, BUDGET);
    }

    /// setBudget: "Called by client or provider" (the provider may set the price).
    function test_setBudget_theProviderMaySetIt() public conformance {
        uint256 jobId = _open();
        _must(provider, _setBudgetData(jobId, BUDGET), "setBudget by the provider");
        assertEq(_job(jobId).budget, BUDGET);
    }

    /// setBudget: "SHALL revert if ... caller is not client or provider".
    function test_setBudget_revertsForAnyoneElse() public conformance {
        uint256 jobId = _open();
        assertTrue(_fails(stranger, _setBudgetData(jobId, BUDGET)), "a stranger set the budget");
        assertTrue(_fails(evaluator, _setBudgetData(jobId, BUDGET)), "the evaluator set the budget");
    }

    /// setBudget: "SHALL revert if job is not Open".
    function test_setBudget_revertsOnceFunded() public conformance {
        uint256 jobId = _funded();
        assertTrue(_fails(provider, _setBudgetData(jobId, BUDGET * 2)), "the budget changed after funding");
        assertEq(_job(jobId).budget, BUDGET);
    }

    // ───────────── fund ─────────────

    /// fund: "Called by client" ("SHALL revert if ... caller is not client").
    function test_fund_revertsForAnyoneButTheClient() public conformance {
        uint256 jobId = _budgeted();
        _giveTokens(stranger, BUDGET);
        _giveTokens(provider, BUDGET);
        assertTrue(_fails(stranger, _fundData(jobId, BUDGET)), "a stranger funded the job");
        assertTrue(_fails(provider, _fundData(jobId, BUDGET)), "the provider funded the job");
    }

    /// fund: "SHALL revert if ... budget is zero".
    function test_fund_revertsWhenTheBudgetIsZero() public conformance {
        uint256 jobId = _open();
        _giveTokens(client, BUDGET);
        assertTrue(_fails(client, _fundData(jobId, 0)), "a zero-budget job was funded");
    }

    /// fund: "SHALL revert if ... job.budget != expectedBudget (front-running protection)".
    function test_fund_revertsWhenTheBudgetIsNotTheExpectedOne() public conformance {
        uint256 jobId = _budgeted();
        _giveTokens(client, BUDGET * 2);
        assertTrue(_fails(client, _fundData(jobId, BUDGET - 1)), "funded although expectedBudget differs from the budget");
    }

    /// fund: "SHALL transfer job.budget of the payment token from client to the contract (escrow) and set status to Funded".
    function test_fund_movesExactlyTheBudgetIntoEscrow() public conformance {
        uint256 jobId = _budgeted();
        _giveTokens(client, BUDGET);
        uint256 clientBefore = _bal(client);
        uint256 escrowBefore = _bal(_escrow());
        _must(client, _fundData(jobId, BUDGET), "fund by the client");
        assertEq(clientBefore - _bal(client), BUDGET, "the client paid exactly the budget");
        assertEq(_bal(_escrow()) - escrowBefore, BUDGET, "the escrow holds exactly the budget");
        assertEq(uint8(_status(jobId)), uint8(Status.Funded), "status Funded");
    }

    /// fund: "SHALL revert if job is not Open" (a job is funded once).
    function test_fund_revertsOnceFunded() public conformance {
        uint256 jobId = _funded();
        _giveTokens(client, BUDGET);
        assertTrue(_fails(client, _fundData(jobId, BUDGET)), "a job was funded twice");
    }

    // ───────────── submit ─────────────

    /// submit: "Called by provider only".
    function test_submit_revertsForAnyoneButTheProvider() public conformance {
        uint256 jobId = _funded();
        assertTrue(_fails(client, _submitData(jobId, DELIVERABLE)), "the client submitted");
        assertTrue(_fails(evaluator, _submitData(jobId, DELIVERABLE)), "the evaluator submitted");
        assertTrue(_fails(stranger, _submitData(jobId, DELIVERABLE)), "a stranger submitted");
    }

    /// submit: "SHALL revert if job is not Funded" (an Open job, with or without a budget).
    function test_submit_revertsUnlessFunded() public conformance {
        uint256 unpriced = _open();
        assertTrue(_fails(provider, _submitData(unpriced, DELIVERABLE)), "work was submitted on an unfunded job with no budget");
        uint256 priced = _budgeted();
        assertTrue(_fails(provider, _submitData(priced, DELIVERABLE)), "work was submitted on an unfunded job");
    }

    /// submit: "SHALL set status to Submitted" and "SHALL emit an event including deliverable".
    function test_submit_recordsTheWorkAndEmitsTheDeliverable() public conformance {
        uint256 jobId = _funded();
        vm.recordLogs();
        _must(provider, _submitData(jobId, DELIVERABLE), "submit by the provider");
        assertEq(uint8(_status(jobId)), uint8(Status.Submitted), "status Submitted");
        assertTrue(_loggedWord(DELIVERABLE), "no event from the escrow carries the deliverable");
    }

    // ───────────── complete ─────────────

    /// complete: "Called by evaluator only".
    function test_complete_revertsForAnyoneButTheEvaluator() public conformance {
        uint256 jobId = _submitted();
        assertTrue(_fails(client, _completeData(jobId, REASON)), "the client completed");
        assertTrue(_fails(provider, _completeData(jobId, REASON)), "the provider completed");
        assertTrue(_fails(stranger, _completeData(jobId, REASON)), "a stranger completed");
    }

    /// complete: "SHALL revert if job is not Submitted".
    function test_complete_revertsUnlessSubmitted() public conformance {
        uint256 jobId = _funded();
        assertTrue(_fails(evaluator, _completeData(jobId, REASON)), "a job was completed before any work was submitted");
    }

    /// complete: "SHALL set status to Completed. SHALL transfer escrowed funds to provider (minus optional platform
    /// fee)". Fees only ever reduce the provider's share: the client gets nothing back and the escrow lets go of
    /// exactly the budget.
    function test_complete_paysTheProviderFromTheEscrow() public conformance {
        uint256 jobId = _submitted();
        uint256 providerBefore = _bal(provider);
        uint256 clientBefore = _bal(client);
        uint256 escrowBefore = _bal(_escrow());
        _must(evaluator, _completeData(jobId, REASON), "complete by the evaluator");
        assertEq(uint8(_status(jobId)), uint8(Status.Completed), "status Completed");
        assertGt(_bal(provider), providerBefore, "the provider was paid");
        assertLe(_bal(provider) - providerBefore, BUDGET, "the provider got at most the budget");
        assertEq(_bal(client), clientBefore, "the client got nothing back");
        assertEq(escrowBefore - _bal(_escrow()), BUDGET, "the escrow released exactly the budget");
    }

    // ───────────── reject ─────────────

    /// reject: "Called by client when job is Open".
    function test_reject_anOpenJobByTheClientOnly() public conformance {
        uint256 jobId = _open();
        assertTrue(_fails(provider, _rejectData(jobId, REASON)), "the provider rejected an Open job");
        assertTrue(_fails(evaluator, _rejectData(jobId, REASON)), "the evaluator rejected an Open job");
        assertTrue(_fails(stranger, _rejectData(jobId, REASON)), "a stranger rejected an Open job");
        _must(client, _rejectData(jobId, REASON), "reject an Open job by the client");
        assertEq(uint8(_status(jobId)), uint8(Status.Rejected), "status Rejected");
    }

    /// reject: "by evaluator when job is Funded ... If Funded or Submitted, SHALL refund escrow to client".
    function test_reject_aFundedJobByTheEvaluatorRefundsInFull() public conformance {
        uint256 jobId = _funded();
        assertTrue(_fails(client, _rejectData(jobId, REASON)), "the client took back a Funded job");
        assertTrue(_fails(provider, _rejectData(jobId, REASON)), "the provider rejected a Funded job");
        assertTrue(_fails(stranger, _rejectData(jobId, REASON)), "a stranger rejected a Funded job");
        uint256 clientBefore = _bal(client);
        _must(evaluator, _rejectData(jobId, REASON), "reject a Funded job by the evaluator");
        assertEq(uint8(_status(jobId)), uint8(Status.Rejected), "status Rejected");
        assertEq(_bal(client) - clientBefore, BUDGET, "the client got the whole budget back");
    }

    /// reject: "by evaluator when job is ... Submitted ... SHALL refund escrow to client". Fees: "SHALL be deducted
    /// only on completion (not on refund)".
    function test_reject_aSubmittedJobByTheEvaluatorRefundsInFull() public conformance {
        uint256 jobId = _submitted();
        assertTrue(_fails(client, _rejectData(jobId, REASON)), "the client rejected submitted work");
        assertTrue(_fails(provider, _rejectData(jobId, REASON)), "the provider rejected submitted work");
        uint256 clientBefore = _bal(client);
        _must(evaluator, _rejectData(jobId, REASON), "reject submitted work by the evaluator");
        assertEq(uint8(_status(jobId)), uint8(Status.Rejected), "status Rejected");
        assertEq(_bal(client) - clientBefore, BUDGET, "the client got the whole budget back");
    }

    // ───────────── claimRefund ─────────────

    /// claimRefund: "SHALL revert if ... the job has not yet expired".
    function test_claimRefund_revertsBeforeExpiry() public conformance {
        uint256 jobId = _funded();
        vm.warp(_job(jobId).expiredAt - 1);
        assertTrue(_fails(client, _claimRefundData(jobId)), "refunded before expiry");
    }

    /// claimRefund: "Callable when job is Funded ... and the job has expired (block.timestamp >= expiredAt) ...
    /// SHALL transfer full escrow to client and set status to Expired".
    function test_claimRefund_aFundedJobAtExpiryRefundsInFull() public conformance {
        uint256 jobId = _funded();
        vm.warp(_job(jobId).expiredAt);
        uint256 clientBefore = _bal(client);
        _must(client, _claimRefundData(jobId), "claimRefund at expiredAt");
        assertEq(uint8(_status(jobId)), uint8(Status.Expired), "status Expired");
        assertEq(_bal(client) - clientBefore, BUDGET, "the client got the whole budget back");
    }

    /// claimRefund: "Callable when job is ... Submitted and the job has expired ... SHALL transfer full escrow to client".
    function test_claimRefund_aSubmittedJobAtExpiryRefundsInFull() public conformance {
        uint256 jobId = _submitted();
        vm.warp(_job(jobId).expiredAt);
        uint256 clientBefore = _bal(client);
        _must(client, _claimRefundData(jobId), "claimRefund of submitted work at expiredAt");
        assertEq(uint8(_status(jobId)), uint8(Status.Expired), "status Expired");
        assertEq(_bal(client) - clientBefore, BUDGET, "the client got the whole budget back");
    }

    /// claimRefund: "SHALL revert if job is not Funded or Submitted" (Open, or already settled).
    function test_claimRefund_revertsForOpenOrSettledJobs() public conformance {
        _bystander();
        uint256 open = _open();
        uint256 rejected = _funded();
        _must(evaluator, _rejectData(rejected, REASON), "reject by the evaluator");
        uint256 escrowAfter = _bal(_escrow());
        vm.warp(block.timestamp + LIFETIME + 1);
        assertTrue(_fails(client, _claimRefundData(open)), "an Open job was refunded");
        assertTrue(_fails(client, _claimRefundData(rejected)), "a Rejected job was refunded again");
        assertEq(_bal(_escrow()), escrowAfter, "money left the escrow");
    }

    /// "the specification RECOMMENDS allowing anyone to trigger refund after expiry".
    function test_should_claimRefund_anyoneMayTriggerIt() public conformance {
        uint256 jobId = _funded();
        vm.warp(_job(jobId).expiredAt);
        uint256 clientBefore = _bal(client);
        _must(stranger, _claimRefundData(jobId), "claimRefund by a stranger");
        assertEq(_bal(client) - clientBefore, BUDGET, "the refund went to the client, not the caller");
    }

    // ───────────── terminal states ─────────────

    /// "Completed. Terminal." No transition leaves it, and the money cannot move twice.
    function test_completed_isFinal() public conformance {
        _bystander();
        uint256 jobId = _submitted();
        _must(evaluator, _completeData(jobId, REASON), "complete by the evaluator");
        uint256 escrowAfter = _bal(_escrow());
        vm.warp(block.timestamp + LIFETIME + 1);
        assertTrue(_fails(evaluator, _completeData(jobId, REASON)), "completed twice");
        assertTrue(_fails(evaluator, _rejectData(jobId, REASON)), "rejected after completion");
        assertTrue(_fails(client, _claimRefundData(jobId)), "refunded after completion");
        assertEq(uint8(_status(jobId)), uint8(Status.Completed));
        assertEq(_bal(_escrow()), escrowAfter, "money left the escrow after the job was settled");
    }

    /// "Rejected. Terminal." / "Expired. Terminal."
    function test_rejectedAndExpired_areFinal() public conformance {
        _bystander();
        uint256 rejected = _funded();
        _must(evaluator, _rejectData(rejected, REASON), "reject by the evaluator");
        uint256 expired = _funded();
        vm.warp(_job(expired).expiredAt);
        _must(client, _claimRefundData(expired), "claimRefund at expiry");
        uint256 escrowAfter = _bal(_escrow());
        assertTrue(_fails(provider, _submitData(rejected, DELIVERABLE)), "work submitted to a Rejected job");
        assertTrue(_fails(evaluator, _completeData(rejected, REASON)), "a Rejected job was completed");
        assertTrue(_fails(evaluator, _rejectData(rejected, REASON)), "a Rejected job was rejected again");
        assertTrue(_fails(provider, _submitData(expired, DELIVERABLE)), "work submitted to an Expired job");
        assertTrue(_fails(evaluator, _rejectData(expired, REASON)), "an Expired job was rejected");
        assertTrue(_fails(client, _claimRefundData(expired)), "an Expired job was refunded again");
        assertEq(uint8(_status(rejected)), uint8(Status.Rejected));
        assertEq(uint8(_status(expired)), uint8(Status.Expired));
        assertEq(_bal(_escrow()), escrowAfter, "money left the escrow after the jobs were settled");
    }

    // ───────────── log reading ─────────────

    /// True if any log the escrow emitted since recordLogs carries `word` as a topic or as a 32-byte data word.
    function _loggedWord(bytes32 word) internal returns (bool) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != _escrow()) continue;
            for (uint256 t = 0; t < logs[i].topics.length; t++) {
                if (logs[i].topics[t] == word) return true;
            }
            bytes memory d = logs[i].data;
            for (uint256 o = 0; o + 32 <= d.length; o += 32) {
                bytes32 w;
                assembly { w := mload(add(add(d, 32), o)) }
                if (w == word) return true;
            }
        }
        return false;
    }
}
