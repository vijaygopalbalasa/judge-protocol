// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/JudgeEvaluator.sol";
import "../src/JudgeAttestor.sol";
import "../src/mocks/MockACP.sol";
import "../src/mocks/MockUSDC.sol";
import {PreregisteredCriteria, IPreregisteredCriteria} from "./vendor/erc8412/PreregisteredCriteria.sol";

/// JudgeAttestor against the real JudgeEvaluator (signer allowlist, guardian
/// pause) and the ERC-8412 reference registry, vendored unchanged.
contract JudgeAttestorTest is Test {
    JudgeEvaluator judge;
    PreregisteredCriteria registry;
    JudgeAttestor attestor;

    address guardian = makeAddr("guardian");
    uint256 signerKey = 0xA11CE;
    address signer = vm.addr(signerKey);
    address client = makeAddr("client");
    address anyone = makeAddr("anyone");

    bytes32 constant CRITERIA_DIGEST = keccak256("criteria document");
    bytes32 constant TASK = keccak256("an ERC-8183 job");
    bytes32 constant BUNDLE = keccak256("evidence bundle");
    bytes32 constant ATTESTATION = keccak256("attestation document");
    bytes32 constant TYPEHASH = keccak256(
        "Attestation(bytes32 preregistrationId,bytes32 bundleDigest,bytes32 attestationDigest,uint8 verdict,bytes obligationOutcomes)"
    );
    uint8 constant SATISFIED = 1;
    uint8 constant NOT_SATISFIED = 2;
    bytes constant BOTH_MET = hex"50";   // MET, MET
    bytes constant SECOND_UNMET = hex"40"; // MET, UNMET

    function setUp() public {
        MockUSDC usdc = new MockUSDC();
        MockACP acp = new MockACP(address(usdc));
        address[] memory signers = new address[](1);
        signers[0] = signer;
        judge = new JudgeEvaluator(address(acp), guardian, signers);
        registry = new PreregisteredCriteria();
        attestor = new JudgeAttestor(address(judge), address(registry));
        vm.warp(1_790_000_000);
    }

    /// Two required, non-waivable obligations (flags 01 01).
    function _preregister(address verifier) internal returns (bytes32 id) {
        vm.prank(client);
        id = registry.preregister(CRITERIA_DIGEST, TASK, 2, hex"50", uint64(block.timestamp + 1 days), verifier, bytes32(0));
    }

    function _sign(uint256 key, bytes32 id, uint8 verdict, bytes memory outcomes) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(TYPEHASH, id, BUNDLE, ATTESTATION, verdict, keccak256(outcomes)));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", attestor.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_anyoneRelaysAJudgeSignedAttestation() public {
        bytes32 id = _preregister(address(attestor));
        bytes memory sig = _sign(signerKey, id, SATISFIED, BOTH_MET);
        vm.expectEmit(true, true, false, false, address(attestor));
        emit JudgeAttestor.Attested(id, signer);
        vm.prank(anyone);
        attestor.attest(id, BUNDLE, ATTESTATION, SATISFIED, BOTH_MET, sig);
        (address verifier, bytes32 bundle, bytes32 att, IPreregisteredCriteria.Verdict verdict, bytes memory outcomes,) =
            registry.getAttestation(id);
        assertEq(verifier, address(attestor));
        assertEq(bundle, BUNDLE);
        assertEq(att, ATTESTATION);
        assertEq(uint8(verdict), SATISFIED);
        assertEq(outcomes, BOTH_MET);
    }

    function test_aFailedVerdictIsRecordedToo() public {
        bytes32 id = _preregister(address(attestor));
        attestor.attest(id, BUNDLE, ATTESTATION, NOT_SATISFIED, SECOND_UNMET, _sign(signerKey, id, NOT_SATISFIED, SECOND_UNMET));
        (,,, IPreregisteredCriteria.Verdict verdict, bytes memory outcomes,) = registry.getAttestation(id);
        assertEq(uint8(verdict), NOT_SATISFIED);
        assertEq(outcomes, SECOND_UNMET);
    }

    function test_aKeyTheJudgeDoesNotTrustCannotAttest() public {
        bytes32 id = _preregister(address(attestor));
        bytes memory sig = _sign(0xBAD, id, SATISFIED, BOTH_MET);
        vm.expectRevert(JudgeAttestor.BadSignature.selector);
        attestor.attest(id, BUNDLE, ATTESTATION, SATISFIED, BOTH_MET, sig);
    }

    function test_theSignatureCoversEveryField() public {
        bytes32 id = _preregister(address(attestor));
        vm.warp(block.timestamp + 1);
        bytes32 other = _preregisterTask(keccak256("another ERC-8183 job"));
        bytes memory sig = _sign(signerKey, id, NOT_SATISFIED, SECOND_UNMET); // what the judge signed
        // A relayer changes one field at a time; each change breaks the signature.
        vm.expectRevert(JudgeAttestor.BadSignature.selector);
        attestor.attest(other, BUNDLE, ATTESTATION, NOT_SATISFIED, SECOND_UNMET, sig);
        vm.expectRevert(JudgeAttestor.BadSignature.selector);
        attestor.attest(id, keccak256("another bundle"), ATTESTATION, NOT_SATISFIED, SECOND_UNMET, sig);
        vm.expectRevert(JudgeAttestor.BadSignature.selector);
        attestor.attest(id, BUNDLE, keccak256("another attestation"), NOT_SATISFIED, SECOND_UNMET, sig);
        vm.expectRevert(JudgeAttestor.BadSignature.selector);
        attestor.attest(id, BUNDLE, ATTESTATION, SATISFIED, SECOND_UNMET, sig);
        vm.expectRevert(JudgeAttestor.BadSignature.selector);
        attestor.attest(id, BUNDLE, ATTESTATION, NOT_SATISFIED, hex"10", sig); // UNMET, MET: the registry would accept it
        attestor.attest(id, BUNDLE, ATTESTATION, NOT_SATISFIED, SECOND_UNMET, sig); // the signed fields go through
    }

    function _preregisterTask(bytes32 task) internal returns (bytes32 id) {
        vm.prank(client);
        id = registry.preregister(CRITERIA_DIGEST, task, 2, hex"50", uint64(block.timestamp + 1 days), address(attestor), bytes32(0));
    }

    function test_aRevokedSignerCannotAttest() public {
        bytes32 id = _preregister(address(attestor));
        judge.setSigner(signer, false);
        bytes memory sig = _sign(signerKey, id, SATISFIED, BOTH_MET);
        vm.expectRevert(JudgeAttestor.BadSignature.selector);
        attestor.attest(id, BUNDLE, ATTESTATION, SATISFIED, BOTH_MET, sig);
    }

    function test_theGuardianPauseStopsAttestations() public {
        bytes32 id = _preregister(address(attestor));
        bytes memory sig = _sign(signerKey, id, SATISFIED, BOTH_MET);
        vm.prank(guardian);
        judge.setPaused(true);
        vm.expectRevert(JudgeAttestor.Paused_.selector);
        attestor.attest(id, BUNDLE, ATTESTATION, SATISFIED, BOTH_MET, sig);
    }

    function test_oneAttestationPerPreregistration() public {
        bytes32 id = _preregister(address(attestor));
        bytes memory sig = _sign(signerKey, id, SATISFIED, BOTH_MET);
        attestor.attest(id, BUNDLE, ATTESTATION, SATISFIED, BOTH_MET, sig);
        vm.expectRevert(); // the registry's E3: one attestation, ever
        attestor.attest(id, BUNDLE, ATTESTATION, SATISFIED, BOTH_MET, sig);
    }

    function test_onlyPreregistrationsThatNameThisContract() public {
        bytes32 id = _preregister(makeAddr("another verifier"));
        bytes memory sig = _sign(signerKey, id, SATISFIED, BOTH_MET);
        vm.expectRevert(); // the registry's E3: msg.sender must be the verifier named at preregistration
        attestor.attest(id, BUNDLE, ATTESTATION, SATISFIED, BOTH_MET, sig);
    }

    function test_aSignedPassOverAnUnmetRequiredObligationIsStillRefused() public {
        bytes32 id = _preregister(address(attestor));
        bytes memory sig = _sign(signerKey, id, SATISFIED, SECOND_UNMET);
        vm.expectRevert(); // the registry's E4, even for a validly signed attestation
        attestor.attest(id, BUNDLE, ATTESTATION, SATISFIED, SECOND_UNMET, sig);
    }

    function test_rejectsZeroAddresses() public {
        vm.expectRevert(JudgeAttestor.ZeroAddress.selector);
        new JudgeAttestor(address(0), address(registry));
        vm.expectRevert(JudgeAttestor.ZeroAddress.selector);
        new JudgeAttestor(address(judge), address(0));
    }
}
