// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice The part of ArcBounty's BountyAdapter (V4.7, github.com/Sofiia7/ARC, contracts/src/BountyAdapter.sol)
///         that JudgeArbitrator uses. BountyMeta and every function signature are copied field for field from
///         that source; the tests decode a vendored copy of the real adapter through this interface.
interface IBountyAdapter {
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

    function bounties(uint256 jobId) external view returns (BountyMeta memory);

    function resolveDispute(uint256 jobId, bool payProvider, string calldata ipfsRulingHash, uint8 reputationPenalty)
        external;

    function transferArbitrator(address next) external;

    function acceptArbitrator() external;

    function arbitrator() external view returns (address);

    function pendingArbitrator() external view returns (address);
}
