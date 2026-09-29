// SPDX-License-Identifier: MIT
// Vendored for tests only from github.com/Sofiia7/ARC at commit ef5d100882a4bfe475c685586902ecc72da420e8,
// file contracts/src/interfaces/IIdentityRegistry.sol (MIT, see LICENSE in this folder,
// Copyright (c) 2026 ArcBounty Contributors). The only change: the pragma is relaxed
// from 0.8.30 to ^0.8.28 so it compiles with this repo's pinned solc. Not deployed by this repo.
pragma solidity ^0.8.28;

/// @notice Minimal interface for Arc ERC-8004 IdentityRegistry contract
interface IIdentityRegistry {
    function register(string calldata metadataURI) external returns (uint256 agentId);

    function ownerOf(uint256 agentId) external view returns (address);

    function getMetadataURI(uint256 agentId) external view returns (string memory);

    function isRegistered(uint256 agentId) external view returns (bool);
}
