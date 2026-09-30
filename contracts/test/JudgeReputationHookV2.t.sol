// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "../src/JudgeEvaluator.sol";
import "../src/JudgeReputationHookV2.sol";
import "../src/mocks/MockUSDC.sol";
import {AgenticCommerce} from "../vendor/erc8183-escrow/AgenticCommerce.sol";
import {IdentityRegistryUpgradeable} from "./vendor/erc8004/IdentityRegistryUpgradeable.sol";
import {ReputationRegistryUpgradeable} from "./vendor/erc8004/ReputationRegistryUpgradeable.sol";
import {Erc8004Placeholder} from "./helpers/Erc8004Placeholder.sol";
import {
    RevertingReputation, GasBurningReputation, SwitchableIdentity, SlowIdentity
} from "./helpers/HostileErc8004.sol";

/// Every test runs the real pieces together: the ERC-8183 escrow Judge serves on Arc (vendored), the real
/// JudgeEvaluator, and the ERC-8004 registries at the version deployed on Monad, Arbitrum, Base, Celo and Arc
/// testnets (vendored, deployed the way the ERC-8004 team deploys them: a placeholder implementation that sets
/// the owner, then an upgrade by that owner to the real registry).
contract JudgeReputationHookV2Test is Test {
    address constant ERC8004_OWNER = 0x547289319C3e6aedB179C0b8e8aF0B5ACd062603;

    MockUSDC usdc;
    AgenticCommerce escrow;
    JudgeEvaluator judge;
    IdentityRegistryUpgradeable identity;
    ReputationRegistryUpgradeable reputation;
    JudgeReputationHookV2 hook;

    address admin = makeAddr("escrowAdmin");
    address treasury = makeAddr("treasury");
    address guardian = makeAddr("guardian");
    uint256 signerKey = 0xA11CE;
    address signer = vm.addr(signerKey);
    address client = makeAddr("client");
    address provider = makeAddr("provider");
    address stranger = makeAddr("stranger");

    uint256 providerAgent; // the provider's ERC-8004 agent id (0: ids start at 0)

    uint256 constant BUDGET = 5_000_000; // 5 test USDC, 6 decimals
    bytes32 constant CRITERIA = keccak256("criteria-json-v1");
    bytes32 constant DELIVERABLE = keccak256("deliverable-payload");
    bytes32 constant EVIDENCE = keccak256("verdict-json");

    event VerdictRecorded(uint256 indexed jobId, uint256 indexed agentId, bool pass, bytes32 evidenceHash);
    event VerdictNotRecorded(uint256 indexed jobId, uint256 indexed agentId, bool pass, bytes32 evidenceHash);
    event JobAttributed(uint256 indexed jobId, uint256 indexed agentId);
    event AgentLinked(address indexed wallet, uint256 indexed agentId);
    event AgentUnlinked(address indexed wallet, uint256 indexed agentId);

    function setUp() public {
        vm.warp(1_760_000_000);
        usdc = new MockUSDC();

        AgenticCommerce escrowImpl = new AgenticCommerce();
        escrow = AgenticCommerce(
            address(
                new ERC1967Proxy(
                    address(escrowImpl), abi.encodeCall(AgenticCommerce.initialize, (address(usdc), treasury, admin))
                )
            )
        );

        address[] memory signers = new address[](1);
        signers[0] = signer;
        judge = new JudgeEvaluator(address(escrow), guardian, signers);

        (identity, reputation) = _deployErc8004();

        hook = new JudgeReputationHookV2(address(escrow), address(judge), address(identity), address(reputation));
        vm.prank(admin);
        escrow.setHookWhitelist(address(hook), true);

        vm.prank(provider);
        providerAgent = identity.register("ipfs://provider-agent-card");
        vm.prank(provider);
        hook.linkAgent(providerAgent);

        usdc.mint(client, 1_000e6);
        vm.prank(client);
        usdc.approve(address(escrow), type(uint256).max);
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    function _deployErc8004() internal returns (IdentityRegistryUpgradeable id, ReputationRegistryUpgradeable rep) {
        Erc8004Placeholder placeholder = new Erc8004Placeholder();

        address idProxy = address(
            new ERC1967Proxy(address(placeholder), abi.encodeCall(Erc8004Placeholder.initialize, (ERC8004_OWNER)))
        );
        IdentityRegistryUpgradeable idImpl = new IdentityRegistryUpgradeable();
        vm.prank(ERC8004_OWNER);
        UUPSUpgradeable(idProxy).upgradeToAndCall(
            address(idImpl), abi.encodeCall(IdentityRegistryUpgradeable.initialize, ())
        );

        address repProxy = address(
            new ERC1967Proxy(address(placeholder), abi.encodeCall(Erc8004Placeholder.initialize, (ERC8004_OWNER)))
        );
        ReputationRegistryUpgradeable repImpl = new ReputationRegistryUpgradeable();
        vm.prank(ERC8004_OWNER);
        UUPSUpgradeable(repProxy).upgradeToAndCall(
            address(repImpl), abi.encodeCall(ReputationRegistryUpgradeable.initialize, (idProxy))
        );

        return (IdentityRegistryUpgradeable(idProxy), ReputationRegistryUpgradeable(repProxy));
    }

    /// An open job for `prov`, graded by `evaluator`, through hook `h`.
    function _openJob(JudgeReputationHookV2 h, address prov, address evaluator) internal returns (uint256 jobId) {
        vm.prank(client);
        jobId = escrow.createJob(prov, evaluator, block.timestamp + 1 days, "job", address(h));
        vm.prank(prov);
        escrow.setBudget(jobId, BUDGET, "");
    }

    function _fund(uint256 jobId) internal {
        vm.prank(client);
        escrow.fund(jobId, "");
    }

    function _submit(uint256 jobId, address prov) internal {
        vm.prank(prov);
        escrow.submit(jobId, DELIVERABLE, "");
    }

    /// A funded, submitted job for `prov`, graded by `evaluator`, with this test's hook attached.
    function _submittedJob(address prov, address evaluator) internal returns (uint256 jobId) {
        jobId = _openJob(hook, prov, evaluator);
        _fund(jobId);
        _submit(jobId, prov);
    }

    function _verdict(uint256 jobId, bool pass) internal view returns (JudgeEvaluator.Verdict memory) {
        return JudgeEvaluator.Verdict({
            jobId: jobId,
            criteriaHash: CRITERIA,
            deliverable: DELIVERABLE,
            score: pass ? 100 : 20,
            threshold: 100,
            pass: pass,
            evidenceHash: EVIDENCE,
            timestamp: uint64(block.timestamp)
        });
    }

    function _sign(JudgeEvaluator.Verdict memory v) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                judge.VERDICT_TYPEHASH(),
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
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", judge.DOMAIN_SEPARATOR(), structHash));
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        return abi.encodePacked(r, s, vv);
    }

    /// Anyone may relay a signed verdict; the relayer is irrelevant to the hook.
    function _rule(uint256 jobId, bool pass) internal {
        JudgeEvaluator.Verdict memory v = _verdict(jobId, pass);
        bytes memory sig = _sign(v);
        vm.prank(stranger);
        judge.relay(v, sig);
    }

    function _hookClients(JudgeReputationHookV2 h) internal pure returns (address[] memory c) {
        c = new address[](1);
        c[0] = address(h);
    }

    function _summary(uint256 agentId) internal view returns (uint64 count, int128 value, uint8 decimals) {
        return reputation.getSummary(agentId, _hookClients(hook), "judge-verdict", "");
    }

    function _written(uint256 agentId) internal view returns (uint64) {
        return reputation.getLastIndex(agentId, address(hook));
    }

    function _tally(JudgeReputationHookV2 h, uint256 agentId)
        internal
        view
        returns (uint64 passes, uint64 rejects, uint64 unrecorded)
    {
        return h.tally(agentId);
    }

    /*//////////////////////////////////////////////////////////////
                    A JUDGE VERDICT BECOMES ERC-8004 FEEDBACK
    //////////////////////////////////////////////////////////////*/

    function test_pass_recordsFeedbackOf100() public {
        uint256 jobId = _submittedJob(provider, address(judge));

        vm.expectEmit(true, true, false, true, address(hook));
        emit VerdictRecorded(jobId, providerAgent, true, EVIDENCE);
        _rule(jobId, true);

        assertEq(usdc.balanceOf(provider), BUDGET, "provider paid");
        (uint64 count, int128 value, uint8 decimals) = _summary(providerAgent);
        assertEq(count, 1);
        assertEq(value, 100);
        assertEq(decimals, 0);
        (int128 v, uint8 d, string memory tag1, string memory tag2, bool revoked) =
            reputation.readFeedback(providerAgent, address(hook), 1);
        assertEq(v, 100);
        assertEq(d, 0);
        assertEq(tag1, "judge-verdict");
        assertEq(tag2, "pass");
        assertFalse(revoked);
        (uint64 p, uint64 r, uint64 u) = _tally(hook, providerAgent);
        assertEq(p, 1);
        assertEq(r, 0);
        assertEq(u, 0);
    }

    function test_reject_recordsFeedbackOf0() public {
        uint256 jobId = _submittedJob(provider, address(judge));

        vm.expectEmit(true, true, false, true, address(hook));
        emit VerdictRecorded(jobId, providerAgent, false, EVIDENCE);
        _rule(jobId, false);

        assertEq(usdc.balanceOf(client), 1_000e6, "client refunded in full");
        (uint64 count, int128 value,) = _summary(providerAgent);
        assertEq(count, 1);
        assertEq(value, 0);
        (,,, string memory tag2,) = reputation.readFeedback(providerAgent, address(hook), 1);
        assertEq(tag2, "reject");
        (uint64 p, uint64 r,) = _tally(hook, providerAgent);
        assertEq(p, 0);
        assertEq(r, 1);
    }

    function test_feedbackCarriesTheEvidenceHashInTheRegistryEvent() public {
        uint256 jobId = _submittedJob(provider, address(judge));
        vm.recordLogs();
        _rule(jobId, true);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 newFeedback =
            keccak256("NewFeedback(uint256,address,uint64,int128,uint8,string,string,string,string,string,bytes32)");
        bool found;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != address(reputation) || logs[i].topics[0] != newFeedback) continue;
            found = true;
            assertEq(uint256(logs[i].topics[1]), providerAgent, "agentId");
            assertEq(address(uint160(uint256(logs[i].topics[2]))), address(hook), "client is the hook");
            (,,,,,,, bytes32 feedbackHash) =
                abi.decode(logs[i].data, (uint64, int128, uint8, string, string, string, string, bytes32));
            assertEq(feedbackHash, EVIDENCE, "feedbackHash = the verdict's evidence hash");
        }
        assertTrue(found, "NewFeedback emitted by the registry");
    }

    function test_passAndReject_averageIsThePassRate() public {
        _rule(_submittedJob(provider, address(judge)), true);
        _rule(_submittedJob(provider, address(judge)), false);
        _rule(_submittedJob(provider, address(judge)), true);
        _rule(_submittedJob(provider, address(judge)), true);
        (uint64 count, int128 value, uint8 decimals) = _summary(providerAgent);
        assertEq(count, 4);
        assertEq(value, 75);
        assertEq(decimals, 0);
        (uint64 p, uint64 r, uint64 u) = _tally(hook, providerAgent);
        assertEq(p, 3);
        assertEq(r, 1);
        assertEq(u, 0);
    }

    function test_nothingIsRecordedBeforeAVerdict() public {
        _submittedJob(provider, address(judge)); // create, setBudget, fund, submit all pass through the hook
        assertEq(_written(providerAgent), 0);
    }

    /*//////////////////////////////////////////////////////////////
          THE JOB IS ATTRIBUTED WHEN IT IS FUNDED, BEFORE ANY WORK EXISTS
    //////////////////////////////////////////////////////////////*/

    function test_fundingAttributesTheJobToTheLinkedAgent() public {
        uint256 jobId = _openJob(hook, provider, address(judge));
        (bool attributed,) = hook.jobAgent(jobId);
        assertFalse(attributed, "not before funding");

        vm.expectEmit(true, true, false, false, address(hook));
        emit JobAttributed(jobId, providerAgent);
        _fund(jobId);

        uint256 agentId;
        (attributed, agentId) = hook.jobAgent(jobId);
        assertTrue(attributed);
        assertEq(agentId, providerAgent);
    }

    function test_unlinkingAfterFunding_cannotDodgeAReject() public {
        // The judge is deterministic, so a provider can know a REJECT is coming before it is relayed.
        uint256 jobId = _submittedJob(provider, address(judge));
        vm.prank(provider);
        hook.unlinkAgent();
        _rule(jobId, false);
        vm.prank(provider);
        hook.linkAgent(providerAgent);

        assertEq(_written(providerAgent), 1, "the reject was recorded");
        (,,, string memory tag2,) = reputation.readFeedback(providerAgent, address(hook), 1);
        assertEq(tag2, "reject");
    }

    function test_movingTheAgentAfterFunding_cannotDodgeAReject() public {
        // Moving the agent to another wallet (clearing its verified wallet) and back must not hide the verdict.
        uint256 jobId = _submittedJob(provider, address(judge));
        address other = makeAddr("otherWalletOfTheProvider");
        vm.prank(provider);
        identity.transferFrom(provider, other, providerAgent);
        _rule(jobId, false);
        vm.prank(other);
        identity.transferFrom(other, provider, providerAgent);

        assertEq(_written(providerAgent), 1, "the reject was recorded on the agent that did the job");
        (, uint64 r,) = _tally(hook, providerAgent);
        assertEq(r, 1);
    }

    function test_linkingAfterFunding_doesNotBackdate() public {
        address late = makeAddr("lateLinker");
        vm.prank(late);
        uint256 lateAgent = identity.register("ipfs://late");
        uint256 jobId = _openJob(hook, late, address(judge));
        _fund(jobId); // not linked yet: the job is not attributed
        vm.prank(late);
        hook.linkAgent(lateAgent);
        _submit(jobId, late);
        _rule(jobId, true);

        assertEq(_written(lateAgent), 0, "a link made after funding does not cover that job");
        (bool attributed,) = hook.jobAgent(jobId);
        assertFalse(attributed);
    }

    function test_approvingTheHookBlocksTheRegistryWrite_butTheTallyStillCountsIt() public {
        // The registry refuses feedback from an operator of the agent. A provider can use that to keep one verdict
        // out of the registry; the hook's own tally still counts it, as unrecorded.
        uint256 jobId = _submittedJob(provider, address(judge));
        vm.prank(provider);
        identity.approve(address(hook), providerAgent);

        vm.expectEmit(true, true, false, true, address(hook));
        emit VerdictNotRecorded(jobId, providerAgent, false, EVIDENCE);
        _rule(jobId, false);

        assertEq(usdc.balanceOf(client), 1_000e6, "the refund went through");
        assertEq(_written(providerAgent), 0, "the registry refused it");
        (uint64 p, uint64 r, uint64 u) = _tally(hook, providerAgent);
        assertEq(p, 0);
        assertEq(r, 1, "the reject is counted");
        assertEq(u, 1, "and marked as kept out of the registry");
    }

    function test_attributionIsConsumedOnce() public {
        uint256 jobId = _submittedJob(provider, address(judge));
        _rule(jobId, true);
        (bool attributed,) = hook.jobAgent(jobId);
        assertFalse(attributed, "cleared once the verdict is recorded");
    }

    /*//////////////////////////////////////////////////////////////
                  JOBS THAT NEVER COUNT AS A JUDGE VERDICT
    //////////////////////////////////////////////////////////////*/

    function test_clientCancellingAnOpenJob_recordsNothing() public {
        uint256 jobId = _openJob(hook, provider, address(judge));
        vm.prank(client);
        escrow.reject(jobId, bytes32("changed my mind"), "");
        assertEq(_written(providerAgent), 0, "a cancel is not a verdict");
        (uint64 p, uint64 r,) = _tally(hook, providerAgent);
        assertEq(p + r, 0);
    }

    function test_selfGradedJob_recordsNothing() public {
        uint256 jobId = _submittedJob(provider, client); // the client grades its own job
        (bool attributed,) = hook.jobAgent(jobId);
        assertFalse(attributed, "a job the judge does not grade is never attributed");
        vm.prank(client);
        escrow.complete(jobId, bytes32("looks fine to me"), "");
        assertEq(usdc.balanceOf(provider), BUDGET, "settled normally");
        assertEq(_written(providerAgent), 0, "self-grading is not a judge verdict");
    }

    function test_selfGradedReject_recordsNothing() public {
        uint256 jobId = _submittedJob(provider, client);
        vm.prank(client);
        escrow.reject(jobId, bytes32("no"), "");
        assertEq(_written(providerAgent), 0);
    }

    function test_zeroBudgetJob_isNotRecorded() public {
        // Nothing at stake and never funded: no attribution, so a free job cannot build reputation.
        vm.prank(client);
        uint256 jobId = escrow.createJob(provider, address(judge), block.timestamp + 1 days, "job", address(hook));
        _submit(jobId, provider); // allowed while Open with no budget
        _rule(jobId, true);
        assertEq(uint256(escrow.getJob(jobId).status), uint256(AgenticCommerce.JobStatus.Completed));
        assertEq(_written(providerAgent), 0);
    }

    function test_zeroBudgetFundedJob_isNotAttributed() public {
        // This escrow lets a job with no budget be funded (nothing moves). With nothing at stake it must not count,
        // or two wallets could farm passes for free.
        vm.prank(client);
        uint256 jobId = escrow.createJob(provider, address(judge), block.timestamp + 1 days, "job", address(hook));
        _fund(jobId);
        assertEq(uint256(escrow.getJob(jobId).status), uint256(AgenticCommerce.JobStatus.Funded), "funded with 0");
        (bool attributed,) = hook.jobAgent(jobId);
        assertFalse(attributed, "a job with no budget is never attributed");
        _submit(jobId, provider);
        _rule(jobId, true);
        assertEq(_written(providerAgent), 0);
        (uint64 p, uint64 r,) = _tally(hook, providerAgent);
        assertEq(p + r, 0);
    }

    function test_selfDealtJob_clientIsProvider_isNotRecorded() public {
        usdc.mint(provider, BUDGET);
        vm.prank(provider);
        usdc.approve(address(escrow), BUDGET);
        vm.prank(provider);
        uint256 jobId = escrow.createJob(provider, address(judge), block.timestamp + 1 days, "job", address(hook));
        vm.prank(provider);
        escrow.setBudget(jobId, BUDGET, "");
        vm.prank(provider);
        escrow.fund(jobId, "");
        _submit(jobId, provider);
        _rule(jobId, true);
        assertEq(_written(providerAgent), 0, "a job one wallet pays itself for earns nothing");
    }

    /*//////////////////////////////////////////////////////////////
                    LINKING A PROVIDER WALLET TO ITS AGENT
    //////////////////////////////////////////////////////////////*/

    function test_agentIdZeroIsARealAgent() public view {
        assertEq(providerAgent, 0, "the first ERC-8004 agent is id 0");
        (bool linked, uint256 agentId) = hook.linkedAgent(provider);
        assertTrue(linked);
        assertEq(agentId, 0);
    }

    function test_link_emitsAndReportsTheAgent() public {
        address other = makeAddr("other");
        vm.prank(other);
        uint256 id = identity.register("ipfs://other");
        vm.expectEmit(true, true, false, false, address(hook));
        emit AgentLinked(other, id);
        vm.prank(other);
        hook.linkAgent(id);
        (bool linked, uint256 agentId) = hook.linkedAgent(other);
        assertTrue(linked);
        assertEq(agentId, id);
    }

    function test_link_refusesSomeoneElsesAgent() public {
        vm.prank(stranger);
        vm.expectRevert(JudgeReputationHookV2.NotAgentController.selector);
        hook.linkAgent(providerAgent);
    }

    function test_link_refusesAnAgentThatDoesNotExist() public {
        vm.prank(provider);
        vm.expectRevert(JudgeReputationHookV2.NotAgentController.selector);
        hook.linkAgent(999);
    }

    function test_link_worksForTheAgentsVerifiedWallet() public {
        address owner_ = makeAddr("agentOwner");
        uint256 walletKey = 0xB0B;
        address wallet = vm.addr(walletKey);
        vm.prank(owner_);
        uint256 id = identity.register("ipfs://agent");

        // The owner points the agent at `wallet`, which signs its consent (ERC-8004 setAgentWallet).
        uint256 deadline = block.timestamp + 60;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)"),
                id,
                wallet,
                owner_,
                deadline
            )
        );
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ERC8004IdentityRegistry"),
                keccak256("1"),
                block.chainid,
                address(identity)
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(walletKey, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        vm.prank(owner_);
        identity.setAgentWallet(id, wallet, deadline, abi.encodePacked(r, s, v));
        assertEq(identity.getAgentWallet(id), wallet);
        assertFalse(identity.isAuthorizedOrOwner(wallet, id), "the wallet is neither owner nor operator");

        vm.prank(wallet);
        hook.linkAgent(id);
        (bool linked, uint256 agentId) = hook.linkedAgent(wallet);
        assertTrue(linked);
        assertEq(agentId, id);

        // And a verdict on a job the wallet delivers lands on that agent.
        uint256 jobId = _submittedJob(wallet, address(judge));
        _rule(jobId, true);
        (uint64 count,,) = _summary(id);
        assertEq(count, 1);
    }

    function test_unlink_beforeFunding_meansTheJobIsNotRecorded() public {
        vm.expectEmit(true, true, false, false, address(hook));
        emit AgentUnlinked(provider, providerAgent);
        vm.prank(provider);
        hook.unlinkAgent();
        (bool linked,) = hook.linkedAgent(provider);
        assertFalse(linked);

        _rule(_submittedJob(provider, address(judge)), true);
        assertEq(_written(providerAgent), 0);
    }

    function test_unlink_refusesWhenNothingIsLinked() public {
        vm.prank(stranger);
        vm.expectRevert(JudgeReputationHookV2.NotLinked.selector);
        hook.unlinkAgent();
    }

    function test_unlinkedProvider_settlesWithoutFeedback() public {
        address newcomer = makeAddr("newcomer");
        uint256 jobId = _submittedJob(newcomer, address(judge));
        _rule(jobId, true);
        assertEq(usdc.balanceOf(newcomer), BUDGET, "paid as usual");
    }

    function test_aLinkThatNoLongerHolds_doesNotAttributeNewJobs() public {
        address buyer = makeAddr("buyer");
        vm.prank(provider);
        identity.transferFrom(provider, buyer, providerAgent);
        (bool linked,) = hook.linkedAgent(provider);
        assertFalse(linked, "the provider no longer controls the agent");

        uint256 jobId = _submittedJob(provider, address(judge));
        (bool attributed,) = hook.jobAgent(jobId);
        assertFalse(attributed);
        _rule(jobId, true);
        assertEq(usdc.balanceOf(provider), BUDGET, "settled normally");
        assertEq(_written(providerAgent), 0, "nothing written to the buyer's agent");
    }

    /*//////////////////////////////////////////////////////////////
                  FEEDBACK NEVER BLOCKS OR REVERSES A PAYOUT
    //////////////////////////////////////////////////////////////*/

    /// A job for `prov` graded by the judge, through hook `h`, funded and submitted.
    function _submittedJobVia(JudgeReputationHookV2 h, address prov) internal returns (uint256 jobId) {
        vm.prank(admin);
        escrow.setHookWhitelist(address(h), true);
        jobId = _openJob(h, prov, address(judge));
        _fund(jobId);
        _submit(jobId, prov);
    }

    function test_revertingRegistry_stillSettles_andTheTallyCounts() public {
        JudgeReputationHookV2 h = new JudgeReputationHookV2(
            address(escrow), address(judge), address(identity), address(new RevertingReputation())
        );
        vm.prank(provider);
        h.linkAgent(providerAgent);
        uint256 jobId = _submittedJobVia(h, provider);

        vm.expectEmit(true, true, false, true, address(h));
        emit VerdictNotRecorded(jobId, providerAgent, false, EVIDENCE);
        _rule(jobId, false);
        assertEq(usdc.balanceOf(client), 1_000e6, "refund went through");
        (, uint64 r, uint64 u) = _tally(h, providerAgent);
        assertEq(r, 1);
        assertEq(u, 1);
    }

    function test_gasBurningRegistry_stillSettles() public {
        JudgeReputationHookV2 h = new JudgeReputationHookV2(
            address(escrow), address(judge), address(identity), address(new GasBurningReputation())
        );
        vm.prank(provider);
        h.linkAgent(providerAgent);
        uint256 jobId = _submittedJobVia(h, provider);

        vm.expectEmit(true, true, false, true, address(h));
        emit VerdictNotRecorded(jobId, providerAgent, true, EVIDENCE);
        JudgeEvaluator.Verdict memory v = _verdict(jobId, true);
        judge.relay{gas: 2_000_000}(v, _sign(v)); // the registry's allowance is bounded: this is enough
        assertEq(usdc.balanceOf(provider), BUDGET, "payout went through");
    }

    function test_gasBurningRegistry_costsTheRelayerAtMostItsAllowance() public {
        JudgeReputationHookV2 h = new JudgeReputationHookV2(
            address(escrow), address(judge), address(identity), address(new GasBurningReputation())
        );
        vm.prank(provider);
        h.linkAgent(providerAgent);
        uint256 jobId = _submittedJobVia(h, provider);
        JudgeEvaluator.Verdict memory v = _verdict(jobId, true);
        bytes memory sig = _sign(v);
        uint256 before = gasleft();
        judge.relay{gas: 10_000_000}(v, sig);
        uint256 used = before - gasleft();
        assertLt(used, 1_000_000, "a registry that burns gas costs the relayer its allowance, not the whole limit");
    }

    function test_slowButHonestIdentity_fundGasCannotSkipTheAttribution() public {
        // Each read burns 45,000 gas (under the 50,000 allowance) and then answers honestly. Whatever gas limit the
        // client funds with, the job is funded and attributed, or not funded.
        SlowIdentity slow = new SlowIdentity();
        slow.set(abi.encode(provider), 45_000);
        JudgeReputationHookV2 h =
            new JudgeReputationHookV2(address(escrow), address(judge), address(slow), address(reputation));
        vm.prank(provider);
        h.linkAgent(3);
        vm.prank(admin);
        escrow.setHookWhitelist(address(h), true);
        uint256 jobId = _openJob(h, provider, address(judge));

        uint256 funded;
        uint256 refused;
        for (uint256 g = 100_000; g <= 260_000; g += 100) {
            uint256 snap = vm.snapshotState();
            vm.prank(client);
            try escrow.fund{gas: g}(jobId, "") {
                funded++;
                (bool attributed,) = h.jobAgent(jobId);
                assertTrue(attributed, "funded without attribution");
            } catch {
                refused++;
            }
            vm.revertToState(snap);
        }
        assertGt(funded, 0, "some gas limit funds");
        assertGt(refused, 0, "some gas limit is too low");
    }

    function test_hostileIdentityAnswers_attributeNothingAndSettle() public {
        SwitchableIdentity fake = new SwitchableIdentity();
        JudgeReputationHookV2 h =
            new JudgeReputationHookV2(address(escrow), address(judge), address(fake), address(reputation));
        fake.setAnswer(abi.encode(provider)); // "the agent's wallet is the provider"
        vm.prank(provider);
        h.linkAgent(7);

        bytes[] memory answers = new bytes[](5);
        answers[0] = abi.encode(type(uint256).max); // not an address, not a bool
        answers[1] = hex"01"; // shorter than a word
        answers[2] = ""; // nothing at all
        answers[3] = new bytes(1_000_000); // a megabyte of zeros
        answers[4] = abi.encode(uint256(uint160(provider)) | (uint256(1) << 200)); // the provider, with dirty high bits

        for (uint256 i; i < answers.length; i++) {
            fake.setAnswer(answers[i]);
            (bool linked,) = h.linkedAgent(provider);
            assertFalse(linked, "a malformed answer is not control");
            uint256 jobId = _submittedJobVia(h, provider);
            (bool attributed,) = h.jobAgent(jobId);
            assertFalse(attributed);
            uint256 before = usdc.balanceOf(provider);
            _rule(jobId, true);
            assertEq(usdc.balanceOf(provider), before + BUDGET, "payout went through");
        }

        fake.setReverts(true);
        uint256 last = _submittedJobVia(h, provider);
        _rule(last, true);
        assertEq(uint256(escrow.getJob(last).status), uint256(AgenticCommerce.JobStatus.Completed));
    }

    function test_constructor_refusesAddressesWithoutCode() public {
        address empty = makeAddr("noCode");
        vm.expectRevert(JudgeReputationHookV2.NoCode.selector);
        new JudgeReputationHookV2(empty, address(judge), address(identity), address(reputation));
        vm.expectRevert(JudgeReputationHookV2.NoCode.selector);
        new JudgeReputationHookV2(address(escrow), empty, address(identity), address(reputation));
        vm.expectRevert(JudgeReputationHookV2.NoCode.selector);
        new JudgeReputationHookV2(address(escrow), address(judge), empty, address(reputation));
        vm.expectRevert(JudgeReputationHookV2.NoCode.selector);
        new JudgeReputationHookV2(address(escrow), address(judge), address(identity), empty);
    }

    /*//////////////////////////////////////////////////////////////
          NO GAS LIMIT CAN SETTLE OR FUND A JOB WITHOUT ITS RECORD
    //////////////////////////////////////////////////////////////*/

    /// Anyone may relay a verdict, including the provider it rejects. Whatever gas limit it picks, the relay either
    /// settles the job and counts the verdict, or does neither.
    function _sweepRelayGas(bool pass) internal {
        uint256 jobId = _submittedJob(provider, address(judge));
        JudgeEvaluator.Verdict memory v = _verdict(jobId, pass);
        bytes memory sig = _sign(v);
        uint256 settled;
        uint256 refused;
        for (uint256 g = 150_000; g <= 1_500_000; g += 5_000) {
            uint256 snap = vm.snapshotState();
            try judge.relay{gas: g}(v, sig) {
                settled++;
                assertEq(_written(providerAgent), 1, "settled without its record");
                (uint64 p, uint64 r, uint64 u) = _tally(hook, providerAgent);
                assertEq(p + r, 1, "settled without its count");
                assertEq(u, 0, "the registry write never runs short of gas");
            } catch {
                refused++;
                assertEq(
                    uint256(escrow.getJob(jobId).status),
                    uint256(AgenticCommerce.JobStatus.Submitted),
                    "a failed relay settles nothing"
                );
            }
            vm.revertToState(snap);
        }
        assertGt(settled, 0, "some gas limit settles");
        assertGt(refused, 0, "some gas limit is too low");
    }

    function test_relayGasCannotDodgeARejectRecord() public {
        _sweepRelayGas(false);
    }

    function test_relayGasCannotDenyAPassRecord() public {
        _sweepRelayGas(true);
    }

    /// Whatever gas limit the client funds with, a job for a linked provider is funded and attributed, or neither.
    function test_fundGasCannotSkipTheAttribution() public {
        uint256 jobId = _openJob(hook, provider, address(judge));
        uint256 funded;
        uint256 refused;
        for (uint256 g = 60_000; g <= 600_000; g += 2_000) {
            uint256 snap = vm.snapshotState();
            vm.prank(client);
            try escrow.fund{gas: g}(jobId, "") {
                funded++;
                (bool attributed,) = hook.jobAgent(jobId);
                assertTrue(attributed, "funded without attribution");
            } catch {
                refused++;
                assertEq(uint256(escrow.getJob(jobId).status), uint256(AgenticCommerce.JobStatus.Open));
            }
            vm.revertToState(snap);
        }
        assertGt(funded, 0, "some gas limit funds");
        assertGt(refused, 0, "some gas limit is too low");
    }

    function test_tooLittleGas_revertsAndTheVerdictCanBeRelayedAgain() public {
        uint256 jobId = _submittedJob(provider, address(judge));
        JudgeEvaluator.Verdict memory v = _verdict(jobId, false);
        bytes memory sig = _sign(v);
        // Enough for the judge and the escrow, not for the hook's registry call.
        try judge.relay{gas: 300_000}(v, sig) {
            revert("expected the relay to fail");
        } catch {}
        assertEq(uint256(escrow.getJob(jobId).status), uint256(AgenticCommerce.JobStatus.Submitted));
        judge.relay(v, sig);
        assertEq(_written(providerAgent), 1);
    }

    /*//////////////////////////////////////////////////////////////
                              PLUMBING
    //////////////////////////////////////////////////////////////*/

    function test_onlyTheEscrowCanCallTheHook() public {
        bytes memory data = abi.encode(address(judge), EVIDENCE, bytes(""));
        vm.prank(stranger);
        vm.expectRevert(JudgeReputationHookV2.OnlyACP.selector);
        hook.afterAction(1, IACP.complete.selector, data);
        vm.prank(stranger);
        vm.expectRevert(JudgeReputationHookV2.OnlyACP.selector);
        hook.beforeAction(1, IACP.complete.selector, data);
        vm.prank(stranger);
        vm.expectRevert(JudgeReputationHookV2.OnlyACP.selector);
        hook.afterAction(1, IACP.fund.selector, abi.encode(client, bytes("")));
    }

    function test_forgedCallFromAnotherContract_isRefused() public {
        // Something other than the escrow cannot plant feedback by claiming the judge as caller.
        bytes memory data = abi.encode(address(judge), EVIDENCE, bytes(""));
        vm.prank(address(judge));
        vm.expectRevert(JudgeReputationHookV2.OnlyACP.selector);
        hook.afterAction(1, IACP.complete.selector, data);
    }

    function test_malformedHookData_isIgnored() public {
        // The escrow always encodes (caller, reason, optParams); anything shorter must not revert the settlement.
        vm.prank(address(escrow));
        hook.afterAction(1, IACP.complete.selector, hex"00");
        vm.prank(address(escrow));
        hook.afterAction(1, IACP.reject.selector, abi.encode(address(judge)));
    }

    function test_supportsTheHookInterface() public view {
        assertTrue(hook.supportsInterface(type(IACPHook).interfaceId));
        assertTrue(hook.supportsInterface(type(IERC165).interfaceId));
        assertFalse(hook.supportsInterface(0xdeadbeef));
    }

    function test_constructor_refusesZeroAddresses() public {
        vm.expectRevert(JudgeReputationHookV2.ZeroAddress.selector);
        new JudgeReputationHookV2(address(0), address(judge), address(identity), address(reputation));
        vm.expectRevert(JudgeReputationHookV2.ZeroAddress.selector);
        new JudgeReputationHookV2(address(escrow), address(0), address(identity), address(reputation));
        vm.expectRevert(JudgeReputationHookV2.ZeroAddress.selector);
        new JudgeReputationHookV2(address(escrow), address(judge), address(0), address(reputation));
        vm.expectRevert(JudgeReputationHookV2.ZeroAddress.selector);
        new JudgeReputationHookV2(address(escrow), address(judge), address(identity), address(0));
    }

    function test_hasNoOwnerOrAdmin() public view {
        // Nothing to call: no owner, no setters. The addresses are immutable.
        assertEq(address(hook.acp()), address(escrow));
        assertEq(hook.judge(), address(judge));
        assertEq(address(hook.identity()), address(identity));
        assertEq(address(hook.reputation()), address(reputation));
    }
}
