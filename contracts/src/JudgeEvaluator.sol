// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IACP.sol";

/// @title JudgeEvaluator
/// @notice The on-chain evaluator for ERC-8183 agent escrow. Clients set this
///         contract as their job's `evaluator`. An off-chain judge service runs
///         deterministic checkers against the submitted deliverable, signs a
///         structured verdict (EIP-712), and submits it here. This contract
///         verifies the signature against an allowlist of attestation signers,
///         then calls `complete`/`reject` on the ACP escrow contract.
///
///         Design goals:
///           - neutral, standalone infrastructure (not tied to any marketplace)
///           - evidence-first: every verdict carries a recomput·able reason hash
///           - no custody: this contract never holds job funds; the ACP contract
///             escrows and disburses. Judge only attests.
///           - accountable: an immutable on-chain evidence log + a guardian that
///             can pause and a backup evaluator path.
///
///         Non-upgradeable by design (the spec warns hooks/evaluators should not
///         change behavior mid-job). A v2 deploys a new address; clients opt in.
contract JudgeEvaluator is ReentrancyGuard, Ownable2Step, EIP712 {
    using ECDSA for bytes32;
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                                TYPES
    //////////////////////////////////////////////////////////////*/

    struct Verdict {
        uint256 jobId; // ACP job id
        bytes32 criteriaHash; // keccak256 of the acceptance-criteria JSON
        bytes32 deliverable; // deliverable hash the provider submitted
        uint8 score; // 0-100 weighted score from the checkers
        uint8 threshold; // pass bar; the contract enforces pass ⇒ score ≥ threshold
        bool pass; // true → complete, false → reject
        bytes32 evidenceHash; // keccak256 of the recomputable verdict core
        uint64 timestamp; // when the verdict was produced
    }

    /*//////////////////////////////////////////////////////////////
                                STATE
    //////////////////////////////////////////////////////////////*/

    /// @notice The ACP escrow contract this evaluator attests for.
    IACP public immutable acp;

    /// @notice Attestation signers authorized to submit verdicts.
    mapping(address => bool) public isSigner;

    /// @notice Guardian can pause verdict submission (e.g. on signer compromise).
    address public guardian;

    /// @notice When true, verdict submission is halted. claimRefund on the ACP
    ///         contract is unaffected (funds are never locked by the judge).
    bool public paused;

    /// @notice Per-job acceptance criteria commitment, registered by the client
    ///         or read from the job description. criteriaHash binds the verdict.
    mapping(uint256 => bytes32) public jobCriteria;

    /// @notice The latest verdict recorded per job (for audit / recomputation).
    mapping(uint256 => Verdict) public verdicts;

    /// @notice Count of verdicts issued, for cheap analytics.
    uint256 public verdictCount;
    uint256 public completedCount;
    uint256 public rejectedCount;

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event CriteriaRegistered(uint256 indexed jobId, bytes32 criteriaHash);
    event CriteriaCleared(uint256 indexed jobId, bytes32 criteriaHash);
    event VerdictSubmitted(
        uint256 indexed jobId,
        bool indexed pass,
        uint8 score,
        bytes32 criteriaHash,
        bytes32 deliverable,
        bytes32 evidenceHash,
        address signer
    );
    event SignerUpdated(address indexed signer, bool allowed);
    event GuardianUpdated(address indexed guardian);
    event Paused(bool paused);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error Paused_();
    error NotSigner();
    error NotGuardian();
    error BadSignature();
    error CriteriaMismatch();
    error ScoreBelowThreshold();
    error JobNotSubmitted();
    error AlreadyResolved();
    error StaleVerdict();
    error ZeroAddress();
    error NotOpen();
    error AlreadyRegistered();
    error NotThisJudge();
    error NothingRegistered();
    error RenounceDisabled();

    /*//////////////////////////////////////////////////////////////
                              MODIFIERS
    //////////////////////////////////////////////////////////////*/

    modifier whenNotPaused() {
        if (paused) revert Paused_();
        _;
    }

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian();
        _;
    }

    /*//////////////////////////////////////////////////////////////
                             CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /// @param _acp      The ACP escrow contract address (Circle canonical on Arc).
    /// @param _guardian Guardian address able to pause + rotate signers.
    constructor(address _acp, address _guardian, address[] memory initialSigners)
        Ownable(msg.sender)
        EIP712("JudgeEvaluator", "1")
    {
        if (_acp == address(0) || _guardian == address(0)) revert ZeroAddress();
        acp = IACP(_acp);
        guardian = _guardian;
        for (uint256 i = 0; i < initialSigners.length; i++) {
            if (initialSigners[i] == address(0)) revert ZeroAddress();
            isSigner[initialSigners[i]] = true;
            emit SignerUpdated(initialSigners[i], true);
        }
    }

    /*//////////////////////////////////////////////////////////////
                          CRITERIA REGISTRATION
    //////////////////////////////////////////////////////////////*/

    /// @notice Bind acceptance criteria to a job, derived from the structured
    ///         criteria block in the (immutable) job description. Restricted to
    ///         allowlisted signers/owner and **write-once**, and only permitted
    ///         **before submission** (job still Open or Funded). These three
    ///         limits together prevent the criteria bar from being changed after
    ///         a provider has delivered — which would otherwise let a late
    ///         registration force a permanent CriteriaMismatch and strand the
    ///         provider's work until refund. Registration is optional: criteria
    ///         are already committed in the immutable description; this makes
    ///         that commitment explicit and gas-cheap to check.
    ///         Also refused while paused (so a leaked signer key cannot bind criteria in the window
    ///         between the guardian's pause and the owner's rotation) and for jobs that do not name
    ///         this judge as their evaluator.
    function registerCriteria(uint256 jobId, bytes32 criteriaHash) external whenNotPaused {
        if (!isSigner[msg.sender] && msg.sender != owner()) revert NotSigner();
        if (jobCriteria[jobId] != bytes32(0)) revert AlreadyRegistered();
        IACP.Job memory job = acp.getJob(jobId);
        if (job.evaluator != address(this)) revert NotThisJudge();
        if (uint8(job.status) >= uint8(IACP.JobStatus.Submitted)) revert NotOpen();
        jobCriteria[jobId] = criteriaHash;
        emit CriteriaRegistered(jobId, criteriaHash);
    }

    /*//////////////////////////////////////////////////////////////
                           VERDICT SUBMISSION
    //////////////////////////////////////////////////////////////*/

    /// @notice EIP-712 typehash for a verdict.
    bytes32 public constant VERDICT_TYPEHASH = keccak256(
        "Verdict(uint256 jobId,bytes32 criteriaHash,bytes32 deliverable,uint8 score,uint8 threshold,bool pass,bytes32 evidenceHash,uint64 timestamp)"
    );

    /// @notice Submit a signed verdict and resolve the job on the ACP contract.
    ///         `pass=true` completes the job (escrow → provider, minus fees);
    ///         `pass=false` rejects it (escrow refunded → client).
    /// @param v   The structured verdict.
    /// @param sig EIP-712 signature over `v` by an allowlisted signer.
    function submitVerdict(Verdict calldata v, bytes calldata sig) external nonReentrant whenNotPaused {
        // 1. Verify the producing signer is allowlisted.
        bytes32 digest = _hashTypedDataV4(_hashVerdict(v));
        address recovered = digest.recover(sig);
        if (!isSigner[recovered]) revert BadSignature();

        // 2. Restrict submission to an allowlisted signer/owner. This is the
        //    caller-gated path; `relay()` is the deliberately permissionless one.
        //    Note the trust boundary: because a validly-signed verdict is
        //    accepted by `relay()` from anyone, signer-key secrecy — not caller
        //    identity — is what secures verdicts. The signer allowlist plus the
        //    guardian pause are the controls; treat a leaked signer key as a
        //    full compromise and rotate it.
        if (!isSigner[msg.sender] && msg.sender != owner()) revert NotSigner();

        _resolve(v, recovered);
    }

    /// @notice Permissionless relay of a validly-signed verdict. Lets anyone
    ///         (e.g. a marketplace, a watcher, the provider) push a verdict the
    ///         judge service produced. Improves liveness without expanding trust:
    ///         the verdict is only accepted if the EIP-712 signer is allowlisted.
    function relay(Verdict calldata v, bytes calldata sig) external nonReentrant whenNotPaused {
        bytes32 digest = _hashTypedDataV4(_hashVerdict(v));
        address recovered = digest.recover(sig);
        if (!isSigner[recovered]) revert BadSignature();
        _resolve(v, recovered);
    }

    function _resolve(Verdict calldata v, address signer) internal {
        IACP.Job memory job = acp.getJob(v.jobId);

        // 3. Job must be awaiting evaluation and must name THIS contract as its
        //    evaluator (otherwise complete/reject would revert on the ACP side).
        if (job.status != IACP.JobStatus.Submitted) revert JobNotSubmitted();
        if (job.evaluator != address(this)) revert JobNotSubmitted();
        // Unreachable against an escrow that moves the job out of Submitted in the same call (as
        // Circle's and the reference escrow do): the status check above fires first. Kept as a guard
        // for an escrow that does not.
        if (verdicts[v.jobId].timestamp != 0) revert AlreadyResolved();
        // Check future first to avoid underflow in the age computation.
        if (v.timestamp > block.timestamp) revert StaleVerdict();
        if (block.timestamp - v.timestamp > 1 days) revert StaleVerdict();

        // 4. Bind verdict to the registered criteria, if any was registered.
        bytes32 registered = jobCriteria[v.jobId];
        if (registered != bytes32(0) && registered != v.criteriaHash) {
            revert CriteriaMismatch();
        }

        // 4b. Enforce internal consistency of the verdict: a PASS must clear its
        //     own declared threshold. Catches a buggy signer that sets pass=true
        //     with score below the bar, and makes the on-chain record checkable.
        if (v.pass && v.score < v.threshold) revert ScoreBelowThreshold();

        // 5. Record the verdict (immutable audit trail).
        verdicts[v.jobId] = v;
        verdictCount++;

        emit VerdictSubmitted(v.jobId, v.pass, v.score, v.criteriaHash, v.deliverable, v.evidenceHash, signer);

        // 6. Resolve on the ACP contract. reason = evidenceHash so anyone can
        //    recompute the verdict from the stored structured evidence.
        if (v.pass) {
            completedCount++;
            acp.complete(v.jobId, v.evidenceHash, "");
        } else {
            rejectedCount++;
            acp.reject(v.jobId, v.evidenceHash, "");
        }
    }

    function _hashVerdict(Verdict calldata v) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                VERDICT_TYPEHASH,
                v.jobId,
                v.criteriaHash,
                v.deliverable,
                v.score,
                v.threshold,
                v.pass,
                v.evidenceHash,
                v.timestamp
            )
        );
    }

    /*//////////////////////////////////////////////////////////////
                              ADMIN / GUARDIAN
    //////////////////////////////////////////////////////////////*/

    /// @notice Recovery for criteria a leaked signer key registered before the guardian paused. The owner,
    ///         who also controls the signer set, can clear a job's registration; the job's criteria are then
    ///         bound by its immutable description alone. Emits the hash it cleared.
    function clearCriteria(uint256 jobId) external onlyOwner {
        bytes32 cleared = jobCriteria[jobId];
        if (cleared == bytes32(0)) revert NothingRegistered();
        delete jobCriteria[jobId];
        emit CriteriaCleared(jobId, cleared);
    }

    /// @notice Disabled: without an owner no signer could ever be rotated or revoked again. Ownership moves
    ///         with transferOwnership, which the new owner must accept (Ownable2Step).
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    function setSigner(address signer, bool allowed) external onlyOwner {
        if (signer == address(0)) revert ZeroAddress();
        isSigner[signer] = allowed;
        emit SignerUpdated(signer, allowed);
    }

    /// @notice Guardian can pause (e.g. on suspected signer compromise). This
    ///         never locks funds — clients can always claimRefund after expiry.
    function setPaused(bool _paused) external onlyGuardian {
        paused = _paused;
        emit Paused(_paused);
    }

    function setGuardian(address _guardian) external onlyOwner {
        if (_guardian == address(0)) revert ZeroAddress();
        guardian = _guardian;
        emit GuardianUpdated(_guardian);
    }

    /// @notice Recover ERC-20 balances held by this contract. The canonical ACP
    ///         pays `evaluatorFeeBP` (currently 0, and settable only by Circle's
    ///         admin as a single global rate) to the job's `evaluator` — this
    ///         contract — on completion. This is the rescue hatch so any such
    ///         accrual, or tokens sent here by mistake, are recoverable. It is
    ///         NOT the service's pricing mechanism: per-evaluation fees are
    ///         charged out of band (the ACP has no per-job fee surface).
    /// @dev    This contract never holds job escrow; ACP custodies and disburses.
    function withdraw(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
        emit Withdrawn(token, to, amount);
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    function getVerdict(uint256 jobId) external view returns (Verdict memory) {
        return verdicts[jobId];
    }

    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
