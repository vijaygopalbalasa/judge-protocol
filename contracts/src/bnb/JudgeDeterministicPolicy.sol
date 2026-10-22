// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "../interfaces/IBnbCommerce.sol";

interface IJobPolicySource {
    function jobPolicy(uint256 jobId) external view returns (address);
}

/// @title JudgeDeterministicPolicy: Judge Protocol as an evaluator policy for BNB Chain's ERC-8183 router
/// @notice bnbagent-sdk settles jobs through an EvaluatorRouter that is the job's evaluator and hook; the router
///         forwards each action to the job's policy and, on `settle(jobId, evidence)`, asks the policy
///         `check(jobId, evidence)` for a verdict and applies it to the kernel. The reference OptimisticPolicy
///         ignores evidence and decides on time and votes alone (silence approves). This policy decides on a
///         Judge Protocol verdict instead: the bytes passed as evidence are `abi.encode(Verdict, signature)`,
///         the same Verdict struct JudgeEvaluator accepts on Arc, signed under this policy's own EIP-712 domain
///         (so a signature is never portable between contracts or chains) by an allowlisted judge key, bound to
///         this job and to the deliverable hash the kernel recorded at submission. Anyone may relay it: the
///         signature, not the caller, is what the policy trusts. The judging itself stays off chain and
///         recomputable (the verdict's evidenceHash commits to the criteria, the delivered bytes and every check).
/// @dev `check` is a view, as the router requires, so nothing is stored at settlement; the router records the
///      verdict and reason (the evidenceHash) in its JobSettled event. onSubmitted records the deliverable so a
///      verdict can be bound to it even if the kernel's job record is not readable from the policy.
contract JudgeDeterministicPolicy is Ownable2Step, EIP712 {
    using ECDSA for bytes32;

    /// Mirrors JudgeEvaluator.Verdict field for field, so the judge service signs one shape for both chains.
    struct Verdict {
        uint256 jobId;
        bytes32 criteriaHash;
        bytes32 deliverable;
        uint8 score;
        uint8 threshold;
        bool pass;
        bytes32 evidenceHash;
        uint64 timestamp;
    }

    /// The router's verdict enum: PENDING=0, APPROVE=1, REJECT=2.
    uint8 public constant PENDING = 0;
    uint8 public constant APPROVE = 1;
    uint8 public constant REJECT = 2;

    /// A verdict older than this is refused: the deliverable could have been re-judged since.
    uint64 public constant MAX_VERDICT_AGE = 1 days;

    bytes32 public constant VERDICT_TYPEHASH = keccak256(
        "Verdict(uint256 jobId,bytes32 criteriaHash,bytes32 deliverable,uint8 score,uint8 threshold,bool pass,bytes32 evidenceHash,uint64 timestamp)"
    );

    /// @notice The router allowed to call onSubmitted (and the only one whose settle this policy answers).
    address public immutable router;
    /// @notice The kernel the router drives; recorded for verifiers, not read here.
    address public immutable commerce;

    mapping(address => bool) public isSigner;
    address public guardian;
    bool public paused;

    /// @notice The deliverable hash the kernel recorded at submission, per job (zero before submission).
    mapping(uint256 => bytes32) public submitted;
    /// @notice When the policy saw the submission, per job.
    mapping(uint256 => uint64) public submittedAt;
    /// @notice Optional per-job commitment to the acceptance criteria, written by a judge signer before submission.
    ///         When set, only a verdict that carries this criteriaHash can settle the job.
    mapping(uint256 => bytes32) public jobCriteria;

    event SignerUpdated(address indexed signer, bool allowed);
    event GuardianUpdated(address indexed guardian);
    event Paused(bool paused);
    event SubmissionRecorded(uint256 indexed jobId, bytes32 deliverable);
    event CriteriaRegistered(uint256 indexed jobId, bytes32 criteriaHash);

    error NotRouter();
    error NotGuardian();
    error Paused_();
    error ZeroAddress();
    error RenounceDisabled();
    error NotSigner();
    error ZeroCriteria();
    error AlreadyRegistered();
    error NotThisPolicy();
    error NotOpen();

    modifier onlyRouter() {
        if (msg.sender != router) revert NotRouter();
        _;
    }

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian();
        _;
    }

    constructor(address _router, address _commerce, address _guardian, address[] memory initialSigners)
        Ownable(msg.sender)
        EIP712("JudgeDeterministicPolicy", "1")
    {
        if (_router == address(0) || _commerce == address(0) || _guardian == address(0)) revert ZeroAddress();
        router = _router;
        commerce = _commerce;
        guardian = _guardian;
        for (uint256 i = 0; i < initialSigners.length; i++) {
            if (initialSigners[i] == address(0)) revert ZeroAddress();
            isSigner[initialSigners[i]] = true;
            emit SignerUpdated(initialSigners[i], true);
        }
    }

    /*//////////////////////////////////////////////////////////////
                         THE POLICY INTERFACE
    //////////////////////////////////////////////////////////////*/

    /// @notice Called by the router from the kernel's submit hook. Records what the provider committed to.
    function onSubmitted(uint256 jobId, bytes32 deliverable, bytes calldata) external onlyRouter {
        submitted[jobId] = deliverable;
        submittedAt[jobId] = uint64(block.timestamp);
        emit SubmissionRecorded(jobId, deliverable);
    }

    /// @notice Bind acceptance criteria to a job before the provider submits, as JudgeEvaluator.registerCriteria does
    ///         on Arc. Restricted to a judge signer or the owner, write-once, only while the job is Open or Funded,
    ///         only for a job the router has bound to this policy, and refused while paused. Optional: the criteria
    ///         are also committed in the immutable job description; this makes the commitment explicit, so a provider
    ///         can read it on chain before accepting the work.
    function registerCriteria(uint256 jobId, bytes32 criteriaHash) external {
        if (paused) revert Paused_();
        if (!isSigner[msg.sender] && msg.sender != owner()) revert NotSigner();
        if (criteriaHash == bytes32(0)) revert ZeroCriteria();
        if (jobCriteria[jobId] != bytes32(0)) revert AlreadyRegistered();
        if (IJobPolicySource(router).jobPolicy(jobId) != address(this)) revert NotThisPolicy();
        if (uint8(IBnbCommerce(commerce).getJob(jobId).status) >= uint8(IBnbCommerce.JobStatus.Submitted)) revert NotOpen();
        jobCriteria[jobId] = criteriaHash;
        emit CriteriaRegistered(jobId, criteriaHash);
    }

    /// @notice No time-based approval: a job settles only on a Judge verdict (or expires on the kernel).
    function disputeWindow() external pure returns (uint64) {
        return 0;
    }

    /// @notice The verdict for `jobId`, decided from `evidence = abi.encode(Verdict, bytes signature)`.
    ///         PENDING (0) means "no valid verdict in this evidence": the router then reverts NotDecided and
    ///         nothing changes, so a bad relay can never settle a job either way. Evidence that is not even
    ///         decodable as (Verdict, bytes) reverts inside this view instead; settle reverts with it, and the
    ///         job is untouched (the fuzz test holds that for arbitrary bytes).
    /// @return verdict APPROVE or REJECT when the evidence carries a valid verdict for this job, else PENDING.
    /// @return reason  The verdict's evidenceHash (the recomputable commitment), or zero when PENDING.
    function check(uint256 jobId, bytes calldata evidence) external view returns (uint8 verdict, bytes32 reason) {
        if (paused) return (PENDING, bytes32(0));
        if (evidence.length < 32 * 10) return (PENDING, bytes32(0)); // 8 verdict words, the signature's offset and its length
        (Verdict memory v, bytes memory sig) = abi.decode(evidence, (Verdict, bytes));
        if (v.jobId != jobId) return (PENDING, bytes32(0));
        bytes32 recorded = submitted[jobId];
        if (recorded == bytes32(0) || v.deliverable != recorded) return (PENDING, bytes32(0));
        bytes32 registered = jobCriteria[jobId];
        if (registered != bytes32(0) && v.criteriaHash != registered) return (PENDING, bytes32(0));
        if (v.pass && v.score < v.threshold) return (PENDING, bytes32(0));
        if (v.timestamp > block.timestamp) return (PENDING, bytes32(0)); // a verdict cannot be from the future
        if (v.timestamp + MAX_VERDICT_AGE < block.timestamp) return (PENDING, bytes32(0));
        if (v.timestamp < submittedAt[jobId]) return (PENDING, bytes32(0)); // judged before this submission existed
        (address recovered, ECDSA.RecoverError err,) = _hashTypedDataV4(_hashVerdict(v)).tryRecover(sig);
        if (err != ECDSA.RecoverError.NoError || !isSigner[recovered]) return (PENDING, bytes32(0));
        return (v.pass ? APPROVE : REJECT, v.evidenceHash);
    }

    /*//////////////////////////////////////////////////////////////
                              ADMIN
    //////////////////////////////////////////////////////////////*/

    function setSigner(address signer, bool allowed) external onlyOwner {
        if (signer == address(0)) revert ZeroAddress();
        isSigner[signer] = allowed;
        emit SignerUpdated(signer, allowed);
    }

    function setGuardian(address g) external onlyOwner {
        if (g == address(0)) revert ZeroAddress();
        guardian = g;
        emit GuardianUpdated(g);
    }

    /// @notice While paused every check answers PENDING: no job can settle through this policy, and the
    ///         kernel's claimRefund after expiry is unaffected.
    function setPaused(bool p) external onlyGuardian {
        paused = p;
        emit Paused(p);
    }

    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    /*//////////////////////////////////////////////////////////////
                              INTERNAL
    //////////////////////////////////////////////////////////////*/

    function _hashVerdict(Verdict memory v) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                VERDICT_TYPEHASH, v.jobId, v.criteriaHash, v.deliverable, v.score, v.threshold, v.pass, v.evidenceHash, v.timestamp
            )
        );
    }

    /// @notice The EIP-712 digest a judge key signs for `v` (for the service and for verifiers).
    function verdictDigest(Verdict calldata v) external view returns (bytes32) {
        return _hashTypedDataV4(_hashVerdict(v));
    }
}
