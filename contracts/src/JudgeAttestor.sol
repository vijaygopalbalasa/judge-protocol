// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @notice The two JudgeEvaluator views the attestor relies on.
interface IJudgeSigners {
    function isSigner(address signer) external view returns (bool);
    function paused() external view returns (bool);
}

/// @notice ERC-8412 registry, attestation side (§6).
interface IERC8412Attest {
    function attestOutcome(
        bytes32 preregistrationId,
        bytes32 bundleDigest,
        bytes32 attestationDigest,
        uint8 verdict,
        bytes calldata obligationOutcomes
    ) external;
}

/// @title JudgeAttestor
/// @notice The ERC-8412 verifier for Judge Protocol rulings. A client names
///         this contract as the verifier when it preregisters a job's criteria
///         on the ERC-8412 registry. The contract records an attestation only
///         when a key JudgeEvaluator trusts has signed it (EIP-712), so anyone
///         can relay it, the verifier outlives signer rotation, and the judge's
///         guardian pause stops attestations as well as verdicts.
contract JudgeAttestor is EIP712 {
    using ECDSA for bytes32;

    /// @notice JudgeEvaluator: the signer allowlist and the pause switch.
    IJudgeSigners public immutable judge;

    /// @notice The ERC-8412 registry this contract attests on.
    IERC8412Attest public immutable registry;

    bytes32 private constant ATTESTATION_TYPEHASH = keccak256(
        "Attestation(bytes32 preregistrationId,bytes32 bundleDigest,bytes32 attestationDigest,uint8 verdict,bytes obligationOutcomes)"
    );

    event Attested(bytes32 indexed preregistrationId, address indexed signer);

    error ZeroAddress();
    error Paused_();
    error BadSignature();

    constructor(address judge_, address registry_) EIP712("JudgeAttestor", "1") {
        if (judge_ == address(0) || registry_ == address(0)) revert ZeroAddress();
        judge = IJudgeSigners(judge_);
        registry = IERC8412Attest(registry_);
    }

    /// @notice Record a judge-signed attestation. The registry enforces the
    ///         ERC-8412 invariants (one attestation per preregistration, the
    ///         verifier named at preregistration, E4/E11 and the rest).
    function attest(
        bytes32 preregistrationId,
        bytes32 bundleDigest,
        bytes32 attestationDigest,
        uint8 verdict,
        bytes calldata obligationOutcomes,
        bytes calldata sig
    ) external {
        if (judge.paused()) revert Paused_();
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    ATTESTATION_TYPEHASH,
                    preregistrationId,
                    bundleDigest,
                    attestationDigest,
                    verdict,
                    keccak256(obligationOutcomes)
                )
            )
        );
        address signer = digest.recover(sig);
        if (!judge.isSigner(signer)) revert BadSignature();
        registry.attestOutcome(preregistrationId, bundleDigest, attestationDigest, verdict, obligationOutcomes);
        emit Attested(preregistrationId, signer);
    }

    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
