// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../src/JudgeArbitrator.sol";
import "../src/interfaces/IBountyAdapter.sol";

interface IBountyAdapterViews {
    function totalBounties() external view returns (uint256);
    function allJobIds(uint256 index) external view returns (uint256);
    function MAX_CID_LEN() external view returns (uint256);
}

/// @notice Reads ArcBounty's BountyAdapter on Arc testnet through IBountyAdapter, so the copied BountyMeta layout is
///         checked against live code, and runs the arbitrator handover to a fresh JudgeArbitrator and back on a
///         fork (nothing is sent to the chain). Runs only when ARC_TESTNET_RPC is set, and skips otherwise:
///           ARC_TESTNET_RPC=https://rpc.testnet.arc.network forge test --match-contract ArcBountyTestnetFork -vv
contract ArcBountyTestnetForkTest is Test {
    uint256 constant ARC_TESTNET = 5042002;
    /// @dev An ArcBounty V4.7 testnet adapter with live bounties to decode (arbitrator and owner: their testnet
    ///      deployer). ARCBOUNTY_ADAPTER overrides it: the dedicated run adapter 0xF6b89bD7FCd9a277f08c2b5Cbe388a721A16fe14
    ///      (no bounties before the run, so only the handover test applies) or their earlier rehearsal adapter
    ///      0xD74984D965F2aBf532605Fe57F735C82a7A5c13E.
    address ADAPTER = 0xeDf2c738915b042da97788b2b5499D4655FB1f20;

    bool forked;

    function setUp() public {
        string memory rpc = vm.envOr("ARC_TESTNET_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        ADAPTER = vm.envOr("ARCBOUNTY_ADAPTER", ADAPTER);
        vm.createSelectFork(rpc);
        assertEq(block.chainid, ARC_TESTNET, "ARC_TESTNET_RPC must serve Arc testnet");
        forked = true;
    }

    function test_fork_liveBountyDecodesThroughTheInterface() public {
        vm.skip(!forked); // reported as skipped, never as a pass, without ARC_TESTNET_RPC
        IBountyAdapter a = IBountyAdapter(ADAPTER);
        assertTrue(a.arbitrator() != address(0));
        assertGt(IBountyAdapterViews(ADAPTER).totalBounties(), 0, "the rehearsal settled bounties");
        uint256 jobId = IBountyAdapterViews(ADAPTER).allJobIds(0);
        IBountyAdapter.BountyMeta memory b = a.bounties(jobId);
        assertEq(b.jobId, jobId);
        assertTrue(b.poster != address(0));
        assertGt(bytes(b.ipfsDescHash).length, 0);
        assertEq(IBountyAdapterViews(ADAPTER).MAX_CID_LEN(), 96, "the bound JudgeArbitrator mirrors");
    }

    function test_fork_roleHandsOverAndBack() public {
        vm.skip(!forked);
        IBountyAdapter a = IBountyAdapter(ADAPTER);
        address current = a.arbitrator();
        address[] memory signers = new address[](1);
        signers[0] = makeAddr("judgeSigner");
        JudgeArbitrator arb = new JudgeArbitrator(ADAPTER, current, signers);

        vm.prank(current);
        a.transferArbitrator(address(arb));
        vm.prank(current);
        arb.acceptRole();
        assertEq(a.arbitrator(), address(arb));

        vm.prank(current);
        arb.handBack(current);
        vm.prank(current);
        a.acceptArbitrator();
        assertEq(a.arbitrator(), current);
    }
}
