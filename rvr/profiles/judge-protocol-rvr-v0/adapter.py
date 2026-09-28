#!/usr/bin/env python3
"""Independent gate for the ERC-8404 (RVR) profile judge-protocol-rvr-v0.

The pinned contracts are authority. This standard-library-only adapter does not
import or call the Judge Protocol service: it re-derives Judge verdicts from the
pinned evidence closure under the checker contract in SPEC.md.

Changed from the reference profile adapters in Pavlo Tvardovskyi's
pipavlo82/recomputable-verification-receipts (commit 287c0ea, Apache License
2.0, see rvr/LICENSE-rvr-core-Apache-2.0): the canonical JSON, schema subset,
pinned dependency loading and recomputation scaffolding follow those adapters,
with changes. The Judge-specific derivation was written for this profile.
"""
from __future__ import annotations

import argparse
import base64
import copy
import hashlib
import json
import math
import re
import sys
import unicodedata
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
PACKAGE = ROOT / "profiles/judge-protocol-rvr-v0"
PROFILE_PATH = PACKAGE / "verification-profile.json"
MANIFEST_PATH = PACKAGE / "manifest.json"
GENERIC_PROFILE_SCHEMA = ROOT / "conformance/rvr-v0/verification-profile-manifest.schema.json"
RVR_SCHEMA_PATH = PACKAGE / "rvr.schema.json"

PROFILE_ID = "judge-protocol-rvr-v0"
PROPOSITION = "rvr.judge-protocol.v0.deliverable_meets_criteria"
CHAIN_ID = "5042002"
ACP = "0x0747eef0706327138c69792bf28cd525089e4583"
JUDGE_EVALUATOR = "0x6eff7d4bb514d341abed90bf4c667d0a980173ad"
CHECKER_CONTRACT = "judge-protocol-checkers-v1"
JUDGE_BYTE_CONTRACT = "judge-protocol-sorted-json-v1"
CHAIN_SEMANTICS = "SNAPSHOT_BOUND_CANONICALITY_NOT_ESTABLISHED"
TIMESTAMP_SEMANTICS = "RECORDED_NOT_REDERIVED"
PROCEDURE = "JUDGE_PROTOCOL_CHECKER_DERIVATION_V0"
SNAPSHOT_MEMBER = "chain-snapshot"
DELIVERABLE_MEMBER = "deliverable"
MAX_DELIVERABLE_BYTES = 1_000_000
MAX_DELIVERABLE_JSON_DEPTH = 512
MAX_SAFE_INTEGER = 9007199254740991

REASON = {
    "meets": "rvr.judge-protocol.v0.score_meets_threshold",
    "below": "rvr.judge-protocol.v0.score_below_threshold",
    "no_snapshot": "rvr.judge-protocol.v0.required_chain_snapshot_unavailable",
    "no_deliverable": "rvr.judge-protocol.v0.required_deliverable_unavailable",
}
GATE = {
    "schema": "rvr.gate.schema_invalid",
    "identity": "rvr.gate.identity_mismatch",
    "projection": "rvr.gate.result_projection_mismatch",
    "closure": "rvr.gate.evidence_closure_incomplete",
    "snapshot_invalid": "rvr.judge-protocol.v0.gate.snapshot_invalid",
    "snapshot_not_canonical": "rvr.judge-protocol.v0.gate.snapshot_not_canonical",
    "snapshot_claim": "rvr.judge-protocol.v0.gate.snapshot_claim_mismatch",
    "evaluator": "rvr.judge-protocol.v0.gate.evaluator_not_judge",
    "commitment": "rvr.judge-protocol.v0.gate.commitment_mismatch",
    "criteria_missing": "rvr.judge-protocol.v0.gate.criteria_missing",
    "criteria_invalid": "rvr.judge-protocol.v0.gate.criteria_invalid",
    "criteria_scope": "rvr.judge-protocol.v0.gate.criteria_out_of_scope",
    "criteria_hash": "rvr.judge-protocol.v0.gate.criteria_hash_mismatch",
    "not_utf8": "rvr.judge-protocol.v0.gate.deliverable_not_utf8",
    "resource": "rvr.judge-protocol.v0.gate.resource_limit",
}
RECOMPUTE = {
    "identical": "rvr.recompute.identical",
    "diverged": "rvr.recompute.canonical_result_diverged",
    "dependency_unavailable": "rvr.recompute.normative_dependency_unavailable",
    "dependency_pin": "rvr.recompute.normative_dependency_pin_mismatch",
    "evidence_unavailable": "rvr.recompute.committed_evidence_unavailable",
}

PACKAGE_MEMBERS = (
    "conformance/rvr-v0/verification-profile-manifest.schema.json",
    "profiles/judge-protocol-rvr-v0/README.md",
    "profiles/judge-protocol-rvr-v0/SPEC.md",
    "profiles/judge-protocol-rvr-v0/adapter.py",
    "profiles/judge-protocol-rvr-v0/expected.json",
    "profiles/judge-protocol-rvr-v0/profile.schema.json",
    "profiles/judge-protocol-rvr-v0/rvr.schema.json",
    "profiles/judge-protocol-rvr-v0/test_profile.py",
    "profiles/judge-protocol-rvr-v0/upstream/job-186779.deliverable.bin",
    "profiles/judge-protocol-rvr-v0/upstream/job-186779.snapshot.json",
    "profiles/judge-protocol-rvr-v0/upstream/job-186780.deliverable.bin",
    "profiles/judge-protocol-rvr-v0/upstream/job-186780.snapshot.json",
    "profiles/judge-protocol-rvr-v0/vectors.json",
    "profiles/judge-protocol-rvr-v0/verification-profile.json",
)


class ProfileError(Exception):
    pass


class SchemaError(ProfileError):
    pass


class GateRejected(ProfileError):
    def __init__(self, reason_code: str, message: str) -> None:
        super().__init__(f"{reason_code}: {message}")
        self.reason_code = reason_code


class CannotRecompute(ProfileError):
    def __init__(self, reason_code: str, message: str) -> None:
        super().__init__(f"{reason_code}: {message}")
        self.reason_code = reason_code


# --------------------------------------------------------------------------- hashing

def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


_KECCAK_RC = (
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
    0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
    0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
    0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
    0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
)
_KECCAK_ROT = ((0, 36, 3, 41, 18), (1, 44, 10, 45, 2), (62, 6, 43, 15, 61), (28, 55, 25, 21, 56), (27, 20, 39, 8, 14))
_MASK64 = (1 << 64) - 1


def _rol(value: int, shift: int) -> int:
    return ((value << shift) | (value >> (64 - shift))) & _MASK64 if shift else value


def _keccak_f(state: list[list[int]]) -> list[list[int]]:
    for round_constant in _KECCAK_RC:
        c = [state[x][0] ^ state[x][1] ^ state[x][2] ^ state[x][3] ^ state[x][4] for x in range(5)]
        d = [c[(x - 1) % 5] ^ _rol(c[(x + 1) % 5], 1) for x in range(5)]
        state = [[state[x][y] ^ d[x] for y in range(5)] for x in range(5)]
        b = [[0] * 5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                b[y][(2 * x + 3 * y) % 5] = _rol(state[x][y], _KECCAK_ROT[x][y])
        state = [[b[x][y] ^ ((~b[(x + 1) % 5][y]) & b[(x + 2) % 5][y]) for y in range(5)] for x in range(5)]
        state[0][0] ^= round_constant
    return state


def keccak256(data: bytes) -> str:
    """Ethereum keccak256 (Keccak-f[1600], rate 136, pad 0x01..0x80), lowercase 0x-hex."""
    rate = 136
    padded = bytearray(data)
    padded.append(0x01)
    while len(padded) % rate:
        padded.append(0)
    padded[-1] |= 0x80
    state = [[0] * 5 for _ in range(5)]
    for offset in range(0, len(padded), rate):
        block = padded[offset:offset + rate]
        for i in range(rate // 8):
            state[i % 5][i // 5] ^= int.from_bytes(block[8 * i:8 * i + 8], "little")
        state = _keccak_f(state)
    digest = b"".join(state[i % 5][i // 5].to_bytes(8, "little") for i in range(4))
    return "0x" + digest.hex()


# ------------------------------------------------------ strict JSON and rvr-canonical-json-v0

def reject_constant(value: str) -> Any:
    raise ProfileError(f"non-standard JSON constant: {value}")


def reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ProfileError(f"duplicate JSON member: {key}")
        result[key] = value
    return result


def has_surrogate(value: Any) -> bool:
    if isinstance(value, str):
        return any(0xD800 <= ord(character) <= 0xDFFF for character in value)
    if isinstance(value, list):
        return any(has_surrogate(item) for item in value)
    if isinstance(value, dict):
        return any(has_surrogate(key) or has_surrogate(item) for key, item in value.items())
    return False


def parse_json(data: bytes, label: str) -> Any:
    try:
        value = json.loads(data.decode("utf-8"), object_pairs_hook=reject_duplicates, parse_constant=reject_constant)
    except (UnicodeError, json.JSONDecodeError, RecursionError) as error:
        raise ProfileError(f"invalid JSON in {label}: {error}") from error
    if has_surrogate(value):
        raise ProfileError(f"{label} contains a surrogate code point")
    return value


def load_json(path: Path) -> Any:
    try:
        return parse_json(path.read_bytes(), str(path))
    except OSError as error:
        raise ProfileError(f"cannot read {path}: {error}") from error


_SHORT_ESCAPES = {0x08: "\\b", 0x09: "\\t", 0x0A: "\\n", 0x0C: "\\f", 0x0D: "\\r", 0x22: '\\"', 0x5C: "\\\\"}


def json_string(value: str) -> str:
    """rvr-json-string-escaping-v0, which is also ECMAScript QuoteJSONString for scalar-value strings."""
    output = ['"']
    for character in value:
        code = ord(character)
        if 0xD800 <= code <= 0xDFFF:
            raise ProfileError("strings must be Unicode scalar values")
        if code in _SHORT_ESCAPES:
            output.append(_SHORT_ESCAPES[code])
        elif code <= 0x1F:
            output.append(f"\\u{code:04x}")
        else:
            output.append(character)
    output.append('"')
    return "".join(output)


def canonical_json(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return json_string(value)
    if isinstance(value, (int, float)):
        raise ProfileError("rvr-canonical-json-v0 forbids numbers")
    if isinstance(value, list):
        return "[" + ",".join(canonical_json(item) for item in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value, key=lambda key: tuple(ord(character) for character in key))
        return "{" + ",".join(json_string(key) + ":" + canonical_json(value[key]) for key in keys) + "}"
    raise ProfileError(f"unsupported canonical value: {type(value).__name__}")


def canonical_bytes(value: Any) -> bytes:
    return canonical_json(value).encode("utf-8")


def canonical_digest(value: Any) -> str:
    return sha256(canonical_bytes(value))


# ------------------------------------------------------------- JSON Schema subset validator

def resolve_pointer(root: dict[str, Any], reference: str) -> dict[str, Any]:
    if reference == "#":
        return root
    if not reference.startswith("#/"):
        raise SchemaError(f"unsupported schema reference: {reference}")
    value: Any = root
    for token in reference[2:].split("/"):
        token = token.replace("~1", "/").replace("~0", "~")
        if not isinstance(value, dict) or token not in value:
            raise SchemaError(f"unresolved schema reference: {reference}")
        value = value[token]
    if not isinstance(value, dict):
        raise SchemaError(f"schema reference is not an object: {reference}")
    return value


def schema_type_matches(value: Any, expected: str) -> bool:
    return {
        "object": isinstance(value, dict),
        "array": isinstance(value, list),
        "string": isinstance(value, str),
        "boolean": isinstance(value, bool),
        "null": value is None,
        "integer": isinstance(value, int) and not isinstance(value, bool),
    }.get(expected, False)


def validate_schema(value: Any, schema: dict[str, Any], root: dict[str, Any], at: str = "$") -> None:
    if "$ref" in schema:
        validate_schema(value, resolve_pointer(root, schema["$ref"]), root, at)
        return
    if "oneOf" in schema:
        matches = 0
        for candidate in schema["oneOf"]:
            try:
                validate_schema(value, candidate, root, at)
                matches += 1
            except SchemaError:
                pass
        if matches != 1:
            raise SchemaError(f"{at}: oneOf matched {matches} branches")
    if "const" in schema and value != schema["const"]:
        raise SchemaError(f"{at}: const mismatch")
    if "enum" in schema and value not in schema["enum"]:
        raise SchemaError(f"{at}: value not in enum")
    expected_type = schema.get("type")
    if expected_type is not None and not schema_type_matches(value, expected_type):
        raise SchemaError(f"{at}: expected {expected_type}")
    if isinstance(value, str) and "pattern" in schema:
        if re.fullmatch(schema["pattern"], value) is None:
            raise SchemaError(f"{at}: pattern mismatch")
    if isinstance(value, list):
        if len(value) < schema.get("minItems", 0):
            raise SchemaError(f"{at}: too few items")
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            raise SchemaError(f"{at}: too many items")
        if "items" in schema:
            for index, item in enumerate(value):
                validate_schema(item, schema["items"], root, f"{at}[{index}]")
    if isinstance(value, dict):
        properties = schema.get("properties", {})
        for required in schema.get("required", []):
            if required not in value:
                raise SchemaError(f"{at}: missing {required}")
        if schema.get("additionalProperties") is False:
            extra = set(value) - set(properties)
            if extra:
                raise SchemaError(f"{at}: additional properties {sorted(extra)}")
        for key, child in value.items():
            if key in properties:
                validate_schema(child, properties[key], root, f"{at}.{key}")


def validate_at(value: Any, rvr_schema: dict[str, Any], pointer: str, reason_code: str) -> None:
    try:
        validate_schema(value, resolve_pointer(rvr_schema, pointer), rvr_schema)
    except SchemaError as error:
        raise GateRejected(reason_code, str(error)) from error


# ------------------------------------------------------ profile package and dependencies

def dependency_rows(members: list[dict[str, Any]]) -> bytes:
    rows = [f"{member['path']}\t{member['sha256']}\n" for member in members]
    return "".join(sorted(rows)).encode("utf-8")


def profile_dependencies(profile: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        profile["profileSchemaContract"]["manifest"],
        profile["profileSchemaContract"]["constraints"],
        profile["verificationSpecification"],
        *profile["conformanceVectorSet"]["members"],
        *profile["schemaContracts"],
    ]


def safe_dependency_path(raw: str) -> Path:
    if "\\" in raw or ":" in raw or raw.startswith("/"):
        raise ProfileError(f"invalid dependency path: {raw}")
    segments = raw.split("/")
    if any(segment in ("", ".", "..") for segment in segments):
        raise ProfileError(f"invalid dependency path: {raw}")
    path = (ROOT / Path(*segments)).resolve()
    try:
        path.relative_to(ROOT.resolve())
    except ValueError as error:
        raise ProfileError(f"dependency escapes package root: {raw}") from error
    return path


def load_profile(overrides: dict[str, bytes] | None = None, missing: tuple[str, ...] = ()) -> dict[str, Any]:
    """Resolve the supplied profile package: resolve, read once, hash, then parse or use.

    Only dependencies marked requiredForRecomputation are resolved; conformance
    material marked false is never read here, so it cannot influence recomputation.
    """
    generic_schema = load_json(GENERIC_PROFILE_SCHEMA)
    profile = load_json(PROFILE_PATH)
    validate_schema(profile, generic_schema, generic_schema)
    override_map = overrides or {}
    pinned: dict[str, bytes] = {}
    for dependency in profile_dependencies(profile):
        if not dependency["requiredForRecomputation"]:
            continue
        if dependency["id"] in missing:
            raise CannotRecompute(RECOMPUTE["dependency_unavailable"], f"required dependency unavailable: {dependency['id']}")
        data = override_map.get(dependency["id"])
        if data is None:
            try:
                data = safe_dependency_path(dependency["path"]).read_bytes()
            except OSError as error:
                raise CannotRecompute(RECOMPUTE["dependency_unavailable"], f"cannot read {dependency['path']}") from error
        if sha256(data) != dependency["sha256"]:
            raise CannotRecompute(RECOMPUTE["dependency_pin"], f"dependency failed its pin before use: {dependency['id']}")
        pinned[dependency["id"]] = data
    manifest_schema = parse_json(pinned["verification-profile-manifest-schema"], "pinned manifest schema")
    if manifest_schema != generic_schema:
        raise ProfileError("the profile's generic-schema pin is not the bootstrap schema")
    constraints = parse_json(pinned["judge-protocol-rvr-v0-profile-schema"], "pinned profile constraints")
    validate_schema(profile, constraints, constraints)
    rvr_schema = parse_json(pinned["rvr-schema"], "pinned RVR schema")
    return {"profile": profile, "digest": canonical_digest(profile), "rvrSchema": rvr_schema, "pinned": pinned}


# ------------------------------------------------ judge-protocol-sorted-json-v1 (keccak preimages)

_ARRAY_INDEX = re.compile(r"0|[1-9][0-9]*")


def is_array_index(key: str) -> bool:
    return _ARRAY_INDEX.fullmatch(key) is not None and int(key) < 4294967295


def utf16_order(key: str) -> bytes:
    return key.encode("utf-16-be")


def judge_json(value: Any) -> str:
    """ECMAScript JSON.stringify of the value rebuilt with keys inserted in UTF-16 order.

    ECMAScript emits array-index keys first in ascending numeric order, then the
    remaining keys in insertion (here UTF-16 code-unit) order. v0 values hold
    safe integers only, so numbers print as plain decimal digits.
    """
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        if abs(value) > MAX_SAFE_INTEGER:
            raise ProfileError("judge-protocol-sorted-json-v1 carries safe integers only in v0")
        return str(value)
    if isinstance(value, float):
        raise ProfileError("judge-protocol-sorted-json-v1 carries integers only in v0")
    if isinstance(value, str):
        return json_string(value)
    if isinstance(value, list):
        return "[" + ",".join(judge_json(item) for item in value) + "]"
    if isinstance(value, dict):
        indices = sorted((key for key in value if is_array_index(key)), key=int)
        others = sorted((key for key in value if not is_array_index(key)), key=utf16_order)
        return "{" + ",".join(json_string(key) + ":" + judge_json(value[key]) for key in indices + others) + "}"
    raise ProfileError(f"unsupported judge JSON value: {type(value).__name__}")


def criteria_hash(criteria: dict[str, Any]) -> str:
    return keccak256(judge_json(criteria).encode("utf-8"))


# -------------------------------------------------------- judge-protocol-checkers-v1

# ECMAScript WhiteSpace and LineTerminator: the sets of \s and String.prototype.trim.
JS_WHITESPACE = frozenset(
    "\u0009\u000a\u000b\u000c\u000d            "
    "      　﻿"
)
CHECK_FIELDS = ("kind", "params", "weight")
PARAM_NAMES = {
    "length": ("min", "max", "unit"),
    "contains": ("all", "wholeWords"),
    "schema": ("required", "types"),
    "checksum": ("sha256",),
    "http-endpoint": ("url", "expectStatus", "bodyIncludes", "timeoutMs"),
}
KNOWN_KINDS = ("checksum", "schema", "contains", "length", "http-endpoint")
IN_SCOPE_KINDS = ("checksum", "schema", "contains", "length")
LIMITS = {"checks": 64, "probes": 4, "depth": 12, "terms": 256, "termChars": 1024, "urlChars": 2048, "probeTimeoutMs": 10000, "weight": 1000}
TYPE_NAMES = ("string", "number", "boolean", "object")


def utf16_length(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def extract_criteria_text(description: str) -> str | None:
    """The capture of /```judge-criteria\\s*([\\s\\S]*?)```/ (ECMAScript), or None."""
    start = description.find("```judge-criteria")
    if start < 0:
        return None
    position = start + len("```judge-criteria")
    while position < len(description) and description[position] in JS_WHITESPACE:
        position += 1
    end = description.find("```", position)
    if end < 0:
        return None
    return description[position:end]


class OutOfScope(Exception):
    pass


def _js_number(literal: str) -> Any:
    value = float(literal)  # IEEE-754 double, correctly rounded, like ECMAScript
    if not math.isfinite(value) or not value.is_integer() or abs(value) > MAX_SAFE_INTEGER:
        raise OutOfScope(f"number {literal} is not a safe integer")
    return int(value)


def _js_int(literal: str) -> int:
    value = int(literal)
    if abs(value) > MAX_SAFE_INTEGER:
        raise OutOfScope(f"number {literal} is not a safe integer")
    return value


def parse_criteria(text: str) -> Any:
    """ECMAScript JSON.parse restricted to v0: numbers must be safe integers, strings scalar values."""
    value = json.loads(text, parse_float=_js_number, parse_int=_js_int, parse_constant=reject_constant)
    if has_surrogate(value):
        raise OutOfScope("criteria strings must be Unicode scalar values")
    return value


def nests_deeper_than(value: Any, limit: int) -> bool:
    stack = [(value, 1)]
    while stack:
        item, depth = stack.pop()
        if not isinstance(item, (dict, list)):
            continue
        if depth > limit:
            return True
        children = item.values() if isinstance(item, dict) else item
        stack.extend((child, depth + 1) for child in children)
    return False


def _has(value: Any) -> bool:
    return value is not None


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _is_string_list(value: Any) -> bool:
    return isinstance(value, list) and len(value) <= LIMITS["terms"] and all(
        isinstance(item, str) and utf16_length(item) <= LIMITS["termChars"] for item in value)


def params_problem(kind: str, params: dict[str, Any]) -> str | None:
    for key in params:
        if key not in PARAM_NAMES.get(kind, ()):
            return f"unknown param {key}"
    if kind == "length":
        for key in ("min", "max"):
            if _has(params.get(key)) and not (_is_number(params[key]) and params[key] >= 0):
                return f"{key} must be a number >= 0"
        if _has(params.get("min")) and _has(params.get("max")) and params["min"] > params["max"]:
            return "min must not be above max"
        if _has(params.get("unit")) and params["unit"] not in ("chars", "words"):
            return "unit must be chars or words"
    elif kind == "contains":
        if _has(params.get("all")) and not _is_string_list(params["all"]):
            return "all must be a list of strings"
        if _has(params.get("wholeWords")) and not isinstance(params["wholeWords"], bool):
            return "wholeWords must be true or false"
    elif kind == "schema":
        if _has(params.get("required")) and not _is_string_list(params["required"]):
            return "required must be a list of strings"
        if _has(params.get("types")):
            types = params["types"]
            if not isinstance(types, dict):
                return "types must be an object"
            if len(types) > LIMITS["terms"]:
                return "too many types"
            if any(type_name not in TYPE_NAMES for type_name in types.values()):
                return "types values must be string, number, boolean or object"
    elif kind == "checksum":
        if not isinstance(params.get("sha256"), str) or re.fullmatch(r"[0-9a-fA-F]{64}", params["sha256"]) is None:
            return "sha256 must be 64 hex characters"
    elif kind == "http-endpoint":
        if _has(params.get("url")) and not (isinstance(params["url"], str) and utf16_length(params["url"]) <= LIMITS["urlChars"]):
            return "url must be a short string"
        status = params.get("expectStatus")
        if _has(status) and not (isinstance(status, int) and not isinstance(status, bool) and 100 <= status <= 599):
            return "expectStatus must be an integer from 100 to 599"
        if _has(params.get("bodyIncludes")) and not _is_string_list(params["bodyIncludes"]):
            return "bodyIncludes must be a list of strings"
        timeout = params.get("timeoutMs")
        if _has(timeout) and not (_is_number(timeout) and 1 <= timeout <= LIMITS["probeTimeoutMs"]):
            return "timeoutMs out of range"
    return None


def validate_criteria(criteria: Any) -> str | None:
    """The Judge's validateCriteria; returns the problem or None."""
    if not isinstance(criteria, dict):
        return "criteria is not an object"
    if nests_deeper_than(criteria, LIMITS["depth"]):
        return "criteria nest too deep"
    checks = criteria.get("checks")
    if not isinstance(checks, list) or not checks:
        return "checks must be a non-empty array"
    if len(checks) > LIMITS["checks"]:
        return "too many checks"
    if "passThreshold" in criteria:
        threshold = criteria["passThreshold"]
        if not (isinstance(threshold, int) and not isinstance(threshold, bool) and 0 <= threshold <= 100):
            return "passThreshold must be an integer in [0,100]"
    for index, check in enumerate(checks):
        if not isinstance(check, dict):
            return f"checks[{index}] is not an object"
        extra = [key for key in check if key not in CHECK_FIELDS]
        if extra:
            return f"checks[{index}] unknown field {extra[0]}"
        if check.get("kind") not in KNOWN_KINDS:
            return f"checks[{index}] unknown kind"
        if "weight" in check:
            weight = check["weight"]
            if not (_is_number(weight) and 0 < weight <= LIMITS["weight"]):
                return f"checks[{index}] weight out of range"
        if _has(check.get("params")) and not isinstance(check["params"], dict):
            return f"checks[{index}].params must be an object"
        problem = params_problem(check["kind"], check.get("params") or {})
        if problem:
            return f"checks[{index}] ({check['kind']}): {problem}"
    if sum(1 for check in checks if check["kind"] == "http-endpoint") > LIMITS["probes"]:
        return "too many http-endpoint checks"
    return None


def is_word_character(character: str) -> bool:
    return character == "_" or unicodedata.category(character)[0] in ("L", "N")


def has_whole_word(text: str, term: str) -> bool:
    """Some occurrence of term has no letter, number or underscore on either side."""
    start = text.find(term)
    while start != -1:
        after = start + len(term)
        before_ok = start == 0 or not is_word_character(text[start - 1])
        after_ok = after == len(text) or not is_word_character(text[after])
        if before_ok and after_ok:
            return True
        start = text.find(term, start + 1)
    return False


def word_count(text: str) -> int:
    count, in_word = 0, False
    for character in text:
        if character in JS_WHITESPACE:
            in_word = False
        elif not in_word:
            count, in_word = count + 1, True
    return count


def json_depth(text: str) -> int:
    depth = deepest = 0
    in_string = escaped = False
    for character in text:
        if in_string:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
        elif character == '"':
            in_string = True
        elif character in "[{":
            depth += 1
            deepest = max(deepest, depth)
        elif character in "]}":
            depth -= 1
    return deepest


def js_typeof(value: Any) -> str:
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    return "object"  # objects, arrays and null


def run_check(check: dict[str, Any], content: bytes, text: str | None) -> bool:
    kind, params = check["kind"], check.get("params") or {}
    if kind == "checksum":
        return hashlib.sha256(content).hexdigest() == str(params["sha256"]).lower()
    assert text is not None
    if kind == "length":
        n = utf16_length(text) if params.get("unit") == "chars" else word_count(text)
        low = params.get("min") if _has(params.get("min")) else 0
        high = params.get("max") if _has(params.get("max")) else math.inf
        return low <= n <= high
    if kind == "contains":
        terms = params.get("all") if _has(params.get("all")) else []
        if params.get("wholeWords") is True:
            return all(has_whole_word(text, term) for term in terms)
        return all(term in text for term in terms)
    if kind == "schema":
        if json_depth(text) > MAX_DELIVERABLE_JSON_DEPTH:
            raise GateRejected(GATE["resource"], "deliverable JSON nests deeper than the profile limit")
        try:
            parsed = json.loads(text, parse_constant=reject_constant)
        except (json.JSONDecodeError, ProfileError, ValueError):
            return False
        if not isinstance(parsed, dict):
            return False
        required = params.get("required") if _has(params.get("required")) else []
        types = params.get("types") if _has(params.get("types")) else {}
        missing = [field for field in required if field not in parsed]
        wrong = [field for field, type_name in types.items() if field in parsed and js_typeof(parsed[field]) != type_name]
        return not missing and not wrong
    raise ProfileError(f"no checker for {kind}")


def js_round(value: float) -> int:
    whole = math.floor(value)
    return whole + 1 if value - whole >= 0.5 else whole


def score_of(results: list[dict[str, Any]], threshold: int) -> tuple[int, bool]:
    weight_sum = weight_pass = 0
    for item in results:
        weight_sum += item["weight"]
        if item["pass"]:
            weight_pass += item["weight"]
    rounded = 0 if weight_sum == 0 else js_round((weight_pass / weight_sum) * 100)
    score = rounded if all(item["pass"] for item in results) else min(rounded, 99)
    return score, score >= threshold


def criteria_from(description: str) -> dict[str, Any]:
    """Extract, parse, scope and validate the criteria (SPEC 5.2); gate rejections raise GateRejected."""
    text_block = extract_criteria_text(description)
    if text_block is None:
        raise GateRejected(GATE["criteria_missing"], "no judge-criteria block in the job description")
    try:
        criteria = parse_criteria(text_block)
    except OutOfScope as error:
        raise GateRejected(GATE["criteria_scope"], str(error)) from error
    except (json.JSONDecodeError, ProfileError, ValueError, RecursionError) as error:
        raise GateRejected(GATE["criteria_invalid"], f"criteria are not JSON: {error}") from error
    problem = validate_criteria(criteria)
    if problem:
        raise GateRejected(GATE["criteria_invalid"], problem)
    if any(check["kind"] not in IN_SCOPE_KINDS for check in criteria["checks"]):
        raise GateRejected(GATE["criteria_scope"], "http-endpoint is outside v0: a recorded probe is not a reproduced probe")
    return criteria


def derive_from(criteria: dict[str, Any], content: bytes, job_id: str, commitment: str) -> dict[str, Any]:
    """Run the checks, score and evidence core (SPEC 5.3 to 5.5) on validated criteria."""
    if len(content) > MAX_DELIVERABLE_BYTES:
        raise GateRejected(GATE["resource"], "deliverable is larger than the profile limit")
    text: str | None = None
    if any(check["kind"] != "checksum" for check in criteria["checks"]):
        try:
            text = content.decode("utf-8")
        except UnicodeDecodeError as error:
            raise GateRejected(GATE["not_utf8"], "text checks need a deliverable in valid UTF-8") from error
    results = []
    for check in criteria["checks"]:
        weight = check["weight"] if "weight" in check else 1
        results.append({"kind": check["kind"], "weight": weight, "pass": run_check(check, content, text)})
    threshold = criteria["passThreshold"] if "passThreshold" in criteria else 100
    score, passed = score_of(results, threshold)
    c_hash = criteria_hash(criteria)
    core = {
        "jobId": job_id,
        "criteriaHash": c_hash,
        "deliverable": commitment,
        "criteria": criteria,
        "checks": [{"kind": item["kind"], "pass": item["pass"], "weight": item["weight"]} for item in results],
        "score": score,
        "threshold": threshold,
        "pass": passed,
    }
    return {"criteria": criteria, "criteriaHash": c_hash, "results": results, "score": score, "threshold": threshold,
            "pass": passed, "evidenceHash": keccak256(judge_json(core).encode("utf-8"))}


def derive(description: str, content: bytes, job_id: str, commitment: str) -> dict[str, Any]:
    """criteria_from, then derive_from: one Judge ruling from a description and deliverable."""
    return derive_from(criteria_from(description), content, job_id, commitment)


# ----------------------------------------------------------------- claim, evidence, result

def claim_for(snapshot: dict[str, Any], c_hash: str) -> dict[str, Any]:
    return {
        "schema": "rvr.claim.judge-protocol.v0",
        "proposition": PROPOSITION,
        "chainId": snapshot["chainId"],
        "acp": snapshot["acp"],
        "evaluator": snapshot["evaluatorContract"],
        "jobId": snapshot["job"]["id"],
        "criteriaHash": c_hash,
        "deliverableCommitment": snapshot["submission"]["deliverable"],
        "snapshotMember": SNAPSHOT_MEMBER,
        "deliverableMember": DELIVERABLE_MEMBER,
        "checkerContract": CHECKER_CONTRACT,
        "judgeByteContract": JUDGE_BYTE_CONTRACT,
    }


def present_member(identifier: str, media_type: str, payload: bytes) -> dict[str, str]:
    return {"id": identifier, "status": "PRESENT", "mediaType": media_type, "byteLength": str(len(payload)), "digest": sha256(payload)}


def unavailable_member(identifier: str) -> dict[str, str]:
    return {"id": identifier, "status": "UNAVAILABLE", "reasonCode": "rvr.judge-protocol.v0.evidence_unavailable"}


def evidence_for(snapshot_bytes: bytes | None, deliverable: bytes | None) -> tuple[dict[str, Any], dict[str, bytes]]:
    payloads: dict[str, bytes] = {}
    members = []
    if snapshot_bytes is None:
        members.append(unavailable_member(SNAPSHOT_MEMBER))
    else:
        payloads[SNAPSHOT_MEMBER] = snapshot_bytes
        members.append(present_member(SNAPSHOT_MEMBER, "application/json; profile=rvr-canonical-json-v0", snapshot_bytes))
    if deliverable is None:
        members.append(unavailable_member(DELIVERABLE_MEMBER))
    else:
        payloads[DELIVERABLE_MEMBER] = deliverable
        members.append(present_member(DELIVERABLE_MEMBER, "application/octet-stream", deliverable))
    return {"schema": "rvr.evidence-set.v0", "members": sorted(members, key=lambda member: member["id"])}, payloads


def evidence_digest(evidence_set: dict[str, Any]) -> str:
    normalized = copy.deepcopy(evidence_set)
    normalized["members"] = sorted(normalized["members"], key=lambda member: tuple(ord(c) for c in member["id"]))
    return canonical_digest(normalized)


def validate_evidence(evidence_set: dict[str, Any], payloads: dict[str, bytes], rvr_schema: dict[str, Any], *, require_payloads: bool) -> None:
    validate_at(evidence_set, rvr_schema, "#/$defs/evidenceSet", GATE["schema"])
    identifiers = [member["id"] for member in evidence_set["members"]]
    if identifiers != [SNAPSHOT_MEMBER, DELIVERABLE_MEMBER]:
        raise GateRejected(GATE["closure"], "evidence member set or order mismatch")
    for member in evidence_set["members"]:
        payload = payloads.get(member["id"])
        if member["status"] == "UNAVAILABLE":
            if payload is not None:
                raise GateRejected(GATE["identity"], "unavailable member has a payload")
            continue
        if payload is None:
            if require_payloads:
                raise GateRejected(GATE["identity"], "present member payload unavailable")
            continue
        if member["byteLength"] != str(len(payload)) or member["digest"] != sha256(payload):
            raise GateRejected(GATE["identity"], "evidence payload identity mismatch")


def blank_evaluation(claim: dict[str, Any]) -> dict[str, Any]:
    return {
        "procedure": PROCEDURE,
        "checkerContract": CHECKER_CONTRACT,
        "judgeByteContract": JUDGE_BYTE_CONTRACT,
        "chainSemantics": CHAIN_SEMANTICS,
        "timestampSemantics": TIMESTAMP_SEMANTICS,
        "jobId": claim["jobId"],
        "snapshotBlock": None,
        "criteriaHash": None,
        "deliverableCommitment": None,
        "checks": [],
        "score": None,
        "threshold": None,
        "pass": None,
        "evidenceHash": None,
        "onChainVerdict": None,
        "verdictAgreement": "NOT_EVALUATED",
    }


def result(outcome: str, reason_code: str, evaluation: dict[str, Any]) -> dict[str, Any]:
    return {"schema": "rvr.canonical-result.judge-protocol.v0", "proposition": PROPOSITION,
            "outcome": outcome, "reasonCode": reason_code, "evaluation": evaluation}


def read_snapshot(payload: bytes, claim: dict[str, Any], rvr_schema: dict[str, Any]) -> dict[str, Any]:
    try:
        snapshot = parse_json(payload, "chain snapshot")
    except ProfileError as error:
        raise GateRejected(GATE["snapshot_invalid"], str(error)) from error
    validate_at(snapshot, rvr_schema, "#/$defs/chainSnapshot", GATE["snapshot_invalid"])
    if canonical_bytes(snapshot) != payload:
        raise GateRejected(GATE["snapshot_not_canonical"], "chain snapshot bytes are not rvr-canonical-json-v0")
    pinned = (snapshot["chainId"], snapshot["acp"], snapshot["evaluatorContract"]) == (CHAIN_ID, ACP, JUDGE_EVALUATOR)
    bound = (claim["chainId"], claim["acp"], claim["evaluator"], claim["jobId"]) == (
        snapshot["chainId"], snapshot["acp"], snapshot["evaluatorContract"], snapshot["job"]["id"])
    if not pinned or not bound:
        raise GateRejected(GATE["snapshot_claim"], "the snapshot is not this profile's deployment or not the claimed job")
    if snapshot["job"]["evaluator"] != JUDGE_EVALUATOR:
        raise GateRejected(GATE["evaluator"], "the job does not name JudgeEvaluator as its evaluator")
    if snapshot["submission"]["deliverable"] != claim["deliverableCommitment"]:
        raise GateRejected(GATE["commitment"], "the claim's commitment is not the provider's submitted commitment")
    return snapshot


def verdict_agreement(verdict: dict[str, Any] | None, claim: dict[str, Any], derived: dict[str, Any]) -> str:
    if verdict is None:
        return "NO_VERDICT"
    same = (
        verdict["jobId"] == claim["jobId"]
        and verdict["criteriaHash"] == derived["criteriaHash"]
        and verdict["deliverable"] == claim["deliverableCommitment"]
        and verdict["score"] == str(derived["score"])
        and verdict["threshold"] == str(derived["threshold"])
        and verdict["pass"] is derived["pass"]
        and verdict["evidenceHash"] == derived["evidenceHash"]
    )
    return "MATCHES" if same else "DIFFERS"


def evaluate(claim: dict[str, Any], evidence_set: dict[str, Any], payloads: dict[str, bytes], rvr_schema: dict[str, Any]) -> dict[str, Any]:
    validate_at(claim, rvr_schema, "#/$defs/claim", GATE["schema"])
    validate_evidence(evidence_set, payloads, rvr_schema, require_payloads=True)
    status = {member["id"]: member["status"] for member in evidence_set["members"]}
    evaluation = blank_evaluation(claim)
    if status[SNAPSHOT_MEMBER] == "UNAVAILABLE":
        return result("UNVERIFIABLE", REASON["no_snapshot"], evaluation)
    snapshot = read_snapshot(payloads[SNAPSHOT_MEMBER], claim, rvr_schema)
    evaluation["snapshotBlock"] = {"number": snapshot["readAt"]["blockNumber"], "hash": snapshot["readAt"]["blockHash"]}
    verdict = snapshot["verdict"]
    evaluation["onChainVerdict"] = "NONE" if verdict is None else ("PASS" if verdict["pass"] else "REJECT")
    criteria = criteria_from(snapshot["job"]["description"])
    evaluation["criteriaHash"] = criteria_hash(criteria)
    if evaluation["criteriaHash"] != claim["criteriaHash"]:
        raise GateRejected(GATE["criteria_hash"], "the claim's criteriaHash is not the job's criteria")
    if status[DELIVERABLE_MEMBER] == "UNAVAILABLE":
        return result("UNVERIFIABLE", REASON["no_deliverable"], evaluation)
    content = payloads[DELIVERABLE_MEMBER]
    if keccak256(content) != claim["deliverableCommitment"]:
        raise GateRejected(GATE["commitment"], "the deliverable bytes do not hash to the provider's commitment")
    derived = derive_from(criteria, content, claim["jobId"], claim["deliverableCommitment"])
    evaluation.update({
        "deliverableCommitment": keccak256(content),
        "checks": [{"index": str(i), "kind": item["kind"], "weight": str(item["weight"]), "pass": item["pass"]}
                   for i, item in enumerate(derived["results"])],
        "score": str(derived["score"]),
        "threshold": str(derived["threshold"]),
        "pass": derived["pass"],
        "evidenceHash": derived["evidenceHash"],
        "verdictAgreement": verdict_agreement(verdict, claim, derived),
    })
    if derived["pass"]:
        return result("VERIFIED", REASON["meets"], evaluation)
    return result("REFUTED", REASON["below"], evaluation)


# ------------------------------------------------------------------ receipts and recompute

def make_bundle(claim: dict[str, Any], snapshot_bytes: bytes | None, deliverable: bytes | None, ctx: dict[str, Any]) -> dict[str, Any]:
    evidence_set, payloads = evidence_for(snapshot_bytes, deliverable)
    canonical_result = evaluate(claim, evidence_set, payloads, ctx["rvrSchema"])
    receipt = {
        "claimDigest": canonical_digest(claim),
        "evidenceSetDigest": evidence_digest(evidence_set),
        "verificationProfileDigest": ctx["digest"],
        "outcome": canonical_result["outcome"],
        "reasonCode": canonical_result["reasonCode"],
        "resultDigest": canonical_digest(canonical_result),
    }
    return {"receipt": receipt, "claim": claim, "evidenceSet": evidence_set, "payloads": payloads, "canonicalResult": canonical_result}


def validate_bundle(bundle: dict[str, Any], ctx: dict[str, Any]) -> None:
    receipt, canonical_result, rvr_schema = bundle["receipt"], bundle["canonicalResult"], ctx["rvrSchema"]
    try:
        validate_schema(receipt, rvr_schema, rvr_schema)
        validate_schema(canonical_result, resolve_pointer(rvr_schema, "#/$defs/canonicalResult"), rvr_schema)
    except SchemaError as error:
        raise GateRejected(GATE["schema"], str(error)) from error
    validate_at(bundle["claim"], rvr_schema, "#/$defs/claim", GATE["schema"])
    validate_evidence(bundle["evidenceSet"], bundle["payloads"], rvr_schema, require_payloads=True)
    identities = {
        "claimDigest": canonical_digest(bundle["claim"]),
        "evidenceSetDigest": evidence_digest(bundle["evidenceSet"]),
        "verificationProfileDigest": ctx["digest"],
        "resultDigest": canonical_digest(canonical_result),
    }
    if any(receipt[key] != value for key, value in identities.items()):
        raise GateRejected(GATE["identity"], "stored identity mismatch")
    if receipt["outcome"] != canonical_result["outcome"] or receipt["reasonCode"] != canonical_result["reasonCode"]:
        raise GateRejected(GATE["projection"], "receipt/result projection mismatch")


def recompute(stored: dict[str, Any], candidate_claim: dict[str, Any], candidate_evidence: dict[str, Any], candidate_payloads: dict[str, bytes],
              *, overrides: dict[str, bytes] | None = None, missing: tuple[str, ...] = (), hidden_inputs: dict[str, Any] | None = None) -> dict[str, Any]:
    """ERC-8404 recomputation, in the specified order."""
    try:
        ctx = load_profile(overrides, missing)
    except CannotRecompute as error:
        return {"recomputationStatus": "CANNOT_RECOMPUTE", "reasonCode": error.reason_code, "evaluationPerformed": False, "constraintsApplied": False}
    if stored["receipt"]["verificationProfileDigest"] != ctx["digest"]:
        raise GateRejected(GATE["identity"], "receipt names another verification profile")
    validate_bundle(stored, ctx)
    if hidden_inputs:
        raise GateRejected(GATE["closure"], "outcome-relevant ambient input supplied")
    validate_evidence(candidate_evidence, candidate_payloads, ctx["rvrSchema"], require_payloads=False)
    for member in candidate_evidence["members"]:
        if member["status"] == "PRESENT" and member["id"] not in candidate_payloads:
            return {"recomputationStatus": "CANNOT_RECOMPUTE", "reasonCode": RECOMPUTE["evidence_unavailable"], "evaluationPerformed": False}
    candidate_result = evaluate(candidate_claim, candidate_evidence, candidate_payloads, ctx["rvrSchema"])
    same = (
        canonical_digest(candidate_claim) == stored["receipt"]["claimDigest"]
        and evidence_digest(candidate_evidence) == stored["receipt"]["evidenceSetDigest"]
        and canonical_digest(candidate_result) == stored["receipt"]["resultDigest"]
    )
    return {
        "recomputationStatus": "REPRODUCED" if same else "DIVERGED",
        "reasonCode": RECOMPUTE["identical"] if same else RECOMPUTE["diverged"],
        "evaluationPerformed": True,
        "verificationOutcome": candidate_result["outcome"],
        "verificationReasonCode": candidate_result["reasonCode"],
        "canonicalResult": candidate_result,
    }


# ------------------------------------------------------------------------------- the gate

def base_case(ctx: dict[str, Any], snapshot_path: str, deliverable_path: str) -> tuple[dict[str, Any], bytes, bytes]:
    snapshot_bytes = safe_dependency_path(snapshot_path).read_bytes()
    deliverable = safe_dependency_path(deliverable_path).read_bytes()
    snapshot = parse_json(snapshot_bytes, snapshot_path)
    derived = derive(snapshot["job"]["description"], deliverable, snapshot["job"]["id"], snapshot["submission"]["deliverable"])
    return claim_for(snapshot, derived["criteriaHash"]), snapshot_bytes, deliverable


def synthetic(snapshot_bytes: bytes, *, criteria: dict[str, Any] | None = None, content: bytes | None = None,
              verdict: Any = "keep", evaluator: str | None = None, description: str | None = None) -> tuple[dict[str, Any], bytes, bytes]:
    """A self-consistent variant of a base snapshot: the description, deliverable and commitment move together."""
    snapshot = parse_json(snapshot_bytes, "base snapshot")
    if criteria is not None:
        snapshot["job"]["description"] = "Synthetic conformance job.\n```judge-criteria\n" + json.dumps(criteria, ensure_ascii=False) + "\n```"
    if description is not None:
        snapshot["job"]["description"] = description
    if content is not None:
        snapshot["submission"]["deliverable"] = keccak256(content)
    if evaluator is not None:
        snapshot["job"]["evaluator"] = evaluator
    if verdict != "keep":
        snapshot["verdict"] = verdict
    deliverable = content if content is not None else b""
    try:
        c_hash = criteria_hash(parse_criteria(extract_criteria_text(snapshot["job"]["description"]) or ""))
    except (OutOfScope, ValueError, ProfileError):
        c_hash = "0x" + "0" * 64  # the criteria cannot be hashed; the evaluation rejects them before any hash comparison
    return claim_for(snapshot, c_hash), canonical_bytes(snapshot), deliverable


def expect_rejection(action: Any, reason_code: str) -> dict[str, Any]:
    try:
        action()
    except GateRejected as error:
        if error.reason_code != reason_code:
            raise ProfileError(f"expected {reason_code}, received {error.reason_code}: {error}") from error
        return {"gateStatus": "REJECTED", "reasonCode": error.reason_code}
    raise ProfileError(f"negative control did not reject with {reason_code}")


def audit_manifest() -> tuple[str, int]:
    manifest = load_json(MANIFEST_PATH)
    expected_members = [{"path": path, "sha256": sha256(safe_dependency_path(path).read_bytes())} for path in PACKAGE_MEMBERS]
    if manifest.get("members") != expected_members or manifest.get("memberCount") != len(expected_members):
        raise ProfileError("profile package manifest member drift")
    digest = sha256(dependency_rows(expected_members))
    if manifest.get("packageDigest") != digest:
        raise ProfileError("profile package digest drift")
    return digest, len(expected_members)


def audit_vector_set(profile: dict[str, Any]) -> None:
    members = profile["conformanceVectorSet"]["members"]
    for member in members:
        if sha256(safe_dependency_path(member["path"]).read_bytes()) != member["sha256"]:
            raise ProfileError(f"conformance vector drift: {member['id']}")
    if sha256(dependency_rows(members)) != profile["conformanceVectorSet"]["digest"]:
        raise ProfileError("conformance vector set digest drift")


def run_gate() -> dict[str, Any]:
    ctx = load_profile()
    package_digest, member_count = audit_manifest()
    audit_vector_set(ctx["profile"])
    vectors = load_json(PACKAGE / "vectors.json")
    expected = load_json(PACKAGE / "expected.json")
    base = {name: base_case(ctx, entry["snapshot"], entry["deliverable"]) for name, entry in vectors["baseCases"].items()}
    for name, entry in vectors["baseCases"].items():
        claim, snapshot_bytes, deliverable = base[name]
        if sha256(snapshot_bytes) != entry["snapshotSha256"] or sha256(deliverable) != entry["deliverableSha256"]:
            raise ProfileError(f"base case identity drift: {name}")

    claim, snapshot_bytes, deliverable = base["pass"]
    original = make_bundle(claim, snapshot_bytes, deliverable, ctx)
    reproduced = recompute(original, claim, original["evidenceSet"], original["payloads"])
    reproduced["onChainVerdict"] = original["canonicalResult"]["evaluation"]["onChainVerdict"]
    reproduced["verdictAgreement"] = original["canonicalResult"]["evaluation"]["verdictAgreement"]

    reject_claim, reject_snapshot, reject_deliverable = base["reject"]
    rejected = make_bundle(reject_claim, reject_snapshot, reject_deliverable, ctx)
    refuted_reproduced = recompute(rejected, reject_claim, rejected["evidenceSet"], rejected["payloads"])
    refuted_reproduced["onChainVerdict"] = rejected["canonicalResult"]["evaluation"]["onChainVerdict"]
    refuted_reproduced["verdictAgreement"] = rejected["canonicalResult"]["evaluation"]["verdictAgreement"]

    failing = vectors["negativeControls"]["divergedDeliverable"].encode("utf-8")
    diverged_claim = copy.deepcopy(claim)
    diverged_snapshot = parse_json(snapshot_bytes, "base snapshot")
    diverged_snapshot["submission"]["deliverable"] = diverged_claim["deliverableCommitment"] = keccak256(failing)
    diverged_evidence, diverged_payloads = evidence_for(canonical_bytes(diverged_snapshot), failing)
    diverged = recompute(original, diverged_claim, diverged_evidence, diverged_payloads)
    diverged["failingChecks"] = [c["kind"] for c in diverged["canonicalResult"]["evaluation"]["checks"] if not c["pass"]]

    unavailable = make_bundle(claim, snapshot_bytes, None, ctx)
    unavailable_reproduced = recompute(unavailable, claim, unavailable["evidenceSet"], unavailable["payloads"])

    missing_payloads = dict(original["payloads"])
    del missing_payloads[DELIVERABLE_MEMBER]
    cannot = recompute(original, claim, original["evidenceSet"], missing_payloads)
    normative_cannot = recompute(original, claim, original["evidenceSet"], original["payloads"],
                                 missing=("judge-protocol-rvr-v0-verification-specification",))
    tampered = recompute(original, claim, original["evidenceSet"], original["payloads"],
                         overrides={"judge-protocol-rvr-v0-profile-schema": b"{not-valid-json"})

    substituted_payloads = dict(original["payloads"])
    substituted_payloads[DELIVERABLE_MEMBER] = deliverable + b" "
    payload_mismatch = expect_rejection(
        lambda: recompute(original, claim, original["evidenceSet"], substituted_payloads), GATE["identity"])

    non_required = [m for m in ctx["profile"]["conformanceVectorSet"]["members"] if not m["requiredForRecomputation"]]
    withheld = recompute(original, claim, original["evidenceSet"], original["payloads"], missing=tuple(m["id"] for m in non_required))
    swapped = recompute(original, claim, original["evidenceSet"], original["payloads"],
                        overrides={m["id"]: b"substituted conformance material" for m in non_required})
    def result_digest(outcome: dict[str, Any]) -> str | None:
        return canonical_digest(outcome["canonicalResult"]) if "canonicalResult" in outcome else None

    non_required_control = {
        "withheldStatus": withheld["recomputationStatus"],
        "substitutedStatus": swapped["recomputationStatus"],
        "resultUnchanged": result_digest(withheld) == result_digest(swapped) == original["receipt"]["resultDigest"],
    }

    contradictory = copy.deepcopy(original)
    contradictory["receipt"]["outcome"] = vectors["negativeControls"]["projectionReplacement"]
    projection = expect_rejection(lambda: validate_bundle(contradictory, ctx), GATE["projection"])
    projection["resultDigestPreserved"] = contradictory["receipt"]["resultDigest"] == canonical_digest(contradictory["canonicalResult"])

    hidden = expect_rejection(
        lambda: recompute(original, claim, original["evidenceSet"], original["payloads"],
                          hidden_inputs=vectors["negativeControls"]["hiddenAmbientInput"]), GATE["closure"])
    hidden["evaluationPerformed"] = False

    tampered_verdict = copy.deepcopy(parse_json(reject_snapshot, "reject snapshot")["verdict"])
    tampered_verdict.update({"pass": True, "score": "100"})
    b_claim, b_snapshot, b_deliverable = synthetic(reject_snapshot, verdict=tampered_verdict, content=reject_deliverable)
    boundary_bundle = make_bundle(b_claim, b_snapshot, b_deliverable, ctx)
    altered_hash = copy.deepcopy(parse_json(reject_snapshot, "reject snapshot")["verdict"])
    altered_hash["evidenceHash"] = "0x" + "ab" * 32
    h_claim, h_snapshot, h_deliverable = synthetic(reject_snapshot, verdict=altered_hash, content=reject_deliverable)
    verdict_boundary = {
        "verificationOutcome": boundary_bundle["canonicalResult"]["outcome"],
        "onChainVerdict": boundary_bundle["canonicalResult"]["evaluation"]["onChainVerdict"],
        "verdictAgreement": boundary_bundle["canonicalResult"]["evaluation"]["verdictAgreement"],
        "evidenceHashOnlyAgreement": make_bundle(h_claim, h_snapshot, h_deliverable, ctx)["canonicalResult"]["evaluation"]["verdictAgreement"],
    }

    byte_contract: dict[str, str] = {}
    for case in vectors["byteContractVectors"]:
        actual_hash = criteria_hash(parse_criteria(case["criteriaText"]))
        if actual_hash != case["criteriaHash"]:
            raise ProfileError(f"byte contract vector {case['id']}: {actual_hash} != {case['criteriaHash']}")
        byte_contract[case["id"]] = actual_hash

    semantic_results: dict[str, Any] = {}
    for case in vectors["semanticCases"]:
        s_claim, s_snapshot, s_deliverable = synthetic(snapshot_bytes, criteria=case["criteria"], content=case["deliverable"].encode("utf-8"), verdict=None)
        bundle = make_bundle(s_claim, s_snapshot, s_deliverable, ctx)
        evaluation = bundle["canonicalResult"]["evaluation"]
        actual = {"outcome": bundle["canonicalResult"]["outcome"], "score": evaluation["score"],
                  "failingChecks": [c["kind"] for c in evaluation["checks"] if not c["pass"]]}
        wanted = {key: case[key] for key in ("outcome", "score", "failingChecks")}
        if actual != wanted:
            raise ProfileError(f"semantic case {case['id']}: expected {wanted}, got {actual}")
        semantic_results[case["id"]] = actual

    gate_results: dict[str, str] = {}
    for case in vectors["gateCases"]:
        kwargs: dict[str, Any] = {"verdict": None}
        if "criteria" in case:
            kwargs["criteria"] = case["criteria"]
        if "deliverableBase64" in case:
            kwargs["content"] = base64.b64decode(case["deliverableBase64"])
        else:
            kwargs["content"] = case.get("deliverable", "judged content").encode("utf-8")
        for key in ("evaluator", "description"):
            if key in case:
                kwargs[key] = case[key]
        g_claim, g_snapshot, g_deliverable = synthetic(snapshot_bytes, **kwargs)
        if case.get("mutation") == "claimCriteriaHash":
            g_claim["criteriaHash"] = "0x" + "11" * 32
        elif case.get("mutation") == "deliverableNotCommitted":
            g_deliverable = g_deliverable + b"!"
        elif case.get("mutation") == "snapshotWhitespace":
            g_snapshot = g_snapshot + b"\n"
        evidence_set, payloads = evidence_for(g_snapshot, g_deliverable)
        rejection = expect_rejection(lambda: evaluate(g_claim, evidence_set, payloads, ctx["rvrSchema"]), case["expectedGate"])
        gate_results[case["id"]] = rejection["reasonCode"]

    cases = {
        "REPRODUCED": reproduced,
        "REFUTED_REPRODUCED": refuted_reproduced,
        "DIVERGED": diverged,
        "UNVERIFIABLE_REPRODUCED": unavailable_reproduced,
        "CANNOT_RECOMPUTE": cannot,
        "NORMATIVE_DEPENDENCY_CANNOT_RECOMPUTE": normative_cannot,
        "TAMPERED_PROFILE_CONSTRAINTS_PIN": tampered,
        "PAYLOAD_IDENTITY_MISMATCH": payload_mismatch,
        "NON_REQUIRED_DEPENDENCY_CONTROL": non_required_control,
        "PROJECTION_NEGATIVE_CONTROL": projection,
        "HIDDEN_STATE_NEGATIVE_CONTROL": hidden,
        "ONCHAIN_VERDICT_BOUNDARY": verdict_boundary,
    }
    for identifier, expected_case in expected["cases"].items():
        for key, value in expected_case.items():
            if cases[identifier].get(key) != value:
                raise ProfileError(f"expected mismatch at {identifier}.{key}: {cases[identifier].get(key)!r} != {value!r}")
    counts = {"semanticCases": len(semantic_results), "gateCases": len(gate_results), "byteContractVectors": len(byte_contract)}
    if counts != expected["counts"]:
        raise ProfileError(f"case count drift: {counts} != {expected['counts']}")

    for case in cases.values():
        case.pop("canonicalResult", None)
    return {
        "gate": "RVR_JUDGE_PROTOCOL_V0_PASS",
        "profileId": PROFILE_ID,
        "proposition": PROPOSITION,
        "verificationProfileDigest": ctx["digest"],
        "packageDigest": package_digest,
        "packageMembers": member_count,
        "unicodeVersion": unicodedata.unidata_version,
        "receipts": {"pass": original["receipt"], "reject": rejected["receipt"], "deliverableUnavailable": unavailable["receipt"]},
        "byteContractVectors": {"passed": len(byte_contract), "results": byte_contract},
        "semanticCases": {"passed": len(semantic_results), "results": semantic_results},
        "gateCases": {"passed": len(gate_results), "results": gate_results},
        "cases": cases,
    }


def write_derived() -> None:
    profile = load_json(PROFILE_PATH)
    for dependency in profile_dependencies(profile):
        dependency["sha256"] = sha256(safe_dependency_path(dependency["path"]).read_bytes())
    profile["conformanceVectorSet"]["digest"] = sha256(dependency_rows(profile["conformanceVectorSet"]["members"]))
    rvr_digest = sha256(RVR_SCHEMA_PATH.read_bytes())
    profile["evidenceSetContract"]["schemaSha256"] = rvr_digest
    profile["canonicalResultContract"]["schemaSha256"] = rvr_digest
    PROFILE_PATH.write_text(json.dumps(profile, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    members = [{"path": path, "sha256": sha256(safe_dependency_path(path).read_bytes())} for path in PACKAGE_MEMBERS]
    manifest = {
        "schema": "rvr.profile-package-manifest.v0",
        "hashAlgorithm": "sha256-lowercase-hex",
        "memberCount": len(members),
        "members": members,
        "packageDigestRule": "sha256-utf8-sorted-path-tab-file-sha256-lf-rows-manifest-excluded",
        "packageDigest": sha256(dependency_rows(members)),
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")


def evaluate_request(request: dict[str, Any]) -> dict[str, Any]:
    content = base64.b64decode(request["deliverableBase64"])
    try:
        derived = derive(request["description"], content, request["jobId"], request["commitment"])
    except GateRejected as error:
        return {"gate": error.reason_code}
    return {"criteriaHash": derived["criteriaHash"], "checks": [{"kind": r["kind"], "pass": r["pass"]} for r in derived["results"]],
            "score": derived["score"], "threshold": derived["threshold"], "pass": derived["pass"], "evidenceHash": derived["evidenceHash"]}


def evaluate_stdin() -> Any:
    """Cross-implementation aid (non-normative): derive rulings from JSON on stdin (one request or a list)."""
    request = json.loads(sys.stdin.read())
    if isinstance(request, list):
        return [evaluate_request(item) for item in request]
    return evaluate_request(request)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="run the exact profile gate")
    parser.add_argument("--write-derived", action="store_true", help="rewrite committed hashes and the package manifest")
    parser.add_argument("--evaluate", action="store_true", help="derive one ruling from JSON on stdin (cross-check aid)")
    arguments = parser.parse_args()
    try:
        if arguments.evaluate:
            print(json.dumps(evaluate_stdin(), ensure_ascii=False, sort_keys=True))
            return 0
        if arguments.write_derived:
            write_derived()
        print(json.dumps(run_gate(), ensure_ascii=False, indent=2, sort_keys=True))
        return 0
    except (ProfileError, OSError, KeyError, ValueError) as error:
        print(f"RVR_JUDGE_PROTOCOL_V0_FAIL: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
