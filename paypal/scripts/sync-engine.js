// Copies Judge Protocol's checking engine (judge-service/src) and the browser verifier's recompute code (web/) into
// this app, byte for byte, so a Vercel deployment rooted at paypal/ carries exactly the code that settles escrow on
// Arc. test/engine-sync.test.js fails if a copy ever drifts from its source: run this script, never edit the copies.
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");

/** [source relative to the repo, copy relative to paypal/] */
export const ENGINE_FILES = [
  ["judge-service/src/evaluate.js", "engine/evaluate.js"],
  ["judge-service/src/criteria.js", "engine/criteria.js"],
  ["judge-service/src/evidence.js", "engine/evidence.js"],
  ["judge-service/src/config.js", "engine/config.js"],
  ["judge-service/src/safe-fetch.js", "engine/safe-fetch.js"],
  ["judge-service/src/checkers/index.js", "engine/checkers/index.js"],
  ["judge-service/src/checkers/json-shape.js", "engine/checkers/json-shape.js"],
  ["judge-service/src/checkers/word-characters.js", "engine/checkers/word-characters.js"],
  ["web/app.js", "public/verify/app.js"],
  ["web/json-shape.js", "public/verify/json-shape.js"],
  ["web/word-characters.js", "public/verify/word-characters.js"],
  ...readdirSync(join(repo, "web/vendor/noble")).filter((f) => f.endsWith(".js") || f === "LICENSE")
    .map((f) => [`web/vendor/noble/${f}`, `public/verify/vendor/noble/${f}`]),
];

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const [from, to] of ENGINE_FILES) {
    mkdirSync(dirname(join(here, "..", to)), { recursive: true });
    copyFileSync(join(repo, from), join(here, "..", to));
  }
  console.log(`copied ${ENGINE_FILES.length} files`);
}
