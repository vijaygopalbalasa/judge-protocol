// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IACP.sol";
import "../interfaces/IACPHook.sol";

/// @notice A faithful, minimal re-implementation of the ERC-8183 reference for
///         local testing. Mirrors the state machine + hook callbacks of Circle's
///         canonical Arc deployment so JudgeEvaluator/Hook are exercised
///         against realistic behavior. NOT for production.
contract MockACP is IACP {
    using SafeERC20 for IERC20;

    IERC20 public paymentToken;
    uint256 public jobCounter;
    mapping(uint256 => Job) internal _jobs;

    event JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint256 expiredAt, address hook);
    event JobFunded(uint256 indexed jobId, address indexed client, uint256 amount);
    event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable);
    event JobCompleted(uint256 indexed jobId, address indexed evaluator, bytes32 reason);
    event JobRejected(uint256 indexed jobId, address indexed rejector, bytes32 reason);
    event Refunded(uint256 indexed jobId, address indexed client, uint256 amount);

    constructor(address _paymentToken) {
        paymentToken = IERC20(_paymentToken);
    }

    function _beforeHook(address hook, uint256 jobId, bytes4 selector, bytes memory data) internal {
        if (hook != address(0)) IACPHook(hook).beforeAction(jobId, selector, data);
    }
    function _afterHook(address hook, uint256 jobId, bytes4 selector, bytes memory data) internal {
        if (hook != address(0)) IACPHook(hook).afterAction(jobId, selector, data);
    }

    function createJob(address provider, address evaluator, uint256 expiredAt, string calldata description, address hook)
        external returns (uint256)
    {
        uint256 jobId = ++jobCounter;
        _jobs[jobId] = Job(jobId, msg.sender, provider, evaluator, description, 0, expiredAt, JobStatus.Open, hook);
        emit JobCreated(jobId, msg.sender, provider, evaluator, expiredAt, hook);
        return jobId;
    }

    function setBudget(uint256 jobId, uint256 amount, bytes calldata optParams) external {
        Job storage job = _jobs[jobId];
        require(job.status == JobStatus.Open, "status");
        require(msg.sender == job.provider || msg.sender == job.client, "auth");
        _beforeHook(job.hook, jobId, msg.sig, abi.encode(msg.sender, amount, optParams));
        job.budget = amount;
        _afterHook(job.hook, jobId, msg.sig, abi.encode(msg.sender, amount, optParams));
    }

    function fund(uint256 jobId, bytes calldata optParams) external {
        Job storage job = _jobs[jobId];
        require(job.status == JobStatus.Open, "status");
        require(msg.sender == job.client, "auth");
        require(job.provider != address(0), "provider");
        _beforeHook(job.hook, jobId, msg.sig, abi.encode(msg.sender, optParams));
        job.status = JobStatus.Funded;
        if (job.budget > 0) paymentToken.safeTransferFrom(job.client, address(this), job.budget);
        emit JobFunded(jobId, job.client, job.budget);
        _afterHook(job.hook, jobId, msg.sig, abi.encode(msg.sender, optParams));
    }

    function submit(uint256 jobId, bytes32 deliverable, bytes calldata optParams) external {
        Job storage job = _jobs[jobId];
        require(job.status == JobStatus.Funded, "status");
        require(msg.sender == job.provider, "auth");
        _beforeHook(job.hook, jobId, msg.sig, abi.encode(msg.sender, deliverable, optParams));
        job.status = JobStatus.Submitted;
        emit JobSubmitted(jobId, job.provider, deliverable);
        _afterHook(job.hook, jobId, msg.sig, abi.encode(msg.sender, deliverable, optParams));
    }

    function complete(uint256 jobId, bytes32 reason, bytes calldata optParams) external {
        Job storage job = _jobs[jobId];
        require(job.status == JobStatus.Submitted, "status");
        require(msg.sender == job.evaluator, "auth");
        _beforeHook(job.hook, jobId, msg.sig, abi.encode(msg.sender, reason, optParams));
        job.status = JobStatus.Completed;
        paymentToken.safeTransfer(job.provider, job.budget);
        emit JobCompleted(jobId, job.evaluator, reason);
        _afterHook(job.hook, jobId, msg.sig, abi.encode(msg.sender, reason, optParams));
    }

    function reject(uint256 jobId, bytes32 reason, bytes calldata optParams) external {
        Job storage job = _jobs[jobId];
        require(job.status == JobStatus.Open || job.status == JobStatus.Funded || job.status == JobStatus.Submitted, "status");
        if (job.status == JobStatus.Open) require(msg.sender == job.client, "auth");
        else require(msg.sender == job.evaluator, "auth");
        _beforeHook(job.hook, jobId, msg.sig, abi.encode(msg.sender, reason, optParams));
        JobStatus prev = job.status;
        job.status = JobStatus.Rejected;
        if ((prev == JobStatus.Funded || prev == JobStatus.Submitted) && job.budget > 0) {
            paymentToken.safeTransfer(job.client, job.budget);
            emit Refunded(jobId, job.client, job.budget);
        }
        emit JobRejected(jobId, msg.sender, reason);
        _afterHook(job.hook, jobId, msg.sig, abi.encode(msg.sender, reason, optParams));
    }

    function claimRefund(uint256 jobId) external {
        Job storage job = _jobs[jobId];
        require(job.status == JobStatus.Funded || job.status == JobStatus.Submitted, "status");
        require(block.timestamp >= job.expiredAt, "not expired");
        job.status = JobStatus.Expired;
        if (job.budget > 0) paymentToken.safeTransfer(job.client, job.budget);
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        return _jobs[jobId];
    }
}
