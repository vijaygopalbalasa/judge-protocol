// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import "../interfaces/IBnbCommerce.sol";
import "../interfaces/IACPHook.sol";

interface IJudgePolicy {
    function onSubmitted(uint256 jobId, bytes32 deliverable, bytes calldata optParams) external;
    function check(uint256 jobId, bytes calldata evidence) external view returns (uint8 verdict, bytes32 reason);
}

/// @title JudgeRouter: a minimal EvaluatorRouter for BNB Chain's ERC-8183 kernel, owned by whoever deploys it
/// @notice bnbagent-sdk providers accept a job only when its evaluator and hook are their configured router and
///         the job's policy is whitelisted on that router (jobOps.ts). BNB's own router whitelists policies by its
///         owner only, so a deterministic policy needs a router of its own; the SDK points at one with the
///         ERC8183_ROUTER_ADDRESS and ERC8183_POLICY_ADDRESS environment variables. This router keeps the official
///         router's public surface that the SDK uses (registerJob, settle, jobPolicy, policyWhitelist, markExpired)
///         and the same error names, and does nothing else.
/// @dev Hooks never revert on this router's own logic: the kernel bubbles a hook's revert, so a reverting hook
///      would block the kernel's state change. A submit by a job this router does not know is simply ignored.
contract JudgeRouter is IACPHook, ERC165, Ownable2Step, ReentrancyGuard {
    uint8 public constant PENDING = 0;
    uint8 public constant APPROVE = 1;
    uint8 public constant REJECT = 2;

    IBnbCommerce public immutable commerce;
    mapping(address => bool) public policyWhitelist;
    mapping(uint256 => address) public jobPolicy;

    event PolicyWhitelisted(address indexed policy, bool indexed status);
    event JobRegistered(uint256 indexed jobId, address indexed policy, address indexed client);
    event JobSettled(uint256 indexed jobId, address indexed policy, uint8 indexed verdict, bytes32 reason);
    event JobFinalised(uint256 indexed jobId, uint8 indexed status);

    error ZeroAddress();
    error NotCommerce();
    error NotJobClient();
    error JobNotOpen();
    error PolicyNotWhitelisted();
    error PolicyAlreadySet();
    error PolicyNotSet();
    error RouterNotEvaluator();
    error RouterNotHook();
    error NotDecided();
    error UnknownVerdict(uint8 verdict);
    error NotExpired();

    constructor(address _commerce) Ownable(msg.sender) {
        if (_commerce == address(0)) revert ZeroAddress();
        commerce = IBnbCommerce(_commerce);
    }

    function setPolicyWhitelist(address policy, bool status) external onlyOwner {
        if (policy == address(0)) revert ZeroAddress();
        policyWhitelist[policy] = status;
        emit PolicyWhitelisted(policy, status);
    }

    /// @notice The client binds a whitelisted policy to its job after createJob and before fund. The job must
    ///         name this router as both evaluator and hook, or settle could never act on it.
    function registerJob(uint256 jobId, address policy) external {
        if (!policyWhitelist[policy]) revert PolicyNotWhitelisted();
        if (jobPolicy[jobId] != address(0)) revert PolicyAlreadySet();
        IBnbCommerce.Job memory job = commerce.getJob(jobId);
        if (msg.sender != job.client) revert NotJobClient();
        if (job.status != IBnbCommerce.JobStatus.Open) revert JobNotOpen();
        if (job.evaluator != address(this)) revert RouterNotEvaluator();
        if (job.hook != address(this)) revert RouterNotHook();
        jobPolicy[jobId] = policy;
        emit JobRegistered(jobId, policy, msg.sender);
    }

    /// @notice Permissionless: asks the job's policy for a verdict on `evidence` and applies it to the kernel.
    function settle(uint256 jobId, bytes calldata evidence) external nonReentrant {
        address policy = jobPolicy[jobId];
        if (policy == address(0)) revert PolicyNotSet();
        (uint8 verdict, bytes32 reason) = IJudgePolicy(policy).check(jobId, evidence);
        if (verdict == PENDING) revert NotDecided();
        if (verdict == APPROVE) commerce.complete(jobId, reason, "");
        else if (verdict == REJECT) commerce.reject(jobId, reason, "");
        else revert UnknownVerdict(verdict);
        emit JobSettled(jobId, policy, verdict, reason);
        emit JobFinalised(jobId, uint8(commerce.getJob(jobId).status));
    }

    /// @notice Permissionless bookkeeping once the kernel has expired a job (claimRefund is the kernel's own).
    function markExpired(uint256 jobId) external {
        IBnbCommerce.Job memory job = commerce.getJob(jobId);
        if (job.status != IBnbCommerce.JobStatus.Expired) revert NotExpired();
        emit JobFinalised(jobId, uint8(job.status));
    }

    /*//////////////////////////////////////////////////////////////
                           THE KERNEL'S HOOK
    //////////////////////////////////////////////////////////////*/

    function beforeAction(uint256, bytes4, bytes calldata) external view override {
        if (msg.sender != address(commerce)) revert NotCommerce();
    }

    /// @dev On submit, tell the job's policy what the provider committed to. The kernel encodes submit's hook
    ///      data as abi.encode(bytes32 deliverable, bytes optParams).
    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external override {
        if (msg.sender != address(commerce)) revert NotCommerce();
        if (selector != IBnbCommerce.submit.selector) return;
        address policy = jobPolicy[jobId];
        if (policy == address(0)) return;
        (bytes32 deliverable, bytes memory optParams) = abi.decode(data, (bytes32, bytes));
        IJudgePolicy(policy).onSubmitted(jobId, deliverable, optParams);
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC165, IERC165) returns (bool) {
        return interfaceId == type(IACPHook).interfaceId || super.supportsInterface(interfaceId);
    }
}
