// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice The ERC-8183 kernel as BNB Chain's bnbagent-sdk deploys it (AgenticCommerceUpgradeable, BSC mainnet
///         proxy 0xea4daa3100a767e86fded867729ae7446476eba6, implementation 0xe8d47866e2cc3dcaa50f0ad980355695b2f1d533,
///         Sourcify exact match; testnet proxy 0xa206c0517b6371c6638cd9e4a42cc9f02a33b0de). It differs from Circle's
///         Arc layout (interfaces/IACP.sol) in two ways the judge must respect: the Job struct carries two more
///         fields, submittedAt and deliverable, and fund() takes the budget it expects.
interface IBnbCommerce {
    enum JobStatus {
        Open,
        Funded,
        Submitted,
        Completed,
        Rejected,
        Expired
    }

    struct Job {
        uint256 id;
        address client;
        address provider;
        address evaluator;
        string description;
        uint256 budget;
        uint256 expiredAt;
        JobStatus status;
        address hook;
        uint256 submittedAt; // when the provider submitted; 0 before
        bytes32 deliverable; // the provider's deliverable hash; zero before submission
    }

    function createJob(address provider, address evaluator, uint256 expiredAt, string calldata description, address hook)
        external returns (uint256 jobId);
    function setBudget(uint256 jobId, uint256 amount, bytes calldata optParams) external;
    function fund(uint256 jobId, uint256 expectedBudget, bytes calldata optParams) external;
    function submit(uint256 jobId, bytes32 deliverable, bytes calldata optParams) external;
    function complete(uint256 jobId, bytes32 reason, bytes calldata optParams) external;
    function reject(uint256 jobId, bytes32 reason, bytes calldata optParams) external;
    function claimRefund(uint256 jobId) external;
    function getJob(uint256 jobId) external view returns (Job memory);
}
