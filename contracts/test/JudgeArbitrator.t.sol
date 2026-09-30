// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../src/JudgeArbitrator.sol";
import "../src/interfaces/IBountyAdapter.sol";
import "../src/mocks/MockACP.sol";
import "../src/mocks/MockUSDC.sol";
import {BountyAdapter} from "./vendor/arcbounty/BountyAdapter.sol";

/// @dev Stand-ins for the two ERC-8004 registries the adapter's constructor requires. The adapter only calls
///      ownerOf for agent bounties and wraps every giveFeedback in try/catch.
contract StubIdentity {
    mapping(uint256 => address) public owners;

    function setOwner(uint256 agentId, address who) external {
        owners[agentId] = who;
    }

    function ownerOf(uint256 agentId) external view returns (address) {
        return owners[agentId];
    }
}

contract StubReputation {
    uint256 public calls;
    uint256 public lastAgent;
    int128 public lastValue;

    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8,
        string calldata,
        string calldata,
        string calldata,
        string calldata,
        bytes32
    ) external {
        calls++;
        lastAgent = agentId;
        lastValue = value;
    }

    function getSummary(uint256, address[] calldata, string calldata, string calldata)
        external
        pure
        returns (uint64, int128, uint8)
    {
        return (0, 0, 0);
    }
}

/// @notice JudgeArbitrator against ArcBounty's real BountyAdapter (vendored at a pinned commit, see
///         test/vendor/arcbounty) on the ERC-8183 mock escrow, so every dispute settles through their code.
contract JudgeArbitratorTest is Test {
    MockUSDC usdc;
    MockACP acp;
    StubIdentity identity;
    StubReputation reputation;
    BountyAdapter adapter;
    JudgeArbitrator arb;

    address safe = makeAddr("arcbountySafe"); // ArcBounty's arbitrator Safe: the principal
    address judgeOwner = makeAddr("judgeOwner");
    address feeRecipient = makeAddr("feeRecipient");
    address poster = makeAddr("poster");
    address worker = makeAddr("worker");
    address relayer = makeAddr("relayer");

    uint256 constant SIGNER_PK = 0xA11CE;
    uint256 constant OTHER_PK = 0xB0B;
    address signer;
    uint256 constant REWARD = 2e6;

    string constant DESC = "ipfs://QmZydksZeiGMVzSFtifF7riVeChSyz6zT1JWwMTqTHCFAs";
    string constant RESULT = "ipfs://QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o";
    string constant REASON = "ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
    string constant RULING = "ipfs://QmRuLiNgQmRuLiNgQmRuLiNgQmRuLiNgQmRuLiNgQmRuLi";

    bytes32 constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 constant RULING_TYPEHASH = keccak256(
        "Ruling(address adapter,uint256 jobId,bytes32 submissionHash,bytes32 descriptionHash,bool payProvider,string rulingCid,uint8 reputationPenalty,uint64 issuedAt)"
    );

    function setUp() public {
        vm.warp(1_780_000_000);
        signer = vm.addr(SIGNER_PK);
        (adapter, arb) = _deployPair();
    }

    /// @dev A fresh escrow, adapter and arbitrator, with the role handed over the way ArcBounty would do it:
    ///      the deployer passes the arbitrator role to the Safe, the Safe nominates JudgeArbitrator, and the
    ///      Safe completes the two-step handover through acceptRole().
    function _deployPair() internal returns (BountyAdapter a, JudgeArbitrator j) {
        if (address(usdc) == address(0)) {
            usdc = new MockUSDC();
            identity = new StubIdentity();
            reputation = new StubReputation();
        }
        acp = new MockACP(address(usdc));
        a = new BountyAdapter(address(acp), address(identity), address(reputation), address(usdc), feeRecipient, 100, 0);
        a.transferArbitrator(safe);
        vm.prank(safe);
        a.acceptArbitrator();

        address[] memory signers = new address[](1);
        signers[0] = signer;
        vm.prank(judgeOwner);
        j = new JudgeArbitrator(address(a), safe, signers);

        vm.prank(safe);
        a.transferArbitrator(address(j));
        vm.prank(safe);
        j.acceptRole();
        assertEq(a.arbitrator(), address(j), "handover");
    }

    function _submittedBounty(BountyAdapter a, string memory desc, string memory result, uint256 agentId)
        internal
        returns (uint256 jobId)
    {
        usdc.mint(poster, REWARD);
        vm.prank(poster);
        usdc.approve(address(a), REWARD);
        BountyAdapter.CreateParams memory p = BountyAdapter.CreateParams({
            provider: address(0),
            reward: REWARD,
            deadline: block.timestamp + 7 days,
            ipfsDescHash: desc,
            category: "data",
            tags: new string[](0),
            agentOnly: false,
            humanOnly: false,
            requireWorkerBond: false
        });
        vm.prank(poster);
        jobId = a.createBounty(p);
        if (agentId != 0) identity.setOwner(agentId, worker);
        vm.prank(worker);
        a.takeBounty(jobId, agentId);
        vm.prank(worker);
        a.submitWork(jobId, result);
    }

    function _disputedBounty(BountyAdapter a) internal returns (uint256 jobId) {
        jobId = _submittedBounty(a, DESC, RESULT, 0);
        vm.prank(poster);
        a.disputeBounty(jobId, REASON);
    }

    function _ruling(uint256 jobId, bool payProvider) internal view returns (JudgeArbitrator.Ruling memory) {
        return JudgeArbitrator.Ruling({
            jobId: jobId,
            submissionHash: keccak256(bytes(RESULT)),
            descriptionHash: keccak256(bytes(DESC)),
            payProvider: payProvider,
            rulingCid: RULING,
            reputationPenalty: 0,
            issuedAt: uint64(block.timestamp)
        });
    }

    /// @dev The digest built here from the EIP-712 rules, not taken from the contract, so a wrong encoding in the
    ///      contract fails these tests instead of agreeing with itself.
    function _digest(address arbitrator, address adapterAddr, JudgeArbitrator.Ruling memory r)
        internal
        view
        returns (bytes32)
    {
        bytes32 domain = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("JudgeArbitrator"), keccak256("1"), block.chainid, arbitrator)
        );
        bytes32 structHash = keccak256(
            abi.encode(
                RULING_TYPEHASH,
                adapterAddr,
                r.jobId,
                r.submissionHash,
                r.descriptionHash,
                r.payProvider,
                keccak256(bytes(r.rulingCid)),
                r.reputationPenalty,
                r.issuedAt
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function _signFor(uint256 pk, address arbitrator, address adapterAddr, JudgeArbitrator.Ruling memory r)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 rs, bytes32 s) = vm.sign(pk, _digest(arbitrator, adapterAddr, r));
        return abi.encodePacked(rs, s, v);
    }

    function _sign(uint256 pk, JudgeArbitrator.Ruling memory r) internal view returns (bytes memory) {
        return _signFor(pk, address(arb), address(adapter), r);
    }

    function _meta(uint256 jobId) internal view returns (IBountyAdapter.BountyMeta memory) {
        return IBountyAdapter(address(adapter)).bounties(jobId);
    }

    /*//////////////////////////////////////////////////////////////
                              HAPPY PATHS
    //////////////////////////////////////////////////////////////*/

    function test_payProvider_paysTheWorkerThroughTheRealAdapter() public {
        uint256 jobId = _disputedBounty(adapter);
        JudgeArbitrator.Ruling memory r = _ruling(jobId, true);
        vm.expectEmit(true, true, false, true, address(arb));
        emit JudgeArbitrator.RulingApplied(jobId, true, RULING, 0, signer);
        vm.prank(relayer); // anyone may relay a signed ruling
        arb.resolve(r, _sign(SIGNER_PK, r));

        IBountyAdapter.BountyMeta memory b = _meta(jobId);
        assertTrue(b.resolved);
        assertFalse(b.inDispute);
        assertEq(b.disputeRulingHash, RULING);
        assertEq(usdc.balanceOf(worker), REWARD - REWARD / 100, "worker net of ArcBounty's 1% fee");
        assertEq(usdc.balanceOf(feeRecipient), REWARD / 100);
        assertEq(usdc.balanceOf(poster), 0);
    }

    function test_refundRuling_returnsTheFullRewardToThePoster() public {
        uint256 jobId = _disputedBounty(adapter);
        JudgeArbitrator.Ruling memory r = _ruling(jobId, false);
        arb.resolve(r, _sign(SIGNER_PK, r));

        IBountyAdapter.BountyMeta memory b = _meta(jobId);
        assertTrue(b.resolved);
        assertEq(usdc.balanceOf(poster), REWARD, "no fee on a refund");
        assertEq(usdc.balanceOf(worker), 0);
        assertEq(usdc.balanceOf(feeRecipient), 0);
    }

    function test_interfaceDecodesTheRealAdaptersBounty() public {
        uint256 jobId = _disputedBounty(adapter);
        IBountyAdapter.BountyMeta memory b = _meta(jobId);
        assertEq(b.jobId, jobId);
        assertEq(b.poster, poster);
        assertEq(b.reward, REWARD);
        assertEq(b.ipfsDescHash, DESC);
        assertEq(b.category, "data");
        assertEq(b.assignedProvider, worker);
        assertEq(b.submittedResultHash, RESULT);
        assertTrue(b.isTaken);
        assertTrue(b.inDispute);
        assertEq(b.disputeInitiator, poster);
        assertEq(b.disputeReasonHash, REASON);
        assertEq(IBountyAdapter(address(adapter)).arbitrator(), address(arb));
    }

    function test_penaltyIsForwardedOnAnAgentBountyRefund() public {
        uint256 jobId = _submittedBounty(adapter, DESC, RESULT, 7);
        vm.prank(poster);
        adapter.disputeBounty(jobId, REASON);
        JudgeArbitrator.Ruling memory r = _ruling(jobId, false);
        r.reputationPenalty = 40;
        arb.resolve(r, _sign(SIGNER_PK, r));
        assertEq(reputation.calls(), 1);
        assertEq(reputation.lastAgent(), 7);
        assertEq(reputation.lastValue(), -40);
    }

    /// @dev The adapter's second way into a dispute: the poster rejects and the worker challenges the rejection.
    function test_challengedRejection_isResolvedTheSameWay() public {
        uint256 jobId = _submittedBounty(adapter, DESC, RESULT, 0);
        vm.prank(poster);
        adapter.rejectBounty(jobId, REASON);
        vm.prank(worker);
        adapter.challengeRejection(jobId, REASON);
        assertTrue(_meta(jobId).inDispute);
        assertEq(_meta(jobId).disputeInitiator, worker);

        JudgeArbitrator.Ruling memory r = _ruling(jobId, true);
        arb.resolve(r, _sign(SIGNER_PK, r));
        assertTrue(_meta(jobId).resolved);
        assertEq(usdc.balanceOf(worker), REWARD - REWARD / 100);
    }

    function test_rulingDigestMatchesEip712() public view {
        JudgeArbitrator.Ruling memory r = _ruling(1, true);
        assertEq(arb.rulingDigest(r), _digest(address(arb), address(adapter), r));
    }

    /*//////////////////////////////////////////////////////////////
                    A RULING ONLY WORKS WHERE IT WAS BOUND
    //////////////////////////////////////////////////////////////*/

    function test_revert_wrongSigner() public {
        uint256 jobId = _disputedBounty(adapter);
        JudgeArbitrator.Ruling memory r = _ruling(jobId, true);
        vm.expectRevert(JudgeArbitrator.BadSignature.selector);
        arb.resolve(r, _sign(OTHER_PK, r));
    }

    /// @dev Malformed and malleable signatures are refused as BadSignature, not with a library error.
    function test_revert_malformedOrMalleableSignature() public {
        uint256 jobId = _disputedBounty(adapter);
        JudgeArbitrator.Ruling memory r = _ruling(jobId, true);
        (uint8 v, bytes32 rs, bytes32 s) = vm.sign(SIGNER_PK, _digest(address(arb), address(adapter), r));

        vm.expectRevert(JudgeArbitrator.BadSignature.selector);
        arb.resolve(r, hex"deadbeef");

        vm.expectRevert(JudgeArbitrator.BadSignature.selector);
        arb.resolve(r, new bytes(65));

        // The same signature in its high-s form recovers the same key on bare ecrecover; EIP-2 style rules refuse it.
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes memory malleable = abi.encodePacked(rs, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.expectRevert(JudgeArbitrator.BadSignature.selector);
        arb.resolve(r, malleable);

        arb.resolve(r, abi.encodePacked(rs, s, v)); // control
        assertTrue(_meta(jobId).resolved);
    }

    function test_revert_signatureForAnotherJob() public {
        uint256 jobA = _disputedBounty(adapter);
        uint256 jobB = _disputedBounty(adapter);
        JudgeArbitrator.Ruling memory r = _ruling(jobA, true);
        bytes memory sig = _sign(SIGNER_PK, r);
        r.jobId = jobB; // same submission and description, different bounty
        vm.expectRevert(JudgeArbitrator.BadSignature.selector);
        arb.resolve(r, sig);
    }

    function test_revert_signatureForAnotherArbitratorOrAdapter() public {
        (BountyAdapter adapter2, JudgeArbitrator arb2) = _deployPair();
        uint256 jobId = _disputedBounty(adapter2);
        JudgeArbitrator.Ruling memory r = _ruling(jobId, true);

        // Signed for the first arbitrator's domain.
        bytes memory forArb1 = _signFor(SIGNER_PK, address(arb), address(adapter), r);
        vm.expectRevert(JudgeArbitrator.BadSignature.selector);
        arb2.resolve(r, forArb1);

        // Signed for the second arbitrator's domain but naming the first adapter.
        bytes memory wrongAdapter = _signFor(SIGNER_PK, address(arb2), address(adapter), r);
        vm.expectRevert(JudgeArbitrator.BadSignature.selector);
        arb2.resolve(r, wrongAdapter);

        // Control: bound to the second pair, it settles.
        arb2.resolve(r, _signFor(SIGNER_PK, address(arb2), address(adapter2), r));
        assertTrue(IBountyAdapter(address(adapter2)).bounties(jobId).resolved);
    }

    function test_revert_signatureFromAnotherChain() public {
        uint256 jobId = _disputedBounty(adapter);
        JudgeArbitrator.Ruling memory r = _ruling(jobId, true);
        bytes memory sig = _sign(SIGNER_PK, r);
        vm.chainId(block.chainid + 1);
        vm.expectRevert(JudgeArbitrator.BadSignature.selector);
        arb.resolve(r, sig);
    }

    function test_revert_rulingForAnotherSubmission() public {
        uint256 jobId = _disputedBounty(adapter);
        JudgeArbitrator.Ruling memory r = _ruling(jobId, true);
        r.submissionHash = keccak256(bytes("ipfs://QmSomeOtherSubmissionQmSomeOtherSubmission1"));
        vm.expectRevert(JudgeArbitrator.SubmissionMismatch.selector);
        arb.resolve(r, _sign(SIGNER_PK, r));
    }

    function test_revert_rulingForAnotherDescription() public {
        uint256 jobId = _disputedBounty(adapter);
        JudgeArbitrator.Ruling memory r = _ruling(jobId, true);
        r.descriptionHash = keccak256(bytes("ipfs://QmSomeOtherDescriptionQmSomeOtherDescription"));
        vm.expectRevert(JudgeArbitrator.DescriptionMismatch.selector);
        arb.resolve(r, _sign(SIGNER_PK, r));
    }

    function test_revert_tamperedFieldsBreakTheSignature() public {
        uint256 jobId = _disputedBounty(adapter);
        JudgeArbitrator.Ruling memory r = _ruling(jobId, false);
        bytes memory sig = _sign(SIGNER_PK, r);

        JudgeArbitrator.Ruling memory flipped = _ruling(jobId, true); // the payout direction
        vm.expectRevert(JudgeArbitrator.BadSignature.selector);
        arb.resolve(flipped, sig);

        JudgeArbitrator.Ruling memory otherCid = _ruling(jobId, false);
        otherCid.rulingCid = "ipfs://QmAnotherRulingQmAnotherRulingQmAnotherRuling";
        vm.expectRevert(JudgeArbitrator.BadSignature.selector);
        arb.resolve(otherCid, sig);

        JudgeArbitrator.Ruling memory otherPenalty = _ruling(jobId, false);
        otherPenalty.reputationPenalty = 1;
        vm.expectRevert(JudgeArbitrator.BadSignature.selector);
        arb.resolve(otherPenalty, sig);

        JudgeArbitrator.Ruling memory otherTime = _ruling(jobId, false);
        otherTime.issuedAt = r.issuedAt - 1;
        vm.expectRevert(JudgeArbitrator.BadSignature.selector);
        arb.resolve(otherTime, sig);

        arb.resolve(r, sig); // control: the untouched ruling settles
        assertTrue(_meta(jobId).resolved);
    }

    /*//////////////////////////////////////////////////////////////
                          BOUNTY STATE GUARDS
    //////////////////////////////////////////////////////////////*/

    function test_revert_notInDispute() public {
        uint256 jobId = _submittedBounty(adapter, DESC, RESULT, 0);
        JudgeArbitrator.Ruling memory r = _ruling(jobId, true);
        vm.expectRevert(JudgeArbitrator.NotInDispute.selector);
        arb.resolve(r, _sign(SIGNER_PK, r));
    }

    function test_revert_replayAfterResolution() public {
        uint256 jobId = _disputedBounty(adapter);
        JudgeArbitrator.Ruling memory r = _ruling(jobId, true);
        bytes memory sig = _sign(SIGNER_PK, r);
        arb.resolve(r, sig);
        vm.expectRevert(JudgeArbitrator.NotInDispute.selector);
        arb.resolve(r, sig);
        assertEq(usdc.balanceOf(worker), REWARD - REWARD / 100, "paid once");
    }

    function test_revert_unknownBounty() public {
        JudgeArbitrator.Ruling memory r = _ruling(999, true);
        vm.expectRevert(JudgeArbitrator.UnknownBounty.selector);
        arb.resolve(r, _sign(SIGNER_PK, r));
    }

    /*//////////////////////////////////////////////////////////////
                           RULING FIELD GUARDS
    //////////////////////////////////////////////////////////////*/

    function test_revert_staleRuling_andBoundary() public {
        uint256 jobId = _disputedBounty(adapter);
        JudgeArbitrator.Ruling memory r = _ruling(jobId, true);
        r.issuedAt = uint64(block.timestamp - arb.MAX_RULING_AGE() - 1);
        vm.expectRevert(JudgeArbitrator.StaleRuling.selector);
        arb.resolve(r, _sign(SIGNER_PK, r));

        r.issuedAt = uint64(block.timestamp - arb.MAX_RULING_AGE()); // exactly at the bound: accepted
        arb.resolve(r, _sign(SIGNER_PK, r));
        assertTrue(_meta(jobId).resolved);
    }

    function test_revert_futureRuling() public {
        uint256 jobId = _disputedBounty(adapter);
        JudgeArbitrator.Ruling memory r = _ruling(jobId, true);
        r.issuedAt = uint64(block.timestamp + 1);
        vm.expectRevert(JudgeArbitrator.FutureRuling.selector);
        arb.resolve(r, _sign(SIGNER_PK, r));
    }

    function test_revert_penaltyAbove100_and100Accepted() public {
        uint256 jobId = _disputedBounty(adapter);
        JudgeArbitrator.Ruling memory r = _ruling(jobId, false);
        r.reputationPenalty = 101;
        vm.expectRevert(JudgeArbitrator.PenaltyTooHigh.selector);
        arb.resolve(r, _sign(SIGNER_PK, r));

        r.reputationPenalty = 100;
        arb.resolve(r, _sign(SIGNER_PK, r));
        assertTrue(_meta(jobId).resolved);
    }

    function test_revert_rulingCidBounds_matchTheAdapter() public {
        uint256 jobId = _disputedBounty(adapter);
        JudgeArbitrator.Ruling memory r = _ruling(jobId, true);

        r.rulingCid = "";
        vm.expectRevert(JudgeArbitrator.BadRulingCid.selector);
        arb.resolve(r, _sign(SIGNER_PK, r));

        r.rulingCid = string(_repeat("a", 97));
        vm.expectRevert(JudgeArbitrator.BadRulingCid.selector);
        arb.resolve(r, _sign(SIGNER_PK, r));

        r.rulingCid = string(_repeat("a", 96)); // the adapter's MAX_CID_LEN: accepted by both
        arb.resolve(r, _sign(SIGNER_PK, r));
        assertEq(_meta(jobId).disputeRulingHash, r.rulingCid);
        assertEq(adapter.MAX_CID_LEN(), arb.MAX_CID_LEN(), "same bound as the adapter");
    }

    function _repeat(bytes1 c, uint256 n) internal pure returns (bytes memory out) {
        out = new bytes(n);
        for (uint256 i = 0; i < n; i++) {
            out[i] = c;
        }
    }

    /*//////////////////////////////////////////////////////////////
                    PAUSE, SIGNERS AND WHO HOLDS THE ROLE
    //////////////////////////////////////////////////////////////*/

    function test_revert_whenPaused_thenResumes() public {
        uint256 jobId = _disputedBounty(adapter);
        JudgeArbitrator.Ruling memory r = _ruling(jobId, true);
        bytes memory sig = _sign(SIGNER_PK, r);
        vm.prank(judgeOwner);
        arb.setPaused(true);
        vm.expectRevert(JudgeArbitrator.Paused_.selector);
        arb.resolve(r, sig);
        vm.prank(judgeOwner);
        arb.setPaused(false);
        arb.resolve(r, sig);
        assertTrue(_meta(jobId).resolved);
    }

    function test_revert_pauseIsOwnerOnly() public {
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, safe));
        arb.setPaused(true);
    }

    function test_handBack_principalTakesTheRoleBack() public {
        vm.expectEmit(true, false, false, false, address(arb));
        emit JudgeArbitrator.RoleHandedBack(safe);
        vm.prank(safe);
        arb.handBack(safe);
        assertEq(adapter.pendingArbitrator(), safe);
        vm.prank(safe);
        adapter.acceptArbitrator();
        assertEq(adapter.arbitrator(), safe);
    }

    function test_handBack_stopsRulingsBeforeTheSafeAccepts() public {
        uint256 jobId = _disputedBounty(adapter);
        JudgeArbitrator.Ruling memory r = _ruling(jobId, true);
        bytes memory sig = _sign(SIGNER_PK, r);
        vm.prank(safe);
        arb.handBack(safe);
        assertEq(adapter.arbitrator(), address(arb), "still the arbitrator until the Safe accepts");
        vm.expectRevert(JudgeArbitrator.HandingBack.selector);
        arb.resolve(r, sig);
    }

    function test_handBack_worksWhilePaused() public {
        vm.prank(judgeOwner);
        arb.setPaused(true);
        vm.prank(safe);
        arb.handBack(safe);
        assertEq(adapter.pendingArbitrator(), safe);
    }

    function test_revert_handBackByAnyoneElse() public {
        address[4] memory others = [judgeOwner, signer, relayer, worker];
        for (uint256 i = 0; i < others.length; i++) {
            vm.prank(others[i]);
            vm.expectRevert(JudgeArbitrator.NotPrincipal.selector);
            arb.handBack(others[i]);
        }
        assertEq(adapter.pendingArbitrator(), address(0));
    }

    /*//////////////////////////////////////////////////////////////
          DISPUTES JUDGE DOES NOT RULE: ARCBOUNTY SETTLES THEM DIRECTLY
    //////////////////////////////////////////////////////////////*/

    function test_principalRulesDirectly_payProvider() public {
        uint256 jobId = _disputedBounty(adapter);
        vm.expectEmit(true, false, false, true, address(arb));
        emit JudgeArbitrator.PrincipalRulingApplied(jobId, true, RULING, 0);
        vm.prank(safe);
        arb.resolveAsPrincipal(jobId, true, RULING, 0);
        IBountyAdapter.BountyMeta memory m = _meta(jobId);
        assertTrue(m.resolved);
        assertFalse(m.inDispute);
        assertEq(m.disputeRulingHash, RULING);
        assertEq(usdc.balanceOf(worker), REWARD - REWARD / 100, "worker net of ArcBounty's 1% fee");
        assertEq(usdc.balanceOf(poster), 0);
    }

    function test_principalRulesDirectly_refund() public {
        uint256 jobId = _disputedBounty(adapter);
        vm.prank(safe);
        arb.resolveAsPrincipal(jobId, false, RULING, 0);
        assertTrue(_meta(jobId).resolved);
        assertEq(usdc.balanceOf(poster), REWARD, "no fee on a refund");
        assertEq(usdc.balanceOf(worker), 0);
    }

    function test_principalRule_worksWhilePaused() public {
        uint256 jobId = _disputedBounty(adapter);
        vm.prank(judgeOwner);
        arb.setPaused(true);
        vm.prank(safe);
        arb.resolveAsPrincipal(jobId, true, RULING, 0);
        assertTrue(_meta(jobId).resolved);
    }

    function test_principalRule_worksWhileTheRoleIsOnItsWayBack() public {
        uint256 jobId = _disputedBounty(adapter);
        vm.prank(safe);
        arb.handBack(safe);
        vm.prank(safe);
        arb.resolveAsPrincipal(jobId, false, RULING, 0);
        assertTrue(_meta(jobId).resolved);
    }

    function test_revert_principalRuleByAnyoneElse() public {
        uint256 jobId = _disputedBounty(adapter);
        address[4] memory others = [judgeOwner, signer, relayer, worker];
        for (uint256 i = 0; i < others.length; i++) {
            vm.prank(others[i]);
            vm.expectRevert(JudgeArbitrator.NotPrincipal.selector);
            arb.resolveAsPrincipal(jobId, true, RULING, 0);
        }
        assertFalse(_meta(jobId).resolved);
    }

    function test_revert_principalRule_sameBoundsAsASignedRuling() public {
        uint256 jobId = _disputedBounty(adapter);
        uint256 open_ = _submittedBounty(adapter, DESC, RESULT, 0); // submitted, not disputed
        vm.startPrank(safe);
        vm.expectRevert(JudgeArbitrator.PenaltyTooHigh.selector);
        arb.resolveAsPrincipal(jobId, true, RULING, 101);
        vm.expectRevert(JudgeArbitrator.BadRulingCid.selector);
        arb.resolveAsPrincipal(jobId, true, "", 0);
        vm.expectRevert(JudgeArbitrator.NotInDispute.selector);
        arb.resolveAsPrincipal(open_, true, RULING, 0);
        vm.expectRevert(JudgeArbitrator.UnknownBounty.selector);
        arb.resolveAsPrincipal(987654, true, RULING, 0);
        arb.resolveAsPrincipal(jobId, true, RULING, 0);
        vm.expectRevert(JudgeArbitrator.NotInDispute.selector);
        arb.resolveAsPrincipal(jobId, false, RULING, 0); // no second ruling
        vm.stopPrank();
    }

    function test_ownerCannotMoveTheRoleOrRuleWithoutASignerKey() public {
        uint256 jobId = _disputedBounty(adapter);
        JudgeArbitrator.Ruling memory r = _ruling(jobId, true);
        uint256 ownerPk = 0x0DD;
        vm.prank(judgeOwner);
        vm.expectRevert(JudgeArbitrator.NotPrincipal.selector);
        arb.handBack(judgeOwner);
        vm.prank(judgeOwner);
        vm.expectRevert(JudgeArbitrator.BadSignature.selector);
        arb.resolve(r, _sign(ownerPk, r));
        assertFalse(_meta(jobId).resolved);
    }

    function test_newSigner_waitsForTheDelay() public {
        uint256 jobId = _disputedBounty(adapter);
        address newSigner = vm.addr(OTHER_PK);
        vm.prank(judgeOwner);
        arb.addSigner(newSigner);
        assertFalse(arb.isActiveSigner(newSigner));

        JudgeArbitrator.Ruling memory r = _ruling(jobId, true);
        vm.expectRevert(JudgeArbitrator.BadSignature.selector);
        arb.resolve(r, _sign(OTHER_PK, r));

        vm.warp(block.timestamp + arb.SIGNER_DELAY() - 1);
        r.issuedAt = uint64(block.timestamp);
        vm.expectRevert(JudgeArbitrator.BadSignature.selector);
        arb.resolve(r, _sign(OTHER_PK, r));

        vm.warp(block.timestamp + 1);
        r.issuedAt = uint64(block.timestamp);
        arb.resolve(r, _sign(OTHER_PK, r));
        assertTrue(_meta(jobId).resolved);
    }

    function test_removeSigner_isImmediate() public {
        uint256 jobId = _disputedBounty(adapter);
        vm.prank(judgeOwner);
        arb.removeSigner(signer);
        assertFalse(arb.isActiveSigner(signer));
        JudgeArbitrator.Ruling memory r = _ruling(jobId, true);
        vm.expectRevert(JudgeArbitrator.BadSignature.selector);
        arb.resolve(r, _sign(SIGNER_PK, r));
    }

    function test_revert_signerAdminIsOwnerOnly_andChecked() public {
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, safe));
        arb.addSigner(safe);
        vm.startPrank(judgeOwner);
        vm.expectRevert(JudgeArbitrator.ZeroAddress.selector);
        arb.addSigner(address(0));
        vm.expectRevert(JudgeArbitrator.AlreadySigner.selector);
        arb.addSigner(signer);
        vm.expectRevert(JudgeArbitrator.NotSigner.selector);
        arb.removeSigner(relayer);
        vm.stopPrank();
    }

    function test_acceptRole_onlyOwnerOrPrincipal() public {
        vm.prank(relayer);
        vm.expectRevert(JudgeArbitrator.NotOwnerOrPrincipal.selector);
        arb.acceptRole();
    }

    function test_acceptRole_afterHandBackCycle_resumesRulings() public {
        uint256 jobId = _disputedBounty(adapter);
        vm.startPrank(safe);
        arb.handBack(safe);
        adapter.acceptArbitrator(); // the Safe holds the role again
        adapter.transferArbitrator(address(arb)); // and later delegates it once more
        vm.stopPrank();
        vm.prank(judgeOwner);
        arb.acceptRole();
        assertEq(adapter.arbitrator(), address(arb));
        assertFalse(arb.handingBack());

        JudgeArbitrator.Ruling memory r = _ruling(jobId, true);
        arb.resolve(r, _sign(SIGNER_PK, r));
        assertTrue(_meta(jobId).resolved);
    }

    function test_revert_renounceDisabled() public {
        vm.prank(judgeOwner);
        vm.expectRevert(JudgeArbitrator.RenounceDisabled.selector);
        arb.renounceOwnership();
    }

    function test_revert_constructorRejectsZeroAddresses() public {
        address[] memory signers = new address[](1);
        signers[0] = signer;
        vm.expectRevert(JudgeArbitrator.ZeroAddress.selector);
        new JudgeArbitrator(address(0), safe, signers);
        vm.expectRevert(JudgeArbitrator.ZeroAddress.selector);
        new JudgeArbitrator(address(adapter), address(0), signers);
        signers[0] = address(0);
        vm.expectRevert(JudgeArbitrator.ZeroAddress.selector);
        new JudgeArbitrator(address(adapter), safe, signers);
    }
}
