// SPDX-License-Identifier: CC0-1.0
// Copied verbatim from ERC-8183 (ethereum/ERCs, ERCS/erc-8183.md at commit a078cab), section "Reference
// Implementation", IACPHook.sol. The ERC is released under CC0. Used only by the conformance tests.
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/introspection/IERC165.sol";

interface IACPHook is IERC165 {
    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
}
