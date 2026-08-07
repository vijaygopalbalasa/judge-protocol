// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/JudgeReputationHook.sol";
import "../src/mocks/MockACP.sol";
import "../src/mocks/MockUSDC.sol";
import "../src/interfaces/IReputationRegistry.sol";

/// @notice Records giveFeedback calls so tests can assert the hook posts correct
///         feedback — and, critically, that the afterAction data decode matches
///         what the ACP actually encodes: (address, bytes32, bytes).
contract MockReputationRegistry is IReputationRegistry {
    struct Call { uint256 agentId; uint8 score; bytes32 tag1; bytes32 tag2; bytes32 filehash; }
    Call[] public calls;
    bool public revertOnCall;

    function setRevert(bool r) external { revertOnCall = r; }
    function count() external view returns (uint256) { return calls.length; }

    function giveFeedback(
        uint256 agentId, uint8 score, bytes32 tag1, bytes32 tag2,
        string calldata, bytes32 filehash, bytes memory
    ) external {
        require(!revertOnCall, "registry down");
        calls.push(Call(agentId, score, tag1, tag2, filehash));
    }
}

contract JudgeReputationHookTest is Test {
    MockUSDC usdc;
    MockACP acp;
    MockReputationRegistry registry;
    JudgeReputationHook hook;

    address client = makeAddr("client");
    address provider = makeAddr("provider");
    address evaluator = makeAddr("evaluator");
    uint256 constant AGENT_ID = 4242;
    uint256 constant BUDGET = 5_000_000;
    bytes32 constant EVIDENCE = keccak256("evidence-core");

    function setUp() public {
        usdc = new MockUSDC();
        acp = new MockACP(address(usdc));
        registry = new MockReputationRegistry();
        hook = new JudgeReputationHook(address(acp), address(registry));

        hook.setProviderAgent(provider, AGENT_ID);
        hook.setFeedbackAuth(AGENT_ID, hex"01"); // non-empty → feedback enabled

        usdc.mint(client, 100e6);
        vm.prank(client);
        usdc.approve(address(acp), type(uint256).max);
    }

    function _jobToSubmitted() internal returns (uint256 jobId) {
        vm.prank(client);
        jobId = acp.createJob(provider, evaluator, block.timestamp + 1 days, "job", address(hook));
        vm.prank(provider);
        acp.setBudget(jobId, BUDGET, "");
        vm.prank(client);
        acp.fund(jobId, "");
        vm.prank(provider);
        acp.submit(jobId, keccak256("deliverable"), "");
    }

    /// The regression test for the decode bug: BEFORE the fix, afterAction
    /// decoded (bytes32,bytes) against ACP's (address,bytes32,bytes) encoding,
    /// which reverts — and because complete() calls the hook, it would brick the
    /// settlement. This asserts a real complete() flows through the hook and
    /// posts feedback with the correct evidence hash.
    function test_afterComplete_postsFeedback_withCorrectDecode() public {
        uint256 jobId = _jobToSubmitted();
        vm.prank(evaluator);
        acp.complete(jobId, EVIDENCE, "");

        assertEq(uint256(acp.getJob(jobId).status), uint256(IACP.JobStatus.Completed));
        assertEq(registry.count(), 1);
        (uint256 agentId, uint8 score, bytes32 tag1, bytes32 tag2, bytes32 filehash) = registry.calls(0);
        assertEq(agentId, AGENT_ID);
        assertEq(score, 100);
        assertEq(tag1, bytes32("judge-verdict"));
        assertEq(tag2, bytes32("completed"));
        assertEq(filehash, EVIDENCE); // proves the bytes32 reason decoded correctly
    }

    function test_afterReject_postsZeroScoreFeedback() public {
        uint256 jobId = _jobToSubmitted();
        vm.prank(evaluator);
        acp.reject(jobId, EVIDENCE, "");

        assertEq(uint256(acp.getJob(jobId).status), uint256(IACP.JobStatus.Rejected));
        assertEq(registry.count(), 1);
        (, uint8 score,, bytes32 tag2,) = registry.calls(0);
        assertEq(score, 0);
        assertEq(tag2, bytes32("rejected"));
    }

    /// A failing registry must never roll back a settlement that already moved
    /// funds — the try/catch swallows it.
    function test_registryRevert_doesNotBrickSettlement() public {
        registry.setRevert(true);
        uint256 jobId = _jobToSubmitted();
        vm.prank(evaluator);
        acp.complete(jobId, EVIDENCE, ""); // must not revert
        assertEq(uint256(acp.getJob(jobId).status), uint256(IACP.JobStatus.Completed));
        assertEq(usdc.balanceOf(provider), BUDGET);
        assertEq(registry.count(), 0); // feedback failed, settlement succeeded
    }

    /// Unregistered provider → no feedback, settlement still succeeds.
    function test_unregisteredProvider_skipsFeedback() public {
        hook.setProviderAgent(provider, 0);
        uint256 jobId = _jobToSubmitted();
        vm.prank(evaluator);
        acp.complete(jobId, EVIDENCE, "");
        assertEq(registry.count(), 0);
        assertEq(uint256(acp.getJob(jobId).status), uint256(IACP.JobStatus.Completed));
    }

    /// Reputation gate: minProviderScore>0 blocks funding for unregistered providers.
    function test_beforeFund_reputationGate_blocksUnregistered() public {
        JudgeReputationHook gated = new JudgeReputationHook(address(acp), address(registry));
        gated.setMinProviderScore(1);
        vm.prank(client);
        uint256 jobId = acp.createJob(provider, evaluator, block.timestamp + 1 days, "job", address(gated));
        vm.prank(provider);
        acp.setBudget(jobId, BUDGET, "");
        vm.prank(client);
        vm.expectRevert(JudgeReputationHook.ProviderBelowReputation.selector);
        acp.fund(jobId, "");
    }

    function test_onlyACP_canCallHook() public {
        vm.expectRevert(JudgeReputationHook.OnlyACP.selector);
        hook.afterAction(1, IACP.complete.selector, abi.encode(address(this), EVIDENCE, ""));
    }

    function test_supportsIACPHookInterface() public view {
        assertTrue(hook.supportsInterface(type(IACPHook).interfaceId));
    }
}
