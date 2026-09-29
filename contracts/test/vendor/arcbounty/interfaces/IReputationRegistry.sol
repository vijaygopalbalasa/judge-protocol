// SPDX-License-Identifier: MIT
// Vendored for tests only from github.com/Sofiia7/ARC at commit ef5d100882a4bfe475c685586902ecc72da420e8,
// file contracts/src/interfaces/IReputationRegistry.sol (MIT, see LICENSE in this folder,
// Copyright (c) 2026 ArcBounty Contributors). The only change: the pragma is relaxed
// from 0.8.30 to ^0.8.28 so it compiles with this repo's pinned solc. Not deployed by this repo.
pragma solidity ^0.8.28;

/// @notice Interface for Arc's deployed ERC-8004 ReputationRegistry
///         (erc8004.reputation.registry.2 — verified source: ReputationRegistryUpgradeable
///         v2.0.0 at 0x16e0fa7f7c56b9a767e34b192b51f921be31da34, behind proxy
///         0x8004B663056A597Dffe9eCcC1965A193B7388713). `value`/`valueDecimals` form a
///         signed fixed-point rating (we always write whole numbers, valueDecimals=0);
///         `getSummary` averages every feedback entry matching (agentId, clientAddresses,
///         tag1, tag2) — clientAddresses must be non-empty, it reverts otherwise.
interface IReputationRegistry {
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

    function getSummary(uint256 agentId, address[] calldata clientAddresses, string calldata tag1, string calldata tag2)
        external
        view
        returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals);
}
