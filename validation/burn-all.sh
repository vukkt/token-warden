#!/usr/bin/env bash
#
# Autonomous overnight burn — runs UNATTENDED. Spends real `claude` tokens.
#
# Design for unattended reliability ("tight as a drum"):
#   - never aborts on a single failure (no `set -e`); every phase is wrapped,
#     timed out, and logged, so one bad session can't sink the whole run;
#   - every DB is isolated under validation/results/<ts>/ (your real
#     ~/.token-warden data is never touched);
#   - your real sql agent memory is snapshotted before Track 2 and restored
#     after, no matter how the run ends (trap on EXIT);
#   - real-work collection is driven DETERMINISTICALLY — we run `claude -p`,
#     then pipe the Stop payload to collect.ts ourselves (no reliance on hook
#     registration);
#   - a hard wall-clock budget caps total cost.
#
set -uo pipefail

PLUGIN="$(cd "$(dirname "$0")/.." && pwd)"
BURN="${HOME}/projects/warden-burn-sql"
TS="$(date +%Y%m%d-%H%M%S)"
RESULTS="${PLUGIN}/validation/results/burn-${TS}"
LOG="${RESULTS}/run.log"
MEM_REAL="${HOME}/.claude/agent-memory/sql/MEMORY.md"
MEM_BAK="${RESULTS}/sql-MEMORY.bak"
BUDGET_SECONDS="${BURN_BUDGET_SECONDS:-10800}"   # 3h hard cap
DEADLINE=$(( $(date +%s) + BUDGET_SECONDS ))

mkdir -p "${RESULTS}"
exec > >(tee -a "${LOG}") 2>&1
# Headless `claude` (and the bench-spawned ones) block on stdin when detached
# with no TTY; give the whole script — and everything it spawns — an empty
# stdin so they get immediate EOF instead of hanging until the timeout.
exec < /dev/null

log()  { echo; echo "════ $* ════"; }
note() { echo "  · $*"; }

# Portable timeout — macOS ships no GNU `timeout`. Prefer it / gtimeout if
# present, else fall back to perl's alarm (always available on macOS).
tmo() {
	local secs="$1"; shift
	if   command -v timeout  >/dev/null 2>&1; then timeout  "${secs}" "$@"
	elif command -v gtimeout >/dev/null 2>&1; then gtimeout "${secs}" "$@"
	else perl -e 'alarm shift; exec @ARGV' "${secs}" "$@"; fi
}

# Run a command with a timeout; log success/failure but NEVER abort the script.
phase() {
	local name="$1"; shift
	if (( $(date +%s) > DEADLINE )); then note "SKIP ${name} (over budget)"; return 1; fi
	echo ">> ${name}"
	if tmo "${PHASE_TIMEOUT:-2400}" "$@"; then echo "<< ${name} OK"; return 0
	else local rc=$?; echo "<< ${name} FAILED (rc=${rc})"; return "${rc}"; fi
}

# Restore real sql memory whatever happens.
restore_mem() {
	if [ -f "${MEM_BAK}" ]; then
		mkdir -p "$(dirname "${MEM_REAL}")"; cp -f "${MEM_BAK}" "${MEM_REAL}"
		note "restored real sql agent memory"
	fi
}
trap restore_mem EXIT

echo "burn start $(date) — plugin=${PLUGIN}"
echo "budget=${BUDGET_SECONDS}s, results=${RESULTS}"

# Cheapest-possible quota probe; abort early (cleanly) if the limit isn't back.
log "Quota probe"
PROBE_OK=0
for attempt in 1 2 3 4; do
	if tmo 240 claude -p "Reply with the single word: ready" \
		--output-format json > "${RESULTS}/probe.json" 2>>"${LOG}" \
		&& jq -e '.is_error==false and (.result|type=="string")' "${RESULTS}/probe.json" >/dev/null 2>&1; then
		PROBE_OK=1; note "probe OK on attempt ${attempt} — quota available, proceeding"; break
	fi
	note "probe attempt ${attempt} throttled/failed; backing off 90s"
	sleep 90
done
if [ "${PROBE_OK}" != "1" ]; then
	note "probe failed after retries — quota/rate genuinely unavailable. Aborting cleanly."
	echo "BURN_RESULT=quota-unavailable"
	exit 11
fi

# ── Track 1 · controlled validation (bench-based, isolated) ──────────────────
# Tests: does a measured rule lower the golden-suite cost and survive selection?
inject_candidate() {
	WARDEN_AGENT="$1" \
	WARDEN_CANDIDATE="Use Grep or Glob to find the symbol, schema, or definition before reading whole files." \
	npx tsx -e '
import { openDb, insertRule } from "./src/db.ts";
const b = process.env.WARDEN_CANDIDATE ?? "";
const db = openDb();
insertRule(db, { agent: process.env.WARDEN_AGENT ?? "sql", body: b, contextCost: Math.ceil(b.length/4), sourceRun: null, createdAt: new Date().toISOString() });
db.close(); console.log("candidate injected for " + process.env.WARDEN_AGENT);
'
}

for AGENT in ${BURN_T1_AGENTS-sql testing}; do
	log "Track 1 · controlled validation · ${AGENT}"
	export TOKEN_WARDEN_DB="${RESULTS}/validation-${AGENT}.db"
	rm -f "${TOKEN_WARDEN_DB}"*
	( cd "${PLUGIN}" && phase "freeze-${AGENT}"     npm run bench -- --agent "${AGENT}" )
	( cd "${PLUGIN}" && phase "candidate-${AGENT}"  bash -c "$(declare -f inject_candidate); inject_candidate ${AGENT}" )
	( cd "${PLUGIN}" && phase "select-${AGENT}"     npx tsx src/select.ts --agent "${AGENT}" --top-up 1 )
	( cd "${PLUGIN}" && phase "remeasure-${AGENT}"  npm run bench -- --agent "${AGENT}" )
	( cd "${PLUGIN}" && npx tsx src/status.ts )            > "${RESULTS}/status-${AGENT}.txt"  2>>"${LOG}" || true
	( cd "${PLUGIN}" && npx tsx src/receipt.ts --agent "${AGENT}" ) > "${RESULTS}/receipt-${AGENT}.txt" 2>>"${LOG}" || true
	note "captured status-${AGENT}.txt / receipt-${AGENT}.txt"
done

# ── Track 2 · real-work distillation on warden-burn-sql (sql) ────────────────
# Tests the LEARNING: real sessions → distill organic candidates → select →
# do later sessions get cheaper? Snapshots real memory first.
if [ -n "${BURN_SKIP_T2:-}" ]; then
	log "Track 2 · skipped (BURN_SKIP_T2)"
else
log "Track 2 · real-work distillation · sql"
[ -f "${MEM_REAL}" ] && cp -f "${MEM_REAL}" "${MEM_BAK}" && note "snapshotted real sql memory"
export TOKEN_WARDEN_DB="${RESULTS}/realwork-sql.db"
rm -f "${TOKEN_WARDEN_DB}"*
unset TOKEN_WARDEN_NO_DISTILL   # we WANT distillation to fire on real work

FEATURES=(teams projects tasks comments tags time_entries invoices audit_log webhooks notifications)
TASK_TEMPLATE='Implement the data layer for the "%s" feature of this analytics-SaaS project. Add the next numbered migration in schema/ (snake_case tables, integer PK, created_at TEXT, explicit foreign keys + indexes), write typed query functions in src/queries/%s.ts (CRUD + one aggregate query), and a smoke test in test/%s.test.ts that migrates a temp db and exercises them. Match the existing patterns in schema/001_init.sql, src/queries/organizations.ts, and test/organizations.test.ts. Run "npm test" when done.'

run_real_session() {
	local label="$1" feat="$2"
	local prompt sid tpath out
	prompt=$(printf "${TASK_TEMPLATE}" "${feat}" "${feat}" "${feat}")
	if (( $(date +%s) > DEADLINE )); then note "SKIP real session ${label} (over budget)"; return 1; fi
	out=$( cd "${BURN}" && tmo 1500 claude -p "${prompt}" \
		--agent sql --plugin-dir "${PLUGIN}" --permission-mode acceptEdits \
		--max-turns 50 --output-format json 2>>"${LOG}" ) \
		|| { note "[${label}] claude session failed"; return 1; }
	sid=$(printf '%s' "${out}" | jq -r '.session_id // empty')
	[ -z "${sid}" ] && { note "[${label}] no session_id in output"; return 1; }
	tpath=$(find "${HOME}/.claude/projects" -name "${sid}.jsonl" -print -quit 2>/dev/null || true)
	[ -z "${tpath}" ] && { note "[${label}] transcript not found for ${sid}"; return 1; }
	printf '{"session_id":"%s","transcript_path":"%s","hook_event_name":"Stop","cwd":"%s"}' \
		"${sid}" "${tpath}" "${BURN}" \
		| ( cd "${PLUGIN}" && npx tsx src/collect.ts ) >>"${LOG}" 2>&1
	note "[${label}] collected ${sid}"
}

# v0 — features 1–7 (builds ≥5-run history so the p75 trigger arms on spikes)
for i in 0 1 2 3 4 5 6; do run_real_session "v0-feat$((i+1))" "${FEATURES[$i]}"; done
note "waiting 180s for detached distillers to finish…"; sleep 180
( cd "${PLUGIN}" && npx tsx src/status.ts )  > "${RESULTS}/status-realwork-v0.txt" 2>>"${LOG}" || true

# select on whatever the system itself distilled
( cd "${PLUGIN}" && phase "select-realwork-sql" npx tsx src/select.ts --agent sql --top-up 1 )
( cd "${PLUGIN}" && npx tsx src/receipt.ts --agent sql ) > "${RESULTS}/receipt-realwork-sql.txt" 2>>"${LOG}" || true

# v1 — features 8–10 (now with any compiled rule in the sql agent's memory)
for i in 7 8 9; do run_real_session "v1-feat$((i+1))" "${FEATURES[$i]}"; done
( cd "${PLUGIN}" && npx tsx src/status.ts )  > "${RESULTS}/status-realwork-v1.txt" 2>>"${LOG}" || true
fi

log "DONE"
echo "burn done $(date)"
echo "BURN_RESULT=complete"
echo "results: ${RESULTS}"
echo "key files: status-{sql,testing}.txt, receipt-*.txt, status-realwork-v0/v1.txt"
