"""Mutation check for the judge-protocol-rvr-v0 gate. Not part of the profile package.

Each mutant is one shortcut a Python reimplementation of SPEC.md could plausibly take
(banker's rounding, str.split, code point lengths, a skipped check). The gate must fail on
every one of them, or it is not testing what SPEC.md says. Each mutant runs in a temporary
copy of this directory, so the committed package is never touched.

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

MUTANTS = [
    ("chars counted as code points",
     'n = utf16_length(text) if params.get("unit") == "chars" else word_count(text)',
     'n = len(text) if params.get("unit") == "chars" else word_count(text)'),
    ("words via Python str.split",
     'n = utf16_length(text) if params.get("unit") == "chars" else word_count(text)',
     'n = utf16_length(text) if params.get("unit") == "chars" else len(text.split())'),
    ("Python banker's rounding",
     "rounded = 0 if weight_sum == 0 else js_round((weight_pass / weight_sum) * 100)",
     "rounded = 0 if weight_sum == 0 else round((weight_pass / weight_sum) * 100)"),
    ("no 99 cap",
     'score = rounded if all(item["pass"] for item in results) else min(rounded, 99)',
     "score = rounded"),
    ("keys by code point, not UTF-16",
     "others = sorted((key for key in value if not is_array_index(key)), key=utf16_order)",
     "others = sorted((key for key in value if not is_array_index(key)), key=lambda k: tuple(ord(c) for c in k))"),
    ("no array-index-first order",
     'for key in indices + others) + "}"',
     'for key in sorted(value, key=utf16_order)) + "}"'),
    ("typeof null is null",
     'return "object"  # objects, arrays and null',
     'return "null" if value is None else "object"'),
    ("NaN accepted as JSON",
     "parsed = json.loads(text, parse_constant=reject_constant)",
     "parsed = json.loads(text)"),
    ("underscore not a word character",
     'return character == "_" or unicodedata.category(character)[0] in ("L", "N")',
     'return unicodedata.category(character)[0] in ("L", "N")'),
    ("Python whitespace after the fence",
     "while position < len(description) and description[position] in JS_WHITESPACE:",
     "while position < len(description) and description[position].isspace():"),
    ("byte order mark stripped",
     'text = content.decode("utf-8")',
     'text = content.decode("utf-8-sig")'),
    ("commitment not checked",
     'if keccak256(content) != claim["deliverableCommitment"]:',
     "if False:"),
    ("snapshot canonical form not checked",
     "if canonical_bytes(snapshot) != payload:",
     "if False:"),
    ("dependency pin not checked before parse",
     'if sha256(data) != dependency["sha256"]:',
     "if False:"),
    ("non-required dependencies resolved",
     '        if not dependency["requiredForRecomputation"]:\n            continue\n',
     ""),
    ("verdict agreement ignores evidenceHash",
     '        and verdict["evidenceHash"] == derived["evidenceHash"]\n',
     ""),
    ("zero weight accepted",
     'if not (_is_number(weight) and 0 < weight <= LIMITS["weight"]):',
     'if not (_is_number(weight) and 0 <= weight <= LIMITS["weight"]):'),
    ("http-endpoint in scope",
     'if any(check["kind"] not in IN_SCOPE_KINDS for check in criteria["checks"]):\n'
     '        raise GateRejected(GATE["criteria_scope"], "http-endpoint is outside v0: a recorded probe is not a reproduced probe")',
     "pass"),
    ("hidden input ignored",
     '    if hidden_inputs:\n        raise GateRejected(GATE["closure"], "outcome-relevant ambient input supplied")\n',
     ""),
    ("projection not checked",
     'if receipt["outcome"] != canonical_result["outcome"] or receipt["reasonCode"] != canonical_result["reasonCode"]:',
     "if False:"),
]


def gate(source: str, tag: str) -> str | None:
    """Run the gate with this adapter source; return why it failed, or None if it passed."""
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
        except Exception as error:  # any failure of the gate counts as a kill
            return f"{type(error).__name__}: {error}"
        return None


def main() -> int:
    sys.dont_write_bytecode = True
    control = gate(SOURCE, "control")
    if control is not None:
        print(f"control (unmutated adapter) failed: {control}")
        return 1
    survivors = 0
    for index, (name, old, new) in enumerate(MUTANTS):
        if SOURCE.count(old) != 1:
            print(f"mutant '{name}': its pattern occurs {SOURCE.count(old)} times in adapter.py, expected once")
            return 1
        failure = gate(SOURCE.replace(old, new), str(index))
        survivors += failure is None
        print("SURVIVED" if failure is None else "killed  ", name.ljust(40), (failure or "")[:110])
    print(f"{len(MUTANTS) - survivors} of {len(MUTANTS)} mutants killed")
    return 1 if survivors else 0


if __name__ == "__main__":
    raise SystemExit(main())
