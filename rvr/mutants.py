"""Mutation check for the judge-protocol-rvr-v0 gate. Not part of the profile package.

Each mutant removes or weakens one protection in adapter.py, or takes a shortcut a Python
reimplementation of SPEC.md could plausibly take (banker's rounding, str.split, the runtime's
own Unicode tables). The gate must fail on every one of them, and it must fail in the case
written to catch that protection: a mutant that only crashes somewhere else, or trips an
unrelated case, counts as a miss. Each mutant runs in a temporary copy of this directory, so the
committed package is never touched.

Run from this directory: python3 mutants.py
"""
import contextlib
import importlib.util
import io
import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ADAPTER = "profiles/judge-protocol-rvr-v0/adapter.py"
SOURCE = (HERE / ADAPTER).read_text(encoding="utf-8")

# (what the mutant does, text in adapter.py, replacement, the case that must catch it)
MUTANTS = [
    # judge-protocol-checkers-v1 and the byte contract
    ("chars counted as code points", 'n = utf16_length(text) if params.get("unit") == "chars" else word_count(text)',
     'n = len(text) if params.get("unit") == "chars" else word_count(text)', "length-chars-counts-utf16-units"),
    ("words via Python str.split", 'n = utf16_length(text) if params.get("unit") == "chars" else word_count(text)',
     'n = utf16_length(text) if params.get("unit") == "chars" else len(text.split())', "length-information-separator-is-not-whitespace"),
    ("Python banker's rounding", "rounded = 0 if weight_sum == 0 else js_round((weight_pass / weight_sum) * 100)",
     "rounded = 0 if weight_sum == 0 else round((weight_pass / weight_sum) * 100)", "round-half-up-at-point-five"),
    ("no 99 cap", 'score = rounded if all(item["pass"] for item in results) else min(rounded, 99)', "score = rounded", "score-cap-at-threshold-100"),
    ("keys by code point, not UTF-16", "others = sorted((key for key in value if not is_array_index(key)), key=utf16_order)",
     "others = sorted((key for key in value if not is_array_index(key)), key=lambda k: tuple(ord(c) for c in k))", "utf16-order-not-code-point"),
    ("no array-index-first order", 'for key in indices + others) + "}"', 'for key in sorted(value, key=utf16_order)) + "}"', "integer-index-keys-first"),
    ("typeof null is null", 'return "object"  # objects, arrays and null', 'return "null" if value is None else "object"', "schema-null-is-object"),
    ("NaN accepted as JSON", "parsed = json.loads(text, parse_constant=reject_constant, parse_int=float)",
     "parsed = json.loads(text, parse_int=float)", "schema-nan-is-not-json"),
    ("big integers parsed as Python int", "parsed = json.loads(text, parse_constant=reject_constant, parse_int=float)",
     "parsed = json.loads(text, parse_constant=reject_constant)", "schema-integer-beyond-python-digit-limit"),
    ("underscore not a word character", '    if character == "_":\n        return True\n', "", "contains-whole-word-underscore-boundary"),
    ("the runtime's Unicode tables", "    point = ord(character)\n    index = bisect.bisect_right(table[0], point) - 1\n    return index >= 0 and point <= table[1][index]",
     '    return __import__("unicodedata").category(character)[0] in ("L", "N")', "contains-whole-word-unicode-17-letter"),
    ("whole words: first occurrence only", "        start = text.find(term, start + 1)\n    return False", "        return False\n    return False",
     "contains-whole-word-later-occurrence"),
    ("Python whitespace after the fence", "while position < len(description) and description[position] in JS_WHITESPACE:",
     "while position < len(description) and description[position].isspace():", "criteria-fence-then-information-separator"),
    ("byte order mark stripped", 'text = content.decode("utf-8")', 'text = content.decode("utf-8-sig")', "schema-byte-order-mark-is-not-json"),
    ("invalid UTF-8 replaced", 'text = content.decode("utf-8")', 'text = content.decode("utf-8", "replace")', "deliverable-not-utf8"),
    ("int() on any digit key", "    return len(key) <= 10 and _ARRAY_INDEX.fullmatch(key) is not None and int(key) < 4294967295",
     "    return _ARRAY_INDEX.fullmatch(key) is not None and int(key) < 4294967295", "schema-type-key-beyond-python-digit-limit"),
    ("int() on any criteria literal", '    if len(literal.lstrip("-")) > 16:', "    if False:", "criteria-number-beyond-python-digit-limit"),
    # criteria validation, one mutant per rule
    ("__proto__ members allowed", "    if has_proto_member(criteria):\n        return", "    if False:\n        return", "criteria-member-named-proto"),
    ("no nesting limit", '    if nests_deeper_than(criteria, LIMITS["depth"]):\n        return', "    if False:\n        return", "criteria-nest-deeper-than-12"),
    ("criteria need not be an object", '    if not isinstance(criteria, dict):\n        return "criteria is not an object"',
     '    if False:\n        return "criteria is not an object"', "criteria-not-an-object"),
    ("checks may be missing", "    if not isinstance(checks, list) or not checks:", "    if False:", "checks-missing"),
    ("checks may be empty", "    if not isinstance(checks, list) or not checks:", "    if not isinstance(checks, list):", "checks-empty"),
    ("no check-count limit", '    if len(checks) > LIMITS["checks"]:', "    if False:", "more-than-64-checks"),
    ("threshold above 100", "and 0 <= threshold <= 100):", "and 0 <= threshold):", "pass-threshold-above-100"),
    ("threshold may be a boolean", "        if not (isinstance(threshold, int) and not isinstance(threshold, bool) and 0 <= threshold <= 100):",
     "        if not (isinstance(threshold, int) and 0 <= threshold <= 100):", "pass-threshold-not-an-integer"),
    ("a check need not be an object", '        if not isinstance(check, dict):\n            return f"checks[{index}] is not an object"',
     '        if False:\n            return f"checks[{index}] is not an object"', "check-not-an-object"),
    ("unknown check fields allowed", "        if extra:\n            return", "        if False:\n            return", "unknown-check-field"),
    ("unknown kinds allowed", '        if check.get("kind") not in KNOWN_KINDS:', "        if False:", "unknown-check-kind"),
    ("zero weight accepted", 'if not (_is_number(weight) and 0 < weight <= LIMITS["weight"]):',
     'if not (_is_number(weight) and 0 <= weight <= LIMITS["weight"]):', "zero-weight"),
    ("weight above 1000", 'if not (_is_number(weight) and 0 < weight <= LIMITS["weight"]):', "if not (_is_number(weight) and 0 < weight):", "weight-above-1000"),
    ("weight may be a string", 'if not (_is_number(weight) and 0 < weight <= LIMITS["weight"]):',
     'if not (isinstance(weight, (int, float, str)) and float(weight) > 0 and float(weight) <= LIMITS["weight"]):', "weight-not-a-number"),
    ("params need not be an object", '        if _has(check.get("params")) and not isinstance(check["params"], dict):',
     "        if False:", "params-not-an-object"),
    ("unknown params allowed", "        if key not in PARAM_NAMES.get(kind, ()):", "        if False:", "unknown-param"),
    ("negative bounds allowed", "and params[key] >= 0):", "):", "length-min-negative"),
    ("min above max allowed", '        if _has(params.get("min")) and _has(params.get("max")) and params["min"] > params["max"]:', "        if False:", "min-above-max"),
    ("any unit", '        if _has(params.get("unit")) and params["unit"] not in ("chars", "words"):', "        if False:", "length-unit-unknown"),
    ("all need not be a list", '        if _has(params.get("all")) and not _is_string_list(params["all"]):', "        if False:", "contains-all-not-a-list"),
    ("no term length limit", ' and utf16_length(item) <= LIMITS["termChars"] for item in value)', " for item in value)", "contains-term-over-1024-units"),
    ("no term count limit", 'return isinstance(value, list) and len(value) <= LIMITS["terms"] and all(', "return isinstance(value, list) and all(",
     "contains-over-256-terms"),
    ("wholeWords may be anything", '        if _has(params.get("wholeWords")) and not isinstance(params["wholeWords"], bool):', "        if False:",
     "contains-whole-words-not-boolean"),
    ("types need not be an object", "            if not isinstance(types, dict):", "            if False:", "schema-types-not-an-object"),
    ("any type name", "            if any(type_name not in TYPE_NAMES for type_name in types.values()):", "            if False:", "schema-type-name-unknown"),
    ("any checksum text", 're.fullmatch(r"[0-9a-fA-F]{64}", params["sha256"]) is None:', 're.fullmatch(r"(0x)?[0-9a-fA-F]{64}", params["sha256"]) is None:',
     "checksum-not-64-hex"),
    ("no probe limit", '    if sum(1 for check in checks if check["kind"] == "http-endpoint") > LIMITS["probes"]:', "    if False:", "more-than-4-probes"),
    ("http-endpoint in scope", '    if any(check["kind"] not in IN_SCOPE_KINDS for check in criteria["checks"]):', "    if False:", "http-endpoint-out-of-scope"),
    ("lone surrogates in scope", '    if has_surrogate(value):\n        raise OutOfScope', "    if False:\n        raise OutOfScope", "criteria-lone-surrogate"),
    ("unsafe integers in scope", "    if abs(value) > MAX_SAFE_INTEGER:\n        raise OutOfScope", "    if False:\n        raise OutOfScope", "criteria-unsafe-integer"),
    ("scope checked before syntax", "    json.loads(text, parse_int=float, parse_constant=reject_constant)\n", "",
     "criteria-not-json-after-an-out-of-scope-number"),
    ("fractions in scope", "if not math.isfinite(value) or not value.is_integer() or abs(value) > MAX_SAFE_INTEGER:",
     "if not math.isfinite(value) or abs(value) > MAX_SAFE_INTEGER:", "non-integer-weight-out-of-scope"),
    # the chain snapshot
    ("snapshot canonical form not checked", "    if canonical_bytes(snapshot) != payload:", "    if False:", "snapshot-not-canonical"),
    ("snapshot schema not checked", '    validate_at(snapshot, rvr_schema, "#/$defs/chainSnapshot", GATE["snapshot_invalid"])\n', "", "snapshot-schema-violation"),
    ("submission may be for another job", '    if submission["jobId"] != job["id"]:', "    if False:", "submission-for-another-job"),
    ("submission from anyone", ' or submission["provider"] != job["provider"]:', ":", "submission-not-from-the-provider"),
    ("zero provider allowed", '    if job["provider"] == ZERO_ADDRESS or submission["provider"] != job["provider"]:',
     '    if submission["provider"] != job["provider"]:', "provider-is-the-zero-address"),
    ("submission after readAt allowed", '    if decimal_key(submission["blockNumber"]) > decimal_key(read_at["blockNumber"]):', "    if False:",
     "submission-after-read-block"),
    ("status not checked", '    if job["status"] not in SUBMITTED_OR_LATER:', "    if False:", "job-still-funded"),
    ("verdict may be for another job", '        if verdict["jobId"] != job["id"]:', "        if False:", "verdict-for-another-job"),
    ("verdict blocks not ordered", '        if verdict["blockNumber"] is not None and not (', "        if False and not (", "verdict-before-submission"),
    ("snapshot for any deployment", "    if not same_deployment or not same_job:", "    if not same_job:", "snapshot-for-another-contract"),
    ("claim may name another job", "    if not same_deployment or not same_job:", "    if not same_deployment:", "claim-for-another-job"),
    ("any evaluator", '    if snapshot["job"]["evaluator"] != JUDGE_EVALUATOR:', "    if False:", "evaluator-is-not-the-judge"),
    ("claim commitment not the submitted one", '    if snapshot["submission"]["deliverable"] != claim["deliverableCommitment"]:', "    if False:",
     "claim-commitment-not-submitted"),
    ("deliverable bytes not the commitment", '        if keccak256(content) != claim["deliverableCommitment"]:', "        if False:",
     "deliverable-not-the-committed-bytes"),
    ("commitment unchecked without a snapshot", "    content = payloads.get(DELIVERABLE_MEMBER)\n    if content is not None:",
     '    content = payloads.get(DELIVERABLE_MEMBER)\n    if content is not None and status[SNAPSHOT_MEMBER] != "UNAVAILABLE":',
     "snapshot-unavailable-deliverable-not-committed"),
    ("claim criteria not the job's", '    if evaluation["criteriaHash"] != claim["criteriaHash"]:', "    if False:", "claim-names-other-criteria"),
    # limits
    ("no size limit before hashing", '        if len(content) > MAX_DELIVERABLE_BYTES:\n            raise GateRejected(GATE["resource"], "deliverable is larger than the profile limit")\n        if keccak256',
     "        if keccak256", "deliverable-over-1000000-bytes"),
    ("no JSON depth limit", "        if json_depth(text) > MAX_DELIVERABLE_JSON_DEPTH:", "        if False:", "deliverable-json-too-deep"),
    # the evidence set
    ("unavailable members may carry payloads", '            if payload is not None:\n                raise GateRejected(GATE["identity"], "unavailable member has a payload")',
     '            if False:\n                raise GateRejected(GATE["identity"], "unavailable member has a payload")', "evidence-unavailable-with-payload"),
    ("members in any order", "    if identifiers != [SNAPSHOT_MEMBER, DELIVERABLE_MEMBER]:", "    if sorted(identifiers) != [SNAPSHOT_MEMBER, DELIVERABLE_MEMBER]:",
     "evidence-members-out-of-order"),
    ("payload length not checked", 'if member["byteLength"] != str(len(payload)) or member["digest"] != sha256(payload):',
     'if member["digest"] != sha256(payload):', "PAYLOAD_LENGTH_MISMATCH"),
    ("payload digest not checked", 'if member["byteLength"] != str(len(payload)) or member["digest"] != sha256(payload):',
     'if member["byteLength"] != str(len(payload)):', "PAYLOAD_DIGEST_MISMATCH"),
    # recomputation, in the ERC's order
    ("receipt shape not checked first", "    problem = receipt_shape_problem(stored[\"receipt\"])\n    if problem:", "    problem = None\n    if problem:",
     "RECEIPT_SHAPE_REJECTED"),
    ("profile digest compared late", '    if stored["receipt"]["verificationProfileDigest"] != envelope["digest"]:', "    if False:", "FOREIGN_PROFILE_REJECTED"),
    ("dependency pins not checked before parse", '        if sha256(data) != dependency["sha256"]:', "        if False:", "REQUIRED_DEPENDENCY_IDENTITY_MISMATCH"),
    ("bootstrap schema compared loosely", '    if pinned[MANIFEST_SCHEMA_ID] != envelope["bootstrap"]:', "    if False:", "BOOTSTRAP_SCHEMA_BYTES_REJECTED"),
    ("evidence-set schema pin not checked", '    if rvr_sha != profile["evidenceSetContract"]["schemaSha256"] or rvr_sha',
     "    if rvr_sha", "CONTRACT_SCHEMA_PIN_REJECTED"),
    ("missing dependencies ignored", '        if dependency["id"] in missing:', "        if False:", "NORMATIVE_DEPENDENCY_CANNOT_RECOMPUTE"),
    ("non-required dependencies resolved", '        if not dependency["requiredForRecomputation"]:\n            continue\n', "", "NON_REQUIRED_DEPENDENCY_CONTROL"),
    ("committed-present payloads not required", '        if member["status"] == "PRESENT" and member["id"] not in candidate_payloads:\n            return cannot(RECOMPUTE["evidence_unavailable"])',
     "        pass", "CANNOT_RECOMPUTE"),
    ("stored receipt checked before payloads", '''    for member in evidence_members(candidate_evidence):
        if member["status"] == "PRESENT" and member["id"] not in candidate_payloads:
            return cannot(RECOMPUTE["evidence_unavailable"])
    # 4. the original receipt, canonical result identity and projections
    validate_bundle(stored, ctx)''', '''    validate_bundle(stored, ctx)
    for member in evidence_members(candidate_evidence):
        if member["status"] == "PRESENT" and member["id"] not in candidate_payloads:
            return cannot(RECOMPUTE["evidence_unavailable"])''', "CANNOT_RECOMPUTE_PRECEDES_GATES"),
    ("stored identities not checked", "    if any(receipt[key] != value for key, value in identities.items()):", "    if False:", "STORED_CLAIM_MISMATCH"),
    ("projection not checked", '    if receipt["outcome"] != canonical_result["outcome"] or receipt["reasonCode"] != canonical_result["reasonCode"]:',
     "    if False:", "PROJECTION_NEGATIVE_CONTROL"),
    ("contradictory results accepted", '''    if (canonical_result["outcome"], canonical_result["reasonCode"], canonical_result["evaluation"]["pass"]) not in RESULT_SHAPES:''',
     "    if False:", "CONTRADICTORY_RESULT_REJECTED"),
    ("hidden input ignored", '    if hidden_inputs:\n        raise GateRejected(GATE["closure"], "outcome-relevant input outside the evidence closure")\n', "",
     "HIDDEN_STATE_NEGATIVE_CONTROL"),
    # the recorded verdict, one field at a time
    ("agreement ignores criteriaHash", '        verdict["criteriaHash"] == derived["criteriaHash"]\n        and verdict["deliverable"]',
     '        verdict["deliverable"]', "VERDICT_FIELD_CONTROLS"),
    ("agreement ignores deliverable", '        and verdict["deliverable"] == claim["deliverableCommitment"]\n', "", "VERDICT_FIELD_CONTROLS"),
    ("agreement ignores score", '        and verdict["score"] == str(derived["score"])\n', "", "VERDICT_FIELD_CONTROLS"),
    ("agreement ignores threshold", '        and verdict["threshold"] == str(derived["threshold"])\n', "", "VERDICT_FIELD_CONTROLS"),
    ("agreement ignores pass", '        and verdict["pass"] is derived["pass"]\n', "", "VERDICT_FIELD_CONTROLS"),
    ("agreement ignores evidenceHash", '        and verdict["evidenceHash"] == derived["evidenceHash"]\n', "", "VERDICT_FIELD_CONTROLS"),
    # found missing by the verification round
    ("negative threshold allowed", "and 0 <= threshold <= 100):", "and threshold <= 100):", "pass-threshold-negative"),
    ("negative max allowed", '        for key in ("min", "max"):', '        for key in ("min",):', "length-max-negative"),
    ("required need not be a list", '        if _has(params.get("required")) and not _is_string_list(params["required"]):', "        if False:",
     "schema-required-not-a-list"),
    ("no types count limit", '            if len(types) > LIMITS["terms"]:', "            if False:", "schema-over-256-types"),
    ("any probe url", '        if _has(params.get("url")) and not (isinstance(params["url"], str) and utf16_length(params["url"]) <= LIMITS["urlChars"]):',
     "        if False:", "probe-url-over-2048-units"),
    ("any probe status", "        if _has(status) and not (isinstance(status, int) and not isinstance(status, bool) and 100 <= status <= 599):",
     "        if False:", "probe-status-out-of-range"),
    ("any probe body list", '        if _has(params.get("bodyIncludes")) and not _is_string_list(params["bodyIncludes"]):', "        if False:",
     "probe-body-includes-not-a-list"),
    ("any probe timeout", '        if _has(timeout) and not (_is_number(timeout) and 1 <= timeout <= LIMITS["probeTimeoutMs"]):', "        if False:",
     "probe-timeout-out-of-range"),
    ("snapshot for any chain", 'same_deployment = (claim["chainId"], claim["acp"], claim["evaluator"]) == (snapshot["chainId"], snapshot["acp"], snapshot["evaluatorContract"])',
     'same_deployment = (claim["acp"], claim["evaluator"]) == (snapshot["acp"], snapshot["evaluatorContract"])', "snapshot-for-another-chain"),
    ("snapshot for any evaluator contract", 'same_deployment = (claim["chainId"], claim["acp"], claim["evaluator"]) == (snapshot["chainId"], snapshot["acp"], snapshot["evaluatorContract"])',
     'same_deployment = (claim["chainId"], claim["acp"]) == (snapshot["chainId"], snapshot["acp"])', "snapshot-for-another-evaluator-contract"),
    ("claim shape not checked", '    validate_at(claim, rvr_schema, "#/$defs/claim", GATE["schema"])\n', "", "claim-malformed"),
    ("deep JSON crashes the parser", "    except (UnicodeError, ValueError, RecursionError) as error:", "    except (UnicodeError, ValueError) as error:",
     "snapshot-deeper-than-the-parser"),
    ("duplicate dependency ids allowed", "    if len(identifiers) != len(set(identifiers)):", "    if False:", "DUPLICATE_DEPENDENCY_ID_REJECTED"),
    ("an absent dependency file crashes", "            except (OSError, ProfileError) as error:", "            except ProfileError as error:", "DEPENDENCY_FILE_ABSENT"),
    ("a bad dependency path crashes", "            except (OSError, ProfileError) as error:", "            except OSError as error:", "DEPENDENCY_PATH_OUTSIDE_ROOT"),
    ("normative dependencies may be optional", "    if any(identifier not in pinned for identifier in (MANIFEST_SCHEMA_ID, CONSTRAINTS_ID, SPEC_ID, RVR_SCHEMA_ID)):",
     "    if False:", "NORMATIVE_DEPENDENCY_NOT_REQUIRED"),
    ("pinned constraints not applied", "        validate_schema(profile, constraints, constraints)\n", "", "PROFILE_CONSTRAINTS_APPLIED"),
    ("canonical result schema pin not checked", ' or rvr_sha != profile["canonicalResultContract"]["schemaSha256"]:', ":", "CANONICAL_RESULT_SCHEMA_PIN_REJECTED"),
    ("a Submitted job refused", 'SUBMITTED_OR_LATER = ("2", "3", "4", "5")', 'SUBMITTED_OR_LATER = ("3", "4", "5")', "SUBMITTED_JOB_EVALUATED"),
    ("an Expired job refused", 'SUBMITTED_OR_LATER = ("2", "3", "4", "5")', 'SUBMITTED_OR_LATER = ("2", "3", "4")', "EXPIRED_JOB_EVALUATED"),
    ("depth clamped at zero", "            depth -= 1", "            depth = max(depth - 1, 0)", "schema-closers-lower-the-depth"),
    ("quotes ignored when counting depth", "        elif character == '\"':\n            in_string = True", "        elif False:\n            in_string = True",
     "schema-quote-hides-brackets"),
]


def gate(source: str, tag: str) -> str | None:
    """Run the gate with this adapter source; return its failure message, or None if it passed."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        for part in ("conformance", "profiles"):
            shutil.copytree(HERE / part, root / part)
        (root / ADAPTER).write_text(source, encoding="utf-8")
        spec = importlib.util.spec_from_file_location(f"rvr_mutant_{tag}", root / ADAPTER)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        # The package manifest pins adapter.py, so every mutant would fail on that alone.
        # Skip it here: the question is whether the semantic checks catch the change.
        module.audit_manifest = lambda: ("mutant", 0)
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                module.run_gate()
        except Exception as error:
            return f"{type(error).__name__}: {error}"
        return None


def main() -> int:
    sys.dont_write_bytecode = True
    control = gate(SOURCE, "control")
    if control is not None:
        print(f"control (unmutated adapter) failed: {control}")
        return 1
    misses = 0
    for index, (name, old, new, case) in enumerate(MUTANTS):
        if SOURCE.count(old) != 1:
            print(f"mutant '{name}': its text occurs {SOURCE.count(old)} times in adapter.py, expected once")
            return 1
        failure = gate(SOURCE.replace(old, new), str(index))
        if failure is None:
            verdict = "SURVIVED"
        elif f"case {case}:" in failure:
            verdict = "killed  "
        else:
            verdict = "MISFIRED"  # the gate failed, but not in the case written for this protection
        misses += verdict != "killed  "
        print(verdict, name.ljust(44), case if verdict == "killed  " else (failure or "")[:120])
    print(f"{len(MUTANTS) - misses} of {len(MUTANTS)} mutants killed by the case written to catch them")
    return 1 if misses else 0


if __name__ == "__main__":
    raise SystemExit(main())
