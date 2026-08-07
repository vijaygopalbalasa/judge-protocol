// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/IACPHook.sol";
import "./interfaces/IACP.sol";
import "./interfaces/IReputationRegistry.sol";

/// @title JudgeReputationHook
/// @notice Optional ERC-8183 hook that (a) gates funding by provider reputation
///         and (b) writes a structured feedback record into ERC-8004's
///         ReputationRegistry when a job reaches a terminal verdict. Keeps the
///         core ACP contract unaware of registry details (per the spec's
///         "separation of concerns" rationale).
///
///         All interactions flow through the ACP contract's before/afterAction
///         callbacks; nothing calls this hook directly (enforced by onlyACP).
///
///         Hookable selectors observed:
///           setBudget, fund, submit, complete, reject   (claimRefund is NOT hookable)
contract JudgeReputationHook is IACPHook, ERC165, Ownable {
    /*//////////////////////////////////////////////////////////////
                                STATE
    //////////////////////////////////////////////////////////////*/

    IACP public immutable acp;
    IReputationRegistry public reputation; // ERC-8004 ReputationRegistry

    /// @notice Optional minimum provider reputation score required to fund a job.
    ///         0 disables the gate. Scores are read off a pluggable oracle.
    uint256 public minProviderScore;

    /// @notice Map a provider address → ERC-8004 agentId, set by the operator
    ///         (the judge service) after verifying the agent's registration.
    mapping(address => uint256) public providerAgentId;

    /// @notice feedbackAuth per provider for this hook to post feedback.
    ///         agentId → authorization bytes (from the ERC-8004 flow).
    mapping(uint256 => bytes) public feedbackAuth;

    // ACP function selectors this hook cares about.
    bytes4 private constant SEL_FUND = IACP.fund.selector;
    bytes4 private constant SEL_COMPLETE = IACP.complete.selector;
    bytes4 private constant SEL_REJECT = IACP.reject.selector;

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/
    event ReputationFeedbackPosted(uint256 indexed jobId, uint256 indexed agentId, uint8 score, bool completed);
    event ProviderAgentSet(address indexed provider, uint256 indexed agentId);
    event MinScoreUpdated(uint256 minScore);

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/
    error OnlyACP();
    error ProviderBelowReputation();
    error ZeroAddress();

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/
    constructor(address _acp, address _reputation) Ownable(msg.sender) {
        if (_acp == address(0)) revert ZeroAddress();
        acp = IACP(_acp);
        reputation = IReputationRegistry(_reputation); // may be 0 (feedback off)
    }

    /*//////////////////////////////////////////////////////////////
                           ERC165 / INTERFACE
    //////////////////////////////////////////////////////////////*/
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC165, IERC165)
        returns (bool)
    {
        return interfaceId == type(IACPHook).interfaceId || super.supportsInterface(interfaceId);
    }

    /*//////////////////////////////////////////////////////////////
                             HOOK CALLBACKS
    //////////////////////////////////////////////////////////////*/

    modifier onlyACP() {
        if (msg.sender != address(acp)) revert OnlyACP();
        _;
    }

    /// @notice Pre-action gate. Currently enforces the provider reputation floor
    ///         at `fund` time. Reverts to block the action when policy fails.
    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata data)
        external
        onlyACP
    {
        if (selector == SEL_FUND && minProviderScore > 0) {
            IACP.Job memory job = acp.getJob(jobId);
            uint256 agentId = providerAgentId[job.provider];
            // Unregistered providers are treated as score 0 → blocked if gate on.
            if (agentId == 0) revert ProviderBelowReputation();
            // NOTE: an on-chain score read would go here via a reputation oracle.
            // v1 keeps the gate as a registration-presence check; scoring is
            // aggregated off-chain and enforced via `minProviderScore` policies
            // set per-deployment by the operator.
        }
    }

    /// @notice Post-action side effects. On terminal verdicts, post structured
    ///         feedback to ERC-8004's ReputationRegistry for the provider.
    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data)
        external
        onlyACP
    {
        bool isComplete = selector == SEL_COMPLETE;
        bool isReject = selector == SEL_REJECT;
        if (!isComplete && !isReject) return;
        if (address(reputation) == address(0)) return; // feedback disabled

        IACP.Job memory job = acp.getJob(jobId);
        uint256 agentId = providerAgentId[job.provider];
        if (agentId == 0) return; // provider not registered in ERC-8004

        // The ACP encodes afterAction data as (address caller, bytes32 reason,
        // bytes optParams). Guard the length before decoding — abi.decode cannot
        // be wrapped in try/catch, and a revert here must never roll back a
        // settlement that already moved funds. (128 = 3 head words + 1 length
        // word for an empty bytes tail.)
        if (data.length < 128) return;
        (, bytes32 reason, ) = abi.decode(data, (address, bytes32, bytes));

        uint8 score = isComplete ? 100 : 0;
        bytes32 tag2 = isComplete ? bytes32("completed") : bytes32("rejected");

        bytes memory auth = feedbackAuth[agentId];
        // Only post if the agent authorized this hook; otherwise skip silently
        // (feedback is a bonus signal, never a reason to revert a settlement).
        if (auth.length == 0) return;

        try reputation.giveFeedback(
            agentId, score, bytes32("judge-verdict"), tag2, "", reason, auth
        ) {
            emit ReputationFeedbackPosted(jobId, agentId, score, isComplete);
        } catch {
            // Swallow: a reputation-registry hiccup must never roll back a
            // settlement that already moved funds on the ACP contract.
        }
    }

    /*//////////////////////////////////////////////////////////////
                              OPERATOR ADMIN
    //////////////////////////////////////////////////////////////*/

    function setProviderAgent(address provider, uint256 agentId) external onlyOwner {
        providerAgentId[provider] = agentId;
        emit ProviderAgentSet(provider, agentId);
    }

    function setFeedbackAuth(uint256 agentId, bytes calldata auth) external onlyOwner {
        feedbackAuth[agentId] = auth;
    }

    function setMinProviderScore(uint256 score) external onlyOwner {
        minProviderScore = score;
        emit MinScoreUpdated(score);
    }

    function setReputation(address _reputation) external onlyOwner {
        reputation = IReputationRegistry(_reputation);
    }
}
