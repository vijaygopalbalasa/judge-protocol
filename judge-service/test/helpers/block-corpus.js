// Job descriptions for testing where the judge-criteria block is found. The judge, the kit and the
// verifier each find it without the regular expression /```judge-criteria\s*([\s\S]*?)```/, which
// backtracks quadratically on an opening fence with no closing one, and each must still answer exactly
// as that expression does. The expression stays here as the oracle.

export const ORACLE = (description) => {
  const m = String(description ?? "").match(/```judge-criteria\s*([\s\S]*?)```/);
  return m ? m[1] : null;
};

const TOKENS = [
  "```", "```judge-criteria", "judge-criteria", "``", "`", " ", "\n", "\r\n", "\t", "\u00a0", "\u2028", "\u3000", "\ufeff",
  '{"checks":[{"kind":"length"}]}', '{"checks":[]}', "{", "}", '"', "x", "Judge", "judge-criteriax", "\u{1F600}",
];

/** `n` descriptions from a fixed seed (the same list on every run), plus hand-written edge cases. */
export function blockCorpus(n = 4000, seed = 20261001) {
  let s = seed >>> 0;
  const next = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0);
  const out = [
    "", "no block", "```judge-criteria", "```judge-criteria```", "```judge-criteria ```", "```judge-criteria\n{}\n```",
    "```judge-criteria\u00a0\u2028{}```", "``judge-criteria {}```", "```judge-criteria {} ``", "```judge-criteria {}````",
    "a ```judge-criteria {} ``` b ```judge-criteria [] ```", "```judge-criteria  \n\n  ```judge-criteria {}```",
    "```judge-criteria\ufeff{}```", "x```judge-criteria\t{\"a\":\"```\"}```",
  ];
  for (let i = 0; i < n; i++) {
    const len = next() % 14;
    let d = "";
    for (let j = 0; j < len; j++) d += TOKENS[next() % TOKENS.length];
    out.push(d);
  }
  return out;
}

/** A description the old expression takes seconds on: an opening fence, then only whitespace, no closing fence. */
export const SLOW_DESCRIPTION = "```judge-criteria" + " ".repeat(2_000_000);
