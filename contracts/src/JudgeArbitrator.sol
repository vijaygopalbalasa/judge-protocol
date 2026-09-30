// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "./interfaces/IBountyAdapter.sol";

/// @title JudgeArbitrator
/// @notice Holds the arbitrator role on one ArcBounty BountyAdapter and settles a dispute only with a ruling that
///         an allowlisted Judge signer signed (EIP-712) for that exact bounty: this adapter on this chain, the job
///         id, the submission and description the adapter holds right now, the payout direction, the ruling file
///         and the reputation penalty. The contract never judges; it only makes the payout match a signed ruling.
///
///         ArcBounty keeps control. `principal` (their arbitrator Safe) settles any dispute Judge does not rule on
///         directly with resolveAsPrincipal(), and can take the role back at any time with handBack(), which also
///         stops rulings through this contract at once. A signer the owner adds becomes
///         usable only after SIGNER_DELAY, so the principal sees it coming and can take the role back first;
///         removing a signer is immediate. The owner cannot move the role and cannot settle anything without a
///         signer key. The adapter's own liveness paths (claimDefaultRuling, claimArbitratorTimeout) never depend
///         on this contract, so pausing it cannot freeze a bounty.
///
///         Non-upgradeable. It holds no funds: the adapter and its escrow move the USDC.
contract JudgeArbitrator is ReentrancyGuard, Ownable2Step, EIP712 {
    /*//////////////////////////////////////////////////////////////
                                TYPES
    //////////////////////////////////////////////////////////////*/

    struct Ruling {
        uint256 jobId; // the adapter's bounty id (the escrow job id)
        bytes32 submissionHash; // keccak256 of the bounty's submittedResultHash string
        bytes32 descriptionHash; // keccak256 of the bounty's ipfsDescHash string
        bool payProvider; // true pays the worker, false refunds the poster
        string rulingCid; // the ruling file, recorded by the adapter as disputeRulingHash
        uint8 reputationPenalty; // 0 to 100, applied by the adapter to an agent worker on a refund
        uint64 issuedAt; // when the ruling was signed
    }

    /*//////////////////////////////////////////////////////////////
                              CONSTANTS
    //////////////////////////////////////////////////////////////*/

    bytes32 public constant RULING_TYPEHASH = keccak256(
        "Ruling(address adapter,uint256 jobId,bytes32 submissionHash,bytes32 descriptionHash,bool payProvider,string rulingCid,uint8 reputationPenalty,uint64 issuedAt)"
    );

    /// @notice How long a signed ruling stays usable. Same bound as JudgeEvaluator's verdicts.
    uint256 public constant MAX_RULING_AGE = 1 days;

    /// @notice How long a newly added signer waits before its rulings are accepted.
    uint256 public constant SIGNER_DELAY = 2 days;

    /// @notice The adapter's own bound on a ruling reference (BountyAdapter.MAX_CID_LEN, checked by _requireCid).
    uint256 public constant MAX_CID_LEN = 96;

    /// @notice The adapter's own bound on the reputation penalty.
    uint8 public constant MAX_PENALTY = 100;

    /*//////////////////////////////////////////////////////////////
                                STATE
    //////////////////////////////////////////////////////////////*/

    /// @notice The one adapter this contract arbitrates for.
    IBountyAdapter public immutable adapter;

    /// @notice ArcBounty's arbitrator Safe: the only address that can take the role back.
    address public immutable principal;

    /// @notice When each signer's rulings start being accepted; 0 means not a signer.
    mapping(address => uint256) public signerActiveFrom;

    /// @notice When true, no ruling is applied. The adapter's liveness paths are unaffected.
    bool public paused;

    /// @notice Set by handBack(): no ruling is applied while the role is on its way back to ArcBounty. Cleared
    ///         only when the role is accepted again.
    bool public handingBack;

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event RulingApplied(
        uint256 indexed jobId, bool payProvider, string rulingCid, uint8 reputationPenalty, address indexed signer
    );
    event SignerAdded(address indexed signer, uint256 activeFrom);
    event SignerRemoved(address indexed signer);
    event PausedSet(bool paused);
    event RoleAccepted();
    event RoleHandedBack(address indexed next);
    event PrincipalRulingApplied(uint256 indexed jobId, bool payProvider, string rulingCid, uint8 reputationPenalty);

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error ZeroAddress();
    error Paused_();
    error HandingBack();
    error BadRulingCid();
    error PenaltyTooHigh();
    error FutureRuling();
    error StaleRuling();
    error BadSignature();
    error UnknownBounty();
    error NotInDispute();
    error SubmissionMismatch();
    error DescriptionMismatch();
    error AlreadySigner();
    error NotSigner();
    error NotPrincipal();
    error NotOwnerOrPrincipal();
    error RenounceDisabled();

    /*//////////////////////////////////////////////////////////////
                             CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /// @param _adapter        ArcBounty's BountyAdapter.
    /// @param _principal      ArcBounty's arbitrator Safe, which hands the role over and can take it back.
    /// @param initialSigners  Judge signers, active at once: the principal reviews them before handing over the role.
    constructor(address _adapter, address _principal, address[] memory initialSigners)
        Ownable(msg.sender)
        EIP712("JudgeArbitrator", "1")
    {
        if (_adapter == address(0) || _principal == address(0)) revert ZeroAddress();
        adapter = IBountyAdapter(_adapter);
        principal = _principal;
        uint256 activeFrom = block.timestamp == 0 ? 1 : block.timestamp;
        for (uint256 i = 0; i < initialSigners.length; i++) {
            address s = initialSigners[i];
            if (s == address(0)) revert ZeroAddress();
            if (signerActiveFrom[s] != 0) revert AlreadySigner();
            signerActiveFrom[s] = activeFrom;
            emit SignerAdded(s, activeFrom);
        }
    }

    /*//////////////////////////////////////////////////////////////
                               RULINGS
    //////////////////////////////////////////////////////////////*/

    /// @notice Apply a signed ruling to a disputed bounty. Anyone may relay it: the signature, not the caller, is
    ///         the authority, and it only settles the bounty, submission and description it was signed for.
    function resolve(Ruling calldata r, bytes calldata sig) external nonReentrant {
        if (paused) revert Paused_();
        if (handingBack) revert HandingBack();
        uint256 cidLen = bytes(r.rulingCid).length;
        if (cidLen == 0 || cidLen > MAX_CID_LEN) revert BadRulingCid();
        if (r.reputationPenalty > MAX_PENALTY) revert PenaltyTooHigh();
        if (r.issuedAt > block.timestamp) revert FutureRuling();
        if (block.timestamp - r.issuedAt > MAX_RULING_AGE) revert StaleRuling();

        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(_hashTypedDataV4(_hashRuling(r)), sig);
        if (err != ECDSA.RecoverError.NoError || !isActiveSigner(signer)) revert BadSignature();

        IBountyAdapter.BountyMeta memory b = adapter.bounties(r.jobId);
        if (b.poster == address(0)) revert UnknownBounty();
        if (!b.inDispute || b.resolved) revert NotInDispute();
        if (keccak256(bytes(b.submittedResultHash)) != r.submissionHash) revert SubmissionMismatch();
        if (keccak256(bytes(b.ipfsDescHash)) != r.descriptionHash) revert DescriptionMismatch();

        adapter.resolveDispute(r.jobId, r.payProvider, r.rulingCid, r.reputationPenalty);
        emit RulingApplied(r.jobId, r.payProvider, r.rulingCid, r.reputationPenalty, signer);
    }

    /// @notice ArcBounty settles a dispute itself, through this contract and with no Judge signature: the route for any
    ///         bounty Judge does not rule on (no criteria block, or a subjective question). It is the power the
    ///         principal already holds through handBack, without moving the role twice. Works while paused and while
    ///         the role is on its way back. Same bounds as a signed ruling.
    function resolveAsPrincipal(uint256 jobId, bool payProvider, string calldata rulingCid, uint8 reputationPenalty)
        external
        nonReentrant
    {
        if (msg.sender != principal) revert NotPrincipal();
        uint256 cidLen = bytes(rulingCid).length;
        if (cidLen == 0 || cidLen > MAX_CID_LEN) revert BadRulingCid();
        if (reputationPenalty > MAX_PENALTY) revert PenaltyTooHigh();
        IBountyAdapter.BountyMeta memory b = adapter.bounties(jobId);
        if (b.poster == address(0)) revert UnknownBounty();
        if (!b.inDispute || b.resolved) revert NotInDispute();

        adapter.resolveDispute(jobId, payProvider, rulingCid, reputationPenalty);
        emit PrincipalRulingApplied(jobId, payProvider, rulingCid, reputationPenalty);
    }

    /// @notice The EIP-712 digest a signer signs for `r`, for off-chain tooling.
    function rulingDigest(Ruling calldata r) external view returns (bytes32) {
        return _hashTypedDataV4(_hashRuling(r));
    }

    function isActiveSigner(address s) public view returns (bool) {
        uint256 from = signerActiveFrom[s];
        return from != 0 && block.timestamp >= from;
    }

    function _hashRuling(Ruling calldata r) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                RULING_TYPEHASH,
                address(adapter),
                r.jobId,
                r.submissionHash,
                r.descriptionHash,
                r.payProvider,
                keccak256(bytes(r.rulingCid)),
                r.reputationPenalty,
                r.issuedAt
            )
        );
    }

    /*//////////////////////////////////////////////////////////////
                          THE ARBITRATOR ROLE
    //////////////////////////////////////////////////////////////*/

    /// @notice Complete the adapter's two-step handover once the current arbitrator nominated this contract.
    function acceptRole() external {
        if (msg.sender != owner() && msg.sender != principal) revert NotOwnerOrPrincipal();
        handingBack = false;
        adapter.acceptArbitrator();
        emit RoleAccepted();
    }

    /// @notice ArcBounty takes the role back: nominate `next` on the adapter and stop applying rulings here at
    ///         once. `next` then calls acceptArbitrator() on the adapter. Works while paused.
    function handBack(address next) external {
        if (msg.sender != principal) revert NotPrincipal();
        if (next == address(0)) revert ZeroAddress();
        handingBack = true;
        adapter.transferArbitrator(next);
        emit RoleHandedBack(next);
    }

    /*//////////////////////////////////////////////////////////////
                                ADMIN
    //////////////////////////////////////////////////////////////*/

    /// @notice Add a signer. Its rulings count only after SIGNER_DELAY, so the principal can react first.
    function addSigner(address s) external onlyOwner {
        if (s == address(0)) revert ZeroAddress();
        if (signerActiveFrom[s] != 0) revert AlreadySigner();
        uint256 activeFrom = block.timestamp + SIGNER_DELAY;
        signerActiveFrom[s] = activeFrom;
        emit SignerAdded(s, activeFrom);
    }

    /// @notice Remove a signer, effective immediately.
    function removeSigner(address s) external onlyOwner {
        if (signerActiveFrom[s] == 0) revert NotSigner();
        delete signerActiveFrom[s];
        emit SignerRemoved(s);
    }

    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit PausedSet(p);
    }

    /// @notice Disabled: without an owner no signer could ever be removed again. Ownership moves with
    ///         transferOwnership, which the new owner must accept (Ownable2Step).
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }
}
