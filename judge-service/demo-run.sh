#!/bin/bash
# Scripted demo: post a real ERC-8183 job on Circle's canonical Arc contract,
# let Judge Protocol settle it, then independently recompute the verdict.
# Used to produce the shareable demo recording.
set -e
cd "$(dirname "$0")"

say() { printf '\033[1;36m%s\033[0m\n' "$1"; sleep 1.2; }
run() { printf '\033[1;32m$ %s\033[0m\n' "$1"; sleep 0.8; eval "$1"; }

clear 2>/dev/null || true
say "# Judge Protocol: deterministic evaluator for ERC-8183 agent escrow"
say "# Live on Arc testnet. Judging a real job on Circle's canonical contract."
echo
say "## Step 1: post a job, provider delivers, judge settles the escrow"
run "node --env-file=.env src/e2e.js"
echo
sleep 1
say "## Step 2: now recompute that verdict from PUBLIC inputs only"
say "##         (anyone can do this; no access to the judge needed)"
JOB=$(ls -t evidence/ | head -1 | sed -E 's/job-([0-9]+)-.*/\1/')
EV=$(ls -t evidence/ | head -1)
run "node --env-file=.env src/verify.js $JOB --evidence evidence/$EV"
echo
say "# The judge cannot lie without being caught. That's the whole point."
sleep 2
