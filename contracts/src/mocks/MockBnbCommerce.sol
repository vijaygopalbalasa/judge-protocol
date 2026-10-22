// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IBnbCommerce.sol";
import "../interfaces/IACPHook.sol";

/// @notice A faithful, minimal re-implementation of BNB Chain's ERC-8183 kernel (bnbagent-sdk's
///         AgenticCommerceUpgradeable, Sourcify exact match 0xe8d47866... on BSC) for local tests of the
///         Judge router and policy: the same Job layout (11 fields, submittedAt and deliverable at the end), the
///         same status gates, evaluator-only complete/reject on a Submitted job, fund(jobId, expectedBudget),
///         the hook called before and after each action with the kernel's encodings, and the hook's revert
///         bubbled. No fees, one token. NOT for production.
contract MockBnbCommerce is IBnbCommerce {
    using SafeERC20 for IERC20;

    IERC20 public paymentToken;
    uint256 public jobCounter;
    mapping(uint256 => Job) internal _jobs;
    mapping(uint256 => bool) public jobHasBudget;

    event JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint256 expiredAt, address hook);
    event JobFunded(uint256 indexed jobId, address indexed client, uint256 amount);
    event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable);
    event JobCompleted(uint256 indexed jobId, address indexed evaluator, bytes32 reason);
    event JobRejected(uint256 indexed jobId, address indexed rejector, bytes32 reason);
    event PaymentReleased(uint256 indexed jobId, address indexed provider, uint256 amount);
    event Refunded(uint256 indexed jobId, address indexed client, uint256 amount);

    error InvalidJob();
    error WrongStatus();
    error Unauthorized();
    error ProviderNotSet();
    error ZeroBudget();
    error BudgetMismatch();
    error HookCallFailed();

    constructor(address _paymentToken) {
        paymentToken = IERC20(_paymentToken);
    }

    /// The kernel calls hooks with a gas limit and re-raises their revert data verbatim.
    function _hook(bytes4 which, address hook, uint256 jobId, bytes4 selector, bytes memory data) internal {
        if (hook == address(0)) return;
        (bool ok, bytes memory ret) = hook.call{gas: 1_000_000}(abi.encodeWithSelector(which, jobId, selector, data));
        if (!ok) {
            if (ret.length > 0) {
                assembly { revert(add(ret, 32), mload(ret)) }
            }
            revert HookCallFailed();
        }
    }
    function _before(address hook, uint256 jobId, bytes4 selector, bytes memory data) internal {
        _hook(IACPHook.beforeAction.selector, hook, jobId, selector, data);
    }
    function _after(address hook, uint256 jobId, bytes4 selector, bytes memory data) internal {
        _hook(IACPHook.afterAction.selector, hook, jobId, selector, data);
    }

    function createJob(address provider, address evaluator, uint256 expiredAt, string calldata description, address hook)
        external returns (uint256 jobId)
    {
        jobId = ++jobCounter;
        Job storage job = _jobs[jobId];
        job.id = jobId; job.client = msg.sender; job.provider = provider; job.evaluator = evaluator;
        job.description = description; job.expiredAt = expiredAt; job.status = JobStatus.Open; job.hook = hook;
        emit JobCreated(jobId, msg.sender, provider, evaluator, expiredAt, hook);
    }

    function setBudget(uint256 jobId, uint256 amount, bytes calldata optParams) external {
        Job storage job = _jobs[jobId];
        if (job.id == 0) revert InvalidJob();
        if (job.status != JobStatus.Open) revert WrongStatus();
        if (msg.sender != job.provider) revert Unauthorized();
        _before(job.hook, jobId, this.setBudget.selector, abi.encode(amount, optParams));
        job.budget = amount;
        jobHasBudget[jobId] = true;
        _after(job.hook, jobId, this.setBudget.selector, abi.encode(amount, optParams));
    }

    function fund(uint256 jobId, uint256 expectedBudget, bytes calldata optParams) external {
        Job storage job = _jobs[jobId];
        if (job.id == 0) revert InvalidJob();
        if (job.status != JobStatus.Open) revert WrongStatus();
        if (msg.sender != job.client) revert Unauthorized();
        if (job.provider == address(0)) revert ProviderNotSet();
        if (!jobHasBudget[jobId]) revert ZeroBudget();
        if (job.budget != expectedBudget) revert BudgetMismatch();
        if (block.timestamp >= job.expiredAt) revert WrongStatus();
        _before(job.hook, jobId, this.fund.selector, optParams);
        job.status = JobStatus.Funded;
        if (job.budget > 0) paymentToken.safeTransferFrom(msg.sender, address(this), job.budget);
        emit JobFunded(jobId, msg.sender, job.budget);
        _after(job.hook, jobId, this.fund.selector, optParams);
    }

    function submit(uint256 jobId, bytes32 deliverable, bytes calldata optParams) external {
        Job storage job = _jobs[jobId];
        if (job.id == 0) revert InvalidJob();
        if (job.status != JobStatus.Funded) revert WrongStatus();
        if (msg.sender != job.provider) revert Unauthorized();
        if (block.timestamp >= job.expiredAt) revert WrongStatus();
        bytes memory hookData = abi.encode(deliverable, optParams);
        _before(job.hook, jobId, this.submit.selector, hookData);
        job.status = JobStatus.Submitted;
        job.submittedAt = block.timestamp;
        job.deliverable = deliverable;
        emit JobSubmitted(jobId, msg.sender, deliverable);
        _after(job.hook, jobId, this.submit.selector, hookData);
    }

    function complete(uint256 jobId, bytes32 reason, bytes calldata optParams) external {
        Job storage job = _jobs[jobId];
        if (job.id == 0) revert InvalidJob();
        if (job.status != JobStatus.Submitted) revert WrongStatus();
        if (msg.sender != job.evaluator) revert Unauthorized();
        bytes memory hookData = abi.encode(reason, optParams);
        _before(job.hook, jobId, this.complete.selector, hookData);
        job.status = JobStatus.Completed;
        if (job.budget > 0) paymentToken.safeTransfer(job.provider, job.budget);
        _after(job.hook, jobId, this.complete.selector, hookData);
        emit JobCompleted(jobId, job.evaluator, reason);
        emit PaymentReleased(jobId, job.provider, job.budget);
    }

    function reject(uint256 jobId, bytes32 reason, bytes calldata optParams) external {
        Job storage job = _jobs[jobId];
        if (job.id == 0) revert InvalidJob();
        JobStatus prev = job.status;
        if (prev == JobStatus.Open) {
            if (msg.sender != job.client) revert Unauthorized();
        } else if (prev == JobStatus.Funded || prev == JobStatus.Submitted) {
            if (msg.sender != job.evaluator) revert Unauthorized();
        } else {
            revert WrongStatus();
        }
        bytes memory hookData = abi.encode(reason, optParams);
        _before(job.hook, jobId, this.reject.selector, hookData);
        job.status = JobStatus.Rejected;
        if ((prev == JobStatus.Funded || prev == JobStatus.Submitted) && job.budget > 0) {
            paymentToken.safeTransfer(job.client, job.budget);
            emit Refunded(jobId, job.client, job.budget);
        }
        _after(job.hook, jobId, this.reject.selector, hookData);
        emit JobRejected(jobId, msg.sender, reason);
    }

    function claimRefund(uint256 jobId) external {
        Job storage job = _jobs[jobId];
        if (job.id == 0) revert InvalidJob();
        if (job.status != JobStatus.Funded && job.status != JobStatus.Submitted) revert WrongStatus();
        if (block.timestamp < job.expiredAt) revert WrongStatus();
        job.status = JobStatus.Expired;
        if (job.budget > 0) {
            paymentToken.safeTransfer(job.client, job.budget);
            emit Refunded(jobId, job.client, job.budget);
        }
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        return _jobs[jobId];
    }
}
