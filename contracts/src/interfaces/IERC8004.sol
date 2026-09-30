// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice The part of the ERC-8004 IdentityRegistry (v2.0.0, as deployed) that JudgeReputationHookV2 reads.
interface IERC8004Identity {
    /// @dev Reverts (ERC721NonexistentToken) for an agent that does not exist.
    function isAuthorizedOrOwner(address spender, uint256 agentId) external view returns (bool);

    /// @dev The agent's verified wallet; address(0) when unset. Cleared when the agent is transferred.
    function getAgentWallet(uint256 agentId) external view returns (address);
}

/// @notice The part of the ERC-8004 ReputationRegistry (v2.0.0, as deployed) that JudgeReputationHookV2 uses.
interface IERC8004Reputation {
    /// @dev Reverts when the caller owns or operates `agentId` ("Self-feedback not allowed").
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external;

    /// @dev `clientAddresses` must be non-empty; an empty tag matches every tag.
    function getSummary(uint256 agentId, address[] calldata clientAddresses, string calldata tag1, string calldata tag2)
        external
        view
        returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals);
}
