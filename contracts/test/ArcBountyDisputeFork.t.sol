// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/mocks/MockUSDC.sol";
import "../src/interfaces/IACP.sol";

/// @notice ArcBounty's five dispute paths, run against its live BountyAdapter (V4.7) and escrow on a fork of
///         Arc mainnet: disputeBounty, respondToDispute, resolveDispute, claimDefaultRuling and
///         claimArbitratorTimeout. Asked for in Sofiia7/ARC#4. The adapter and the escrow are the real deployed
///         code on real mainnet state; Arc's USDC moves native balances in a way a local fork cannot execute,
///         so a standard ERC-20 stands in at the USDC address, as in ArcMainnetFork.t.sol.
///           ARC_MAINNET_RPC=https://rpc.mainnet.arc.io forge test --match-contract ArcBountyDisputeFork -vv
interface IBountyAdapterV47 {
    struct CreateParams {
        address provider;
        uint256 reward;
        uint256 deadline;
        string ipfsDescHash;
        string category;
        string[] tags;
        bool agentOnly;
        bool humanOnly;
        bool requireWorkerBond;
    }

    struct BountyMeta {
        uint256 jobId;
        address poster;
        uint256 reward;
        uint256 deadline;
        string ipfsDescHash;
        string category;
        string[] tags;
        uint256 agentId;
        bool agentOnly;
        bool humanOnly;
        address whitelistedProvider;
        address assignedProvider;
        string submittedResultHash;
        uint256 submittedAt;
        bool isTaken;
        uint256 rejectedAt;
        string rejectionReasonHash;
        bool inDispute;
        bool resolved;
        address disputeInitiator;
        uint256 disputeRaisedAt;
        string disputeReasonHash;
        string disputeResponseHash;
        string disputeRulingHash;
        bool requireWorkerBond;
        uint256 workerBond;
    }

    function createBounty(CreateParams calldata p) external returns (uint256 jobId);
    function takeBounty(uint256 jobId, uint256 agentId) external;
    function submitWork(uint256 jobId, string calldata ipfsResultHash) external;
    function disputeBounty(uint256 jobId, string calldata ipfsReasonHash) external;
    function respondToDispute(uint256 jobId, string calldata ipfsResponseHash) external;
    function resolveDispute(uint256 jobId, bool payProvider, string calldata ipfsRulingHash, uint8 reputationPenalty) external;
    function claimDefaultRuling(uint256 jobId) external;
    function claimArbitratorTimeout(uint256 jobId) external;
    function autoApprove(uint256 jobId) external;
    function approveBounty(uint256 jobId, uint8 reputationScore) external;
    function rejectBounty(uint256 jobId, string calldata ipfsReasonHash) external;
    function withdraw() external returns (uint256);
    function setPaused(bool p) external;
    function bounties(uint256 jobId) external view returns (BountyMeta memory);
    function pendingWithdrawals(address who) external view returns (uint256);
    function arbitrator() external view returns (address);
    function owner() external view returns (address);
    function feeRecipient() external view returns (address);
    function feeBps() external view returns (uint256);
    function AC_EXPIRY_BUFFER() external view returns (uint256);
}

contract ArcBountyDisputeForkTest is Test {
    IBountyAdapterV47 constant ADAPTER = IBountyAdapterV47(0x73c617e808ED5c7Ca41413DFC6EE940dDcBb0b8D);
    IACP constant ESCROW = IACP(0x64cA39Fc57315D0D488acCaC07c37C6E841CD058);
    address constant USDC = 0x3600000000000000000000000000000000000000;
    uint256 constant ARC_MAINNET = 5042;
    uint256 constant REWARD = 10e6;
    uint256 constant RESPONSE_WINDOW = 48 hours;
    uint256 constant ARBITRATOR_TIMEOUT = 30 days;
    uint256 constant APPROVAL_TIMEOUT = 14 days;

    MockUSDC token;
    address poster = makeAddr("poster");
    address worker = makeAddr("worker");
    address stranger = makeAddr("stranger");
    address arbitrator;
    address feeRecipient;
    bool forked;

    function setUp() public {
        string memory rpc = vm.envOr("ARC_MAINNET_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        assertEq(block.chainid, ARC_MAINNET, "ARC_MAINNET_RPC must serve Arc mainnet");
        forked = true;
        vm.etch(USDC, address(new MockUSDC()).code);
        vm.store(USDC, bytes32(uint256(2)), bytes32(0)); // total supply slot, left over from the real token
        token = MockUSDC(USDC);
        arbitrator = ADAPTER.arbitrator();
        feeRecipient = ADAPTER.feeRecipient();
    }

    modifier onFork() {
        vm.skip(!forked); // reported as skipped, never as a pass, without ARC_MAINNET_RPC
        _;
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    /// A fresh 10 USDC bounty, taken and submitted by `worker`; returns the job id.
    function _submittedBounty() internal returns (uint256 jobId) {
        token.mint(poster, REWARD);
        vm.prank(poster);
        token.approve(address(ADAPTER), REWARD);
        string[] memory tags = new string[](1);
        tags[0] = "test";
        vm.prank(poster);
        jobId = ADAPTER.createBounty(IBountyAdapterV47.CreateParams({
            provider: address(0), reward: REWARD, deadline: block.timestamp + 7 days,
            ipfsDescHash: "ipfs://QmDescriptionOfTheForkTestBounty", category: "dev", tags: tags,
            agentOnly: false, humanOnly: false, requireWorkerBond: false
        }));
        vm.prank(worker);
        ADAPTER.takeBounty(jobId, 0);
        vm.prank(worker);
        ADAPTER.submitWork(jobId, "ipfs://QmTheWorkersSubmission");
    }

    function _dispute(uint256 jobId, address by) internal {
        vm.prank(by);
        ADAPTER.disputeBounty(jobId, "ipfs://QmReasonForTheDispute");
    }

    function _respond(uint256 jobId, address by) internal {
        vm.prank(by);
        ADAPTER.respondToDispute(jobId, "ipfs://QmResponseToTheDispute");
    }

    function _fee(uint256 amount) internal view returns (uint256) {
        return (amount * ADAPTER.feeBps()) / 10_000;
    }

    function _balances() internal view returns (uint256 p, uint256 w, uint256 f) {
        return (token.balanceOf(poster), token.balanceOf(worker), token.balanceOf(feeRecipient));
    }

    // ── resolveDispute ───────────────────────────────────────────────────────

    function testFork_resolveForTheWorkerPaysTheRewardLessTheFee() public onFork {
        uint256 jobId = _submittedBounty();
        _dispute(jobId, poster);
        _respond(jobId, worker);
        (, , uint256 feeBefore) = _balances();
        vm.prank(arbitrator);
        ADAPTER.resolveDispute(jobId, true, "ipfs://QmRulingForTheWorker", 0);
        (uint256 p, uint256 w, uint256 f) = _balances();
        assertEq(w, REWARD - _fee(REWARD), "worker gets the reward less the 1% fee");
        assertEq(f - feeBefore, _fee(REWARD), "fee recipient gets the fee");
        assertEq(p, 0, "poster gets nothing back");
        IBountyAdapterV47.BountyMeta memory m = ADAPTER.bounties(jobId);
        assertTrue(m.resolved && !m.inDispute);
        assertEq(m.disputeRulingHash, "ipfs://QmRulingForTheWorker");
        assertEq(uint8(ESCROW.getJob(jobId).status), uint8(IACP.JobStatus.Completed));
    }

    function testFork_resolveForThePosterRefundsInFullWithNoFee() public onFork {
        uint256 jobId = _submittedBounty();
        _dispute(jobId, poster);
        _respond(jobId, worker);
        (, , uint256 feeBefore) = _balances();
        vm.prank(arbitrator);
        ADAPTER.resolveDispute(jobId, false, "ipfs://QmRulingForThePoster", 0);
        (uint256 p, uint256 w, uint256 f) = _balances();
        assertEq(p, REWARD, "poster refunded in full");
        assertEq(w, 0);
        assertEq(f, feeBefore, "no fee on a refund");
        assertEq(uint8(ESCROW.getJob(jobId).status), uint8(IACP.JobStatus.Rejected));
    }

    function testFork_onlyTheArbitratorRulesAndOnlyOnce() public onFork {
        uint256 jobId = _submittedBounty();
        _dispute(jobId, poster);
        vm.prank(stranger);
        vm.expectRevert(bytes("only arbitrator"));
        ADAPTER.resolveDispute(jobId, true, "ipfs://QmRuling", 0);
        vm.prank(poster);
        vm.expectRevert(bytes("only arbitrator"));
        ADAPTER.resolveDispute(jobId, false, "ipfs://QmRuling", 0);
        vm.prank(arbitrator);
        vm.expectRevert(bytes("penalty>100"));
        ADAPTER.resolveDispute(jobId, false, "ipfs://QmRuling", 101);
        vm.prank(arbitrator);
        ADAPTER.resolveDispute(jobId, false, "ipfs://QmRuling", 0);
        vm.prank(arbitrator);
        vm.expectRevert(bytes("not in dispute"));
        ADAPTER.resolveDispute(jobId, true, "ipfs://QmRuling", 0);
    }

    function testFork_arbitratorCanStillRuleAfterThirtyDaysUntilSomeoneClaimsTheTimeout() public onFork {
        uint256 jobId = _submittedBounty();
        _dispute(jobId, poster);
        _respond(jobId, worker);
        vm.warp(block.timestamp + ARBITRATOR_TIMEOUT + 1 days);
        vm.prank(arbitrator);
        ADAPTER.resolveDispute(jobId, true, "ipfs://QmLateRuling", 0);
        vm.expectRevert(bytes("not in dispute"));
        ADAPTER.claimArbitratorTimeout(jobId);
        (, uint256 w, ) = _balances();
        assertEq(w, REWARD - _fee(REWARD), "the late ruling stands, not a 50/50 split");
    }

    // ── claimDefaultRuling ───────────────────────────────────────────────────

    function testFork_silentWorkerLosesTheDisputeTheyDidNotAnswer() public onFork {
        uint256 jobId = _submittedBounty();
        _dispute(jobId, poster);
        vm.warp(block.timestamp + RESPONSE_WINDOW);
        vm.expectRevert(bytes("window still open"));
        ADAPTER.claimDefaultRuling(jobId); // at exactly 48 h the respondent may still answer
        vm.warp(block.timestamp + 1);
        vm.prank(stranger); // anyone may claim it
        ADAPTER.claimDefaultRuling(jobId);
        (uint256 p, uint256 w, ) = _balances();
        assertEq(p, REWARD, "poster refunded");
        assertEq(w, 0);
        assertEq(ADAPTER.bounties(jobId).disputeRulingHash, "default:no-response");
    }

    /// A worker can open a dispute the moment it submits. The poster then has 48 hours to answer, not the 14-day
    /// review window, or anyone can settle the bounty in the worker's favour.
    function testFork_workerDisputeRightAfterSubmitGivesThePosterFortyEightHours() public onFork {
        uint256 jobId = _submittedBounty();
        _dispute(jobId, worker);
        vm.warp(block.timestamp + RESPONSE_WINDOW + 1);
        vm.prank(stranger);
        ADAPTER.claimDefaultRuling(jobId);
        (uint256 p, uint256 w, ) = _balances();
        assertEq(w, REWARD - _fee(REWARD), "worker paid by default, 12 days before the poster's review window ends");
        assertEq(p, 0);
        assertLt(block.timestamp, ADAPTER.bounties(jobId).submittedAt + APPROVAL_TIMEOUT);
    }

    function testFork_aRespondentWhoAnsweredCannotLoseByDefault() public onFork {
        uint256 jobId = _submittedBounty();
        _dispute(jobId, poster);
        vm.warp(block.timestamp + RESPONSE_WINDOW); // the last second the answer is accepted
        _respond(jobId, worker);
        vm.warp(block.timestamp + 1);
        vm.expectRevert(bytes("respondent replied"));
        ADAPTER.claimDefaultRuling(jobId);
    }

    /// While a dispute is open, nothing else can end it: not autoApprove after the review window, not the poster
    /// approving or rejecting. A poster who agrees with a worker's dispute concedes by staying silent.
    function testFork_anOpenDisputeCanOnlyEndByRulingDefaultOrTimeout() public onFork {
        uint256 jobId = _submittedBounty();
        _dispute(jobId, worker);
        vm.prank(poster);
        vm.expectRevert(bytes("in dispute"));
        ADAPTER.approveBounty(jobId, 90);
        vm.prank(poster);
        vm.expectRevert(bytes("in dispute"));
        ADAPTER.rejectBounty(jobId, "ipfs://QmRejectDuringDispute");
        vm.warp(block.timestamp + APPROVAL_TIMEOUT + 1);
        vm.expectRevert(bytes("in dispute"));
        ADAPTER.autoApprove(jobId);
    }

    // ── respondToDispute ─────────────────────────────────────────────────────

    function testFork_onlyTheOtherPartyAnswersAndOnlyInTime() public onFork {
        uint256 jobId = _submittedBounty();
        _dispute(jobId, poster);
        vm.prank(poster);
        vm.expectRevert(bytes("not the respondent"));
        ADAPTER.respondToDispute(jobId, "ipfs://QmSelfResponse");
        vm.prank(stranger);
        vm.expectRevert(bytes("not the respondent"));
        ADAPTER.respondToDispute(jobId, "ipfs://QmStrangerResponse");
        vm.warp(block.timestamp + RESPONSE_WINDOW + 1);
        vm.prank(worker);
        vm.expectRevert(bytes("response window closed"));
        ADAPTER.respondToDispute(jobId, "ipfs://QmLateResponse");
    }

    // ── claimArbitratorTimeout ───────────────────────────────────────────────

    function testFork_arbitratorSilenceForThirtyDaysSplitsTheRewardWithNoFee() public onFork {
        uint256 jobId = _submittedBounty();
        _dispute(jobId, poster);
        _respond(jobId, worker);
        vm.warp(block.timestamp + ARBITRATOR_TIMEOUT);
        vm.expectRevert(bytes("arbitrator window open"));
        ADAPTER.claimArbitratorTimeout(jobId);
        vm.warp(block.timestamp + 1);
        (, , uint256 feeBefore) = _balances();
        vm.prank(stranger);
        ADAPTER.claimArbitratorTimeout(jobId);
        (uint256 p, uint256 w, uint256 f) = _balances();
        assertEq(p + w, REWARD, "the whole reward is split");
        assertEq(p, REWARD / 2);
        assertEq(f, feeBefore, "no fee on the timeout split");
        assertEq(ADAPTER.bounties(jobId).disputeRulingHash, "timeout:50-50-split");
    }

    function testFork_timeoutNeedsAnAnswerOtherwiseTheDefaultRulingApplies() public onFork {
        uint256 jobId = _submittedBounty();
        _dispute(jobId, poster);
        vm.warp(block.timestamp + ARBITRATOR_TIMEOUT + 1);
        vm.expectRevert(bytes("use claimDefaultRuling"));
        ADAPTER.claimArbitratorTimeout(jobId);
    }

    // ── disputeBounty ────────────────────────────────────────────────────────

    function testFork_disputesAreOnlyForThePartiesOnceAfterSubmissionAndWithinTheReviewWindow() public onFork {
        uint256 jobId = _submittedBounty();
        vm.prank(stranger);
        vm.expectRevert(bytes("unauthorized"));
        ADAPTER.disputeBounty(jobId, "ipfs://QmStranger");
        vm.warp(block.timestamp + APPROVAL_TIMEOUT + 1);
        vm.prank(poster);
        vm.expectRevert(bytes("approval window elapsed, use autoApprove"));
        ADAPTER.disputeBounty(jobId, "ipfs://QmTooLate");

        uint256 second = _submittedBounty();
        _dispute(second, poster);
        vm.prank(worker);
        vm.expectRevert(bytes("already in dispute"));
        ADAPTER.disputeBounty(second, "ipfs://QmSecondDispute");
    }

    function testFork_disputeEvidenceFieldsAcceptAnyShortStringNotOnlyACid() public onFork {
        uint256 jobId = _submittedBounty();
        vm.prank(poster);
        ADAPTER.disputeBounty(jobId, "x"); // any non-empty string up to 96 bytes passes _requireCid
        _respond(jobId, worker);
        vm.prank(arbitrator);
        ADAPTER.resolveDispute(jobId, false, "not a cid", 0);
        assertEq(ADAPTER.bounties(jobId).disputeRulingHash, "not a cid");
    }

    // ── pause, escrow expiry, unpayable worker ───────────────────────────────

    function testFork_pauseLeavesDisputesAndRulingsWorking() public onFork {
        uint256 jobId = _submittedBounty();
        vm.prank(ADAPTER.owner());
        ADAPTER.setPaused(true);
        _dispute(jobId, poster);
        _respond(jobId, worker);
        vm.prank(arbitrator);
        ADAPTER.resolveDispute(jobId, true, "ipfs://QmRulingWhilePaused", 0);
        (, uint256 w, ) = _balances();
        assertEq(w, REWARD - _fee(REWARD));
    }

    /// The longest dispute (submitted at the deadline, disputed on the last review day, settled by the 30-day
    /// timeout) still finishes long before the escrow job's own expiry, so the escrow's permissionless
    /// claimRefund cannot fire under a live dispute.
    function testFork_theLongestDisputeEndsBeforeTheEscrowCanExpire() public onFork {
        token.mint(poster, REWARD);
        vm.prank(poster);
        token.approve(address(ADAPTER), REWARD);
        string[] memory tags = new string[](0);
        uint256 deadline = block.timestamp + 1 days;
        vm.prank(poster);
        uint256 jobId = ADAPTER.createBounty(IBountyAdapterV47.CreateParams({
            provider: address(0), reward: REWARD, deadline: deadline, ipfsDescHash: "ipfs://QmDeadlineBounty",
            category: "dev", tags: tags, agentOnly: false, humanOnly: false, requireWorkerBond: false
        }));
        vm.prank(worker);
        ADAPTER.takeBounty(jobId, 0);
        vm.warp(deadline);
        vm.prank(worker);
        ADAPTER.submitWork(jobId, "ipfs://QmLastMinuteWork");
        vm.warp(block.timestamp + APPROVAL_TIMEOUT);
        _dispute(jobId, poster);
        _respond(jobId, worker);
        vm.warp(block.timestamp + ARBITRATOR_TIMEOUT + 1);
        assertLt(block.timestamp, ESCROW.getJob(jobId).expiredAt, "the escrow job has not expired");
        vm.expectRevert();
        ESCROW.claimRefund(jobId);
        ADAPTER.claimArbitratorTimeout(jobId);
        (uint256 p, uint256 w, ) = _balances();
        assertEq(p + w, REWARD);
        assertEq(ESCROW.getJob(jobId).expiredAt, deadline + ADAPTER.AC_EXPIRY_BUFFER());
    }

    /// If a payout to the worker fails (for example Circle blacklists the address mid-dispute), the ruling still
    /// settles and the amount is parked for the worker to withdraw later; nothing is wedged.
    function testFork_aFailedPayoutIsParkedNotWedged() public onFork {
        uint256 jobId = _submittedBounty();
        _dispute(jobId, poster);
        _respond(jobId, worker);
        uint256 net = REWARD - _fee(REWARD);
        vm.mockCallRevert(USDC, abi.encodeWithSelector(bytes4(keccak256("transfer(address,uint256)")), worker, net), "blacklisted");
        vm.prank(arbitrator);
        ADAPTER.resolveDispute(jobId, true, "ipfs://QmRulingForTheWorker", 0);
        assertTrue(ADAPTER.bounties(jobId).resolved, "the dispute is settled");
        assertEq(ADAPTER.pendingWithdrawals(worker), net, "the payout is parked");
        vm.clearMockedCalls();
        vm.prank(worker);
        ADAPTER.withdraw();
        assertEq(token.balanceOf(worker), net, "and withdrawn once the transfer works again");
    }
}
