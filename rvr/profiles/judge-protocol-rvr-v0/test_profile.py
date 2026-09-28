"""Focused test for judge-protocol-rvr-v0.

Modeled, with changes, on the profile tests in pipavlo82/recomputable-verification-receipts
(commit 287c0ea, Apache License 2.0, see rvr/LICENSE-rvr-core-Apache-2.0).
"""
import json
import subprocess
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
ADAPTER = Path(__file__).with_name("adapter.py")


class JudgeProtocolProfileTests(unittest.TestCase):
    def test_exact_gate(self) -> None:
        completed = subprocess.run(
            [sys.executable, str(ADAPTER), "--check"],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        report = json.loads(completed.stdout)
        cases = report["cases"]
        self.assertEqual(report["gate"], "RVR_JUDGE_PROTOCOL_V0_PASS")
        self.assertEqual(cases["REPRODUCED"]["recomputationStatus"], "REPRODUCED")
        self.assertEqual(cases["REPRODUCED"]["verdictAgreement"], "MATCHES")
        self.assertEqual(cases["REFUTED_REPRODUCED"]["verdictAgreement"], "MATCHES")
        self.assertEqual(cases["DIVERGED"]["recomputationStatus"], "DIVERGED")
        self.assertEqual(cases["UNVERIFIABLE_REPRODUCED"]["recomputationStatus"], "REPRODUCED")
        self.assertEqual(cases["CANNOT_RECOMPUTE_PRECEDES_GATES"]["recomputationStatus"], "CANNOT_RECOMPUTE")
        self.assertEqual(cases["TAMPERED_PROFILE_CONSTRAINTS_PIN"]["recomputationStatus"], "CANNOT_RECOMPUTE")
        self.assertFalse(cases["TAMPERED_PROFILE_CONSTRAINTS_PIN"]["constraintsApplied"])
        self.assertFalse(cases["HIDDEN_STATE_NEGATIVE_CONTROL"]["evaluationPerformed"])
        self.assertEqual(cases["ONCHAIN_VERDICT_BOUNDARY"]["verdictAgreement"], "DIFFERS")
        self.assertEqual(cases["VERDICT_FIELD_CONTROLS"]["pass"], "DIFFERS")
        self.assertEqual(cases["VERDICT_FIELD_CONTROLS"]["timestamp"], "MATCHES")
        self.assertEqual(len(cases), 31)
        self.assertEqual(report["semanticCases"]["passed"], 31)
        self.assertEqual(report["gateCases"]["passed"], 74)
        self.assertEqual(report["byteContractVectors"]["passed"], 5)
        self.assertEqual(report["wordCharacterRanges"], 778)

if __name__ == "__main__":
    unittest.main()
