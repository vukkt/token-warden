#!/usr/bin/env bash
#
# token-warden validation harness — see validation/README.md.
# Runs the REAL benchmark loop on one agent against an ISOLATED database, so
# your real ~/.token-warden data is never touched. Spends real `claude` tokens.
#
set -euo pipefail

cd "$(dirname "$0")/.."
AGENT="${1:-sql}"
export TOKEN_WARDEN_DB="$(pwd)/validation/warden-${AGENT}.db"

echo "════════════════════════════════════════════════════════════════"
echo " token-warden validation — agent=${AGENT}"
echo " isolated DB: ${TOKEN_WARDEN_DB}"
echo "════════════════════════════════════════════════════════════════"
echo
echo "This spends real claude tokens (~15–30 headless sessions). Ctrl-C to abort."
echo "Press Enter to begin."
read -r _

# Start clean so the run is reproducible.
rm -f "${TOKEN_WARDEN_DB}"*

echo
echo "── Stage 1/5 · Freeze baselines (run1 — the permanent denominator) ──"
npm run bench -- --agent "${AGENT}"

echo
echo "── Stage 2/5 · Introduce a candidate efficiency rule ──"
# Curated, plausible, generalizable candidate. Override with WARDEN_CANDIDATE,
# or skip this stage and instead do real work with the agent so distillation
# produces one. Values pass via env (no inline-quoting hazards).
export WARDEN_AGENT="${AGENT}"
export WARDEN_CANDIDATE="${WARDEN_CANDIDATE:-Use Grep or Glob to locate the relevant symbol or file before reading whole files.}"
npx tsx -e '
import { openDb, insertRule } from "./src/db.ts";
const body = process.env.WARDEN_CANDIDATE ?? "";
const db = openDb();
const id = insertRule(db, {
  agent: process.env.WARDEN_AGENT ?? "sql",
  body,
  contextCost: Math.ceil(body.length / 4),
  sourceRun: null,
  createdAt: new Date().toISOString(),
});
console.log("inserted candidate rule #" + id + ": " + body);
db.close();
'

echo
echo "── Stage 3/5 · Select (measure with vs. without; keep only if it earns) ──"
npx tsx src/select.ts --agent "${AGENT}" --top-up 1

echo
echo "── Stage 4/5 · Re-measure the suite with surviving rules compiled in ──"
npm run bench -- --agent "${AGENT}"

echo
echo "── Stage 5/5 · Report ──"
echo
echo "=== /warden-status (look at 'suite now vs run1 (frozen)' for ${AGENT}) ==="
npx tsx src/status.ts
echo
echo "=== /warden-receipt ${AGENT} (the per-rule evidence) ==="
npx tsx src/receipt.ts --agent "${AGENT}"

echo
echo "════════════════════════════════════════════════════════════════"
echo " VERDICT"
echo "════════════════════════════════════════════════════════════════"
# Read the isolated DB directly and print the one-line answer: did any
# candidate survive selection, or were they all evicted?
WARDEN_AGENT="${AGENT}" npx tsx -e '
import { openDb, getActiveRules, lastEvictions } from "./src/db.ts";
const agent = process.env.WARDEN_AGENT ?? "sql";
const db = openDb();
const living = getActiveRules(db, agent);
const evicted = lastEvictions(db, agent, 10);
db.close();
if (living.length > 0) {
  console.log(`🟢 LIVING RULE — ${living.length} rule(s) survived selection for "${agent}":`);
  for (const r of living) console.log(`   • [+${r.measured_delta} tok] ${r.body}`);
  console.log(`\n   Cross-check the headline in /warden-status: suite "now vs run1" should be NEGATIVE.`);
} else {
  console.log(`🔴 ALL EVICTED — no candidate cleared 2x rent for "${agent}"; nothing was kept.`);
  if (evicted.length > 0) {
    console.log(`   Most recent eviction reason: ${evicted[0].decided_reason ?? "(none recorded)"}`);
  }
  console.log(`\n   This is a valid result, not a failure — see validation/README.md.`);
}
'
echo "════════════════════════════════════════════════════════════════"
