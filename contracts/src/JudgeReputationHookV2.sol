// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import "./interfaces/IACPHook.sol";
import "./interfaces/IACP.sol";
import "./interfaces/IERC8004.sol";

/// @title JudgeReputationHookV2
/// @notice ERC-8183 hook that turns each Judge verdict into ERC-8004 feedback for the provider's agent, written to
///         the ReputationRegistry as deployed (v2.0.0). A PASS is recorded as value 100 and a REJECT as 0 (tag1
///         "judge-verdict", tag2 "pass" or "reject", no decimals); the feedback hash is the verdict's evidence hash,
///         which anyone can recompute. The hook also keeps its own count per agent (tally).
///
///         Which jobs count. A job is attributed to an agent once, when it is funded: the job must name the
///         JudgeEvaluator as evaluator and have a budget, its client must not be its provider, and the provider wallet
///         must be linked to an agent it controls at that moment. Its verdict is then counted for that agent whatever
///         happens to the link or the agent before the verdict, so a provider that sees a REJECT coming (the judge is
///         deterministic) cannot unlink, or move the agent, to avoid it. A job with no budget never counts, even when
///         funded: nothing is at stake. Only the judge's own verdict is recorded: the escrow must be the caller and the
///         JudgeEvaluator the caller of complete/reject. A client cancelling an open job, or grading its own job,
///         writes nothing.
///
///         Linking. A provider wallet links itself with linkAgent (it must be the agent's owner, an approved operator,
///         or the agent's verified wallet); the link covers jobs funded from then on, and only while it still holds.
///
///         The registry refuses feedback from an operator of the agent, so an agent owner who approves this hook can
///         keep a verdict out of the registry. The tally still counts that verdict, and marks it as unrecorded, so
///         tally is the complete record and the registry the portable one.
///
///         A registry failure never reverses a payout: it is caught and reported as VerdictNotRecorded. Each registry
///         call gets a fixed gas allowance, and a fund or relay with too little gas for it reverts instead, so no gas
///         limit can fund a job without attributing it or settle one without counting its verdict. There is no owner
///         and nothing to configure after deployment.
///
///         Limit: a verdict shows the delivery met the client's criteria, not that the criteria were demanding. A
///         client and provider acting together from two wallets can still earn easy passes, so weigh this feedback by
///         who the clients were and what was at stake (each attributed job is in JobAttributed).
///
///         Supersedes JudgeReputationHook, which was written against an earlier ERC-8004 draft and cannot write to
///         the deployed registry.
contract JudgeReputationHookV2 is IACPHook, ERC165 {
    /*//////////////////////////////////////////////////////////////
                                 STATE
    //////////////////////////////////////////////////////////////*/

    struct Tally {
        uint64 passes;
        uint64 rejects;
        /// Verdicts counted here that the registry did not take.
        uint64 unrecorded;
    }

    IACP public immutable acp;
    /// @notice The JudgeEvaluator whose verdicts are recorded.
    address public immutable judge;
    IERC8004Identity public immutable identity;
    IERC8004Reputation public immutable reputation;

    string public constant TAG = "judge-verdict";

    /// @dev provider wallet => agentId + 1 (ERC-8004 agent ids start at 0, so 0 here means "not linked").
    mapping(address => uint256) private _linked;
    /// @dev jobId => agentId + 1, fixed when the job is funded and cleared when its verdict is counted.
    mapping(uint256 => uint256) private _jobAgent;
    mapping(uint256 => Tally) private _tally;

    bytes4 private constant SEL_FUND = IACP.fund.selector;
    bytes4 private constant SEL_COMPLETE = IACP.complete.selector;
    bytes4 private constant SEL_REJECT = IACP.reject.selector;

    /// @notice Gas given to each identity-registry read (two when a job is funded).
    uint256 public constant IDENTITY_GAS = 50_000;
    /// @notice Gas given to the registry's giveFeedback.
    uint256 public constant FEEDBACK_GAS = 400_000;
    /// @notice Gas afterAction needs in hand before attributing a funded job to a linked provider's agent. With less,
    ///         the fund reverts rather than skip the attribution.
    uint256 public constant ATTRIBUTE_GAS = 2 * IDENTITY_GAS + (2 * IDENTITY_GAS) / 63 + 40_000;
    /// @notice Gas afterAction needs in hand before counting an attributed verdict, so giveFeedback gets its full
    ///         allowance. With less, the relay reverts rather than settle without the record.
    uint256 public constant RECORD_GAS = FEEDBACK_GAS + FEEDBACK_GAS / 63 + 40_000;

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event AgentLinked(address indexed wallet, uint256 indexed agentId);
    event AgentUnlinked(address indexed wallet, uint256 indexed agentId);
    event JobAttributed(uint256 indexed jobId, uint256 indexed agentId);
    event VerdictRecorded(uint256 indexed jobId, uint256 indexed agentId, bool pass, bytes32 evidenceHash);
    /// @notice Counted in the tally, but the registry refused or failed the write. The payout went through.
    event VerdictNotRecorded(uint256 indexed jobId, uint256 indexed agentId, bool pass, bytes32 evidenceHash);

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error OnlyACP();
    error ZeroAddress();
    error NoCode();
    error NotAgentController();
    error NotLinked();
    error InsufficientGas();

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(address _acp, address _judge, address _identity, address _reputation) {
        if (_acp == address(0) || _judge == address(0) || _identity == address(0) || _reputation == address(0)) {
            revert ZeroAddress();
        }
        // A call to an address without code reverts in the caller, where try/catch cannot catch it.
        if (
            _acp.code.length == 0 || _judge.code.length == 0 || _identity.code.length == 0
                || _reputation.code.length == 0
        ) {
            revert NoCode();
        }
        acp = IACP(_acp);
        judge = _judge;
        identity = IERC8004Identity(_identity);
        reputation = IERC8004Reputation(_reputation);
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC165, IERC165) returns (bool) {
        return interfaceId == type(IACPHook).interfaceId || super.supportsInterface(interfaceId);
    }

    /*//////////////////////////////////////////////////////////////
                           LINKING AN AGENT
    //////////////////////////////////////////////////////////////*/

    /// @notice Link the calling wallet to its ERC-8004 agent, so Judge verdicts on jobs it delivers, funded from now
    ///         on, are counted for that agent. Replaces any earlier link.
    function linkAgent(uint256 agentId) external {
        if (!_controls(msg.sender, agentId)) revert NotAgentController();
        _linked[msg.sender] = agentId + 1;
        emit AgentLinked(msg.sender, agentId);
    }

    /// @notice Remove the calling wallet's link. Jobs already funded stay attributed.
    function unlinkAgent() external {
        uint256 stored = _linked[msg.sender];
        if (stored == 0) revert NotLinked();
        delete _linked[msg.sender];
        emit AgentUnlinked(msg.sender, stored - 1);
    }

    /// @notice The agent a wallet's newly funded jobs would be attributed to, if its link still holds.
    function linkedAgent(address wallet) public view returns (bool linked, uint256 agentId) {
        uint256 stored = _linked[wallet];
        if (stored == 0) return (false, 0);
        agentId = stored - 1;
        if (!_controls(wallet, agentId)) return (false, 0);
        return (true, agentId);
    }

    /// @notice The agent a funded job's verdict will be counted for. Cleared once the verdict is counted; a job that
    ///         expires instead keeps its entry, which nothing reads again.
    function jobAgent(uint256 jobId) external view returns (bool attributed, uint256 agentId) {
        uint256 stored = _jobAgent[jobId];
        if (stored == 0) return (false, 0);
        return (true, stored - 1);
    }

    /// @notice Every Judge verdict counted for an agent through this hook, including those the registry did not take.
    function tally(uint256 agentId) external view returns (uint64 passes, uint64 rejects, uint64 unrecorded) {
        Tally memory t = _tally[agentId];
        return (t.passes, t.rejects, t.unrecorded);
    }

    /// @dev Owner, approved operator, or the agent's verified wallet. A missing agent (the registry reverts), a failed
    ///      call or an answer that is not a clean word all count as no control.
    function _controls(address wallet, uint256 agentId) internal view returns (bool) {
        (bool ok, uint256 word) =
            _staticWord(address(identity), abi.encodeCall(IERC8004Identity.getAgentWallet, (agentId)));
        if (ok && word == uint256(uint160(wallet))) return true;
        (ok, word) =
            _staticWord(address(identity), abi.encodeCall(IERC8004Identity.isAuthorizedOrOwner, (wallet, agentId)));
        return ok && word == 1;
    }

    /// @dev A static call with IDENTITY_GAS that reads only the first word of the answer, so a registry cannot
    ///      make this contract spend more than that allowance, whatever it returns.
    function _staticWord(address target, bytes memory callData) private view returns (bool ok, uint256 word) {
        uint256 stipend = IDENTITY_GAS;
        assembly ("memory-safe") {
            ok := staticcall(stipend, target, add(callData, 0x20), mload(callData), 0x00, 0x20)
            if lt(returndatasize(), 0x20) { ok := 0 }
            word := mload(0x00)
        }
    }

    /*//////////////////////////////////////////////////////////////
                             HOOK CALLBACKS
    //////////////////////////////////////////////////////////////*/

    modifier onlyACP() {
        if (msg.sender != address(acp)) revert OnlyACP();
        _;
    }

    /// @notice Nothing to check before an action: this hook never blocks one.
    function beforeAction(uint256, bytes4, bytes calldata) external view onlyACP {}

    /// @notice Attribute a job when it is funded; count and record its verdict once the escrow has settled it.
    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external onlyACP {
        if (selector == SEL_FUND) {
            _attribute(jobId);
            return;
        }
        bool pass = selector == SEL_COMPLETE;
        if (!pass && selector != SEL_REJECT) return;

        // complete/reject hook data is abi.encode(address caller, bytes32 reason, bytes optParams). Check the length
        // first: abi.decode cannot be caught, and a revert here would roll back the payout. (128 = three head words
        // plus the length word of an empty bytes tail.)
        if (data.length < 128) return;
        (address caller, bytes32 evidenceHash,) = abi.decode(data, (address, bytes32, bytes));
        if (caller != judge) return;

        uint256 stored = _jobAgent[jobId];
        if (stored == 0) return;
        // From here the outcome must not depend on the gas the relayer chose (see RECORD_GAS).
        if (gasleft() < RECORD_GAS) revert InsufficientGas();
        delete _jobAgent[jobId];
        uint256 agentId = stored - 1;

        Tally storage t = _tally[agentId];
        if (pass) t.passes++;
        else t.rejects++;

        try reputation.giveFeedback{gas: FEEDBACK_GAS}(
            agentId, pass ? int128(100) : int128(0), 0, TAG, pass ? "pass" : "reject", "", "", evidenceHash
        ) {
            emit VerdictRecorded(jobId, agentId, pass, evidenceHash);
        } catch {
            t.unrecorded++;
            emit VerdictNotRecorded(jobId, agentId, pass, evidenceHash);
        }
    }

    /// @dev Fix the agent a funded job's verdict will count for, if the job qualifies (see the contract notice).
    function _attribute(uint256 jobId) internal {
        IACP.Job memory job = acp.getJob(jobId);
        if (job.evaluator != judge || job.client == job.provider || job.budget == 0) return;
        uint256 stored = _linked[job.provider];
        if (stored == 0) return;
        // From here the outcome must not depend on the gas the client chose (see ATTRIBUTE_GAS).
        if (gasleft() < ATTRIBUTE_GAS) revert InsufficientGas();
        uint256 agentId = stored - 1;
        if (!_controls(job.provider, agentId)) return;
        _jobAgent[jobId] = stored;
        emit JobAttributed(jobId, agentId);
    }
}
