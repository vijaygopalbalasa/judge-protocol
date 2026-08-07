// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal ERC-8004 ReputationRegistry write surface used by the Judge.
///         The full registry supports feedbackAuth (agent-signed pre-authorization);
///         for v1 we post feedback only for agents that have authorized this hook.
interface IReputationRegistry {
    /// @notice Submit structured feedback for an agent.
    /// @param agentId      ERC-721 tokenId of the agent in the Identity Registry
    /// @param score        0-100 rating
    /// @param tag1         primary category tag (e.g. "judge-verdict")
    /// @param tag2         sub-category tag (e.g. "completed" / "rejected")
    /// @param fileuri      off-chain evidence location (e.g. IPFS / HTTPS)
    /// @param filehash     keccak256 of the off-chain file contents
    /// @param feedbackAuth agent-signed authorization for this client to post
    function giveFeedback(
        uint256 agentId,
        uint8 score,
        bytes32 tag1,
        bytes32 tag2,
        string calldata fileuri,
        bytes32 filehash,
        bytes memory feedbackAuth
    ) external;
}
