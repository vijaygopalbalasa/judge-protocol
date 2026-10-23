// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice A minimal escrow written line by line from the ERC-8183 Specification section, with no hooks and an optional
///         platform fee. It exists to test the conformance suite itself: every test must pass against it, so a failing
///         test on a real implementation is a finding, never a quirk of the suite. Not for production use.
contract SpecEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum JobStatus { Open, Funded, Submitted, Completed, Rejected, Expired }

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
    }

    IERC20 public immutable paymentToken;
    address public immutable treasury;
    uint256 public immutable platformFeeBP;
    uint256 public jobCounter;
    mapping(uint256 => Job) internal jobs;

    event JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint256 expiredAt);
    event ProviderSet(uint256 indexed jobId, address indexed provider);
    event BudgetSet(uint256 indexed jobId, uint256 amount);
    event JobFunded(uint256 indexed jobId, address indexed client, uint256 amount);
    event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable);
    event JobCompleted(uint256 indexed jobId, address indexed evaluator, bytes32 reason);
    event JobRejected(uint256 indexed jobId, address indexed rejector, bytes32 reason);
    event JobExpired(uint256 indexed jobId);
    event PaymentReleased(uint256 indexed jobId, address indexed provider, uint256 amount);
    event Refunded(uint256 indexed jobId, address indexed client, uint256 amount);

    error WrongStatus();
    error Unauthorized();
    error ZeroAddress();
    error BadExpiry();
    error ZeroBudget();
    error ProviderNotSet();
    error BudgetMismatch();
    error HooksNotSupported();
    error NotExpired();

    constructor(IERC20 token_, address treasury_, uint256 platformFeeBP_) {
        paymentToken = token_;
        treasury = treasury_;
        platformFeeBP = platformFeeBP_;
    }

    function createJob(address provider, address evaluator, uint256 expiredAt, string calldata description, address hook)
        external returns (uint256 jobId)
    {
        if (evaluator == address(0)) revert ZeroAddress();
        if (expiredAt <= block.timestamp) revert BadExpiry();
        if (hook != address(0)) revert HooksNotSupported();
        jobId = ++jobCounter;
        jobs[jobId] = Job(jobId, msg.sender, provider, evaluator, description, 0, expiredAt, JobStatus.Open, address(0));
        emit JobCreated(jobId, msg.sender, provider, evaluator, expiredAt);
    }

    function setProvider(uint256 jobId, address provider) external {
        Job storage j = jobs[jobId];
        if (j.status != JobStatus.Open || j.client == address(0)) revert WrongStatus();
        if (msg.sender != j.client) revert Unauthorized();
        if (j.provider != address(0)) revert WrongStatus();
        if (provider == address(0)) revert ZeroAddress();
        j.provider = provider;
        emit ProviderSet(jobId, provider);
    }

    function setBudget(uint256 jobId, uint256 amount, bytes calldata) external {
        Job storage j = jobs[jobId];
        if (j.status != JobStatus.Open || j.client == address(0)) revert WrongStatus();
        if (msg.sender != j.client && msg.sender != j.provider) revert Unauthorized();
        j.budget = amount;
        emit BudgetSet(jobId, amount);
    }

    function fund(uint256 jobId, uint256 expectedBudget, bytes calldata) external nonReentrant {
        Job storage j = jobs[jobId];
        if (j.status != JobStatus.Open || j.client == address(0)) revert WrongStatus();
        if (msg.sender != j.client) revert Unauthorized();
        if (j.budget == 0) revert ZeroBudget();
        if (j.provider == address(0)) revert ProviderNotSet();
        if (j.budget != expectedBudget) revert BudgetMismatch();
        j.status = JobStatus.Funded;
        paymentToken.safeTransferFrom(msg.sender, address(this), j.budget);
        emit JobFunded(jobId, msg.sender, j.budget);
    }

    function submit(uint256 jobId, bytes32 deliverable, bytes calldata) external {
        Job storage j = jobs[jobId];
        if (j.status != JobStatus.Funded) revert WrongStatus();
        if (msg.sender != j.provider) revert Unauthorized();
        j.status = JobStatus.Submitted;
        emit JobSubmitted(jobId, msg.sender, deliverable);
    }

    function complete(uint256 jobId, bytes32 reason, bytes calldata) external nonReentrant {
        Job storage j = jobs[jobId];
        if (j.status != JobStatus.Submitted) revert WrongStatus();
        if (msg.sender != j.evaluator) revert Unauthorized();
        j.status = JobStatus.Completed;
        uint256 fee = (j.budget * platformFeeBP) / 10_000;
        if (fee > 0) paymentToken.safeTransfer(treasury, fee);
        paymentToken.safeTransfer(j.provider, j.budget - fee);
        emit JobCompleted(jobId, msg.sender, reason);
        emit PaymentReleased(jobId, j.provider, j.budget - fee);
    }

    function reject(uint256 jobId, bytes32 reason, bytes calldata) external nonReentrant {
        Job storage j = jobs[jobId];
        JobStatus s = j.status;
        if (j.client == address(0)) revert WrongStatus();
        if (s == JobStatus.Open) {
            if (msg.sender != j.client) revert Unauthorized();
        } else if (s == JobStatus.Funded || s == JobStatus.Submitted) {
            if (msg.sender != j.evaluator) revert Unauthorized();
        } else {
            revert WrongStatus();
        }
        j.status = JobStatus.Rejected;
        if (s != JobStatus.Open) {
            paymentToken.safeTransfer(j.client, j.budget);
            emit Refunded(jobId, j.client, j.budget);
        }
        emit JobRejected(jobId, msg.sender, reason);
    }

    function claimRefund(uint256 jobId) external nonReentrant {
        Job storage j = jobs[jobId];
        if (j.status != JobStatus.Funded && j.status != JobStatus.Submitted) revert WrongStatus();
        if (block.timestamp < j.expiredAt) revert NotExpired();
        j.status = JobStatus.Expired;
        paymentToken.safeTransfer(j.client, j.budget);
        emit Refunded(jobId, j.client, j.budget);
        emit JobExpired(jobId);
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        return jobs[jobId];
    }
}
