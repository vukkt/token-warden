/**
 * EMPIRICAL CALIBRATION — false-positive rate and power under the REAL noise.
 *
 * The synthetic harness (validation/calibration.ts) assumes a noise model
 * (Gaussian, or Gaussian plus derailments). This harness drops that assumption:
 * it resamples RECORDED golden runs — genuine replicates that executed the
 * identical (task, ruleset version, model) configuration — through the real
 * verdict pipeline (`assessDelta` + `verdict` + top-up). Zero tokens: every
 * "run" is a token total already sitting in the runs table.
 *
 * Two resampling schemes, and what each honestly claims:
 *
 * A/A PERMUTATION — per task, shuffle the replicate pool and deal the first
 * `runs` totals to the "without" side and the next `runs` to the "with" side.
 * Both sides come from the same pool, so the true delta is 0 BY CONSTRUCTION
 * and the runs are exchangeable under that null — no distributional assumption
 * at all for the initial split. The keep rate over many trials IS the
 * empirical false-positive rate of candidate promotion on this agent's real
 * run-to-run noise. One hybrid step: when a trial lands uncertain, the real
 * selector spends a top-up pass, so the trial resolves it by drawing extra
 * runs WITH replacement from the replicates NOT used in the initial split
 * (bootstrap, not permutation). Counting uncertain trials as evictions instead
 * would understate the false-positive rate, because the real pipeline gets a
 * second look before deciding.
 *
 * BOOTSTRAP — per task, draw both sides WITH replacement from the pool, then
 * subtract a KNOWN injected saving from every with-side draw. injected=0 is a
 * bootstrap A/A (cross-check of the permutation); injected>0 is semi-synthetic
 * POWER: how often a rule with that true effect survives under the recorded
 * noise distribution. Top-ups are more with-replacement draws, placed by the
 * real `allocateTopUpRuns` when it yields an allocation.
 *
 * The Wilson interval printed next to each keep rate covers Monte-Carlo
 * resampling error only — NOT the sampling variability of the underlying pool
 * (a handful of recorded runs is still a handful of runs).
 *
 * Note: `openDb()` runs pending schema migrations on open (append-only, the
 * same as any warden command); the harness itself only SELECTs.
 *
 *   npx tsx validation/empirical-calibration.ts [--agent <name>] [--db <path>]
 *     [--mode permutation|bootstrap|both] [--trials N] [--runs N] [--rent N]
 *     [--seed N]
 */
import { pathToFileURL } from "node:url";
import { summarizeTask, type TaskSummary } from "../src/bench.js";
import {
	type GoldenReplicateRun,
	goldenReplicateRuns,
	openDb,
} from "../src/db.js";
import {
	allocateTopUpRuns,
	assessDelta,
	confidenceZ,
	effectiveRent,
	mergeSummaries,
	verdict,
} from "../src/select.js";
import { DOMAIN_AGENTS } from "../src/types.js";

const DEFAULT_TRIALS = 2000;
/** Permutation deals 2×runs distinct totals per trial, so pools of ≥4 qualify
 * at the default; bootstrap resamples with replacement and can afford the
 * selector's default of 3 runs per side. */
const DEFAULT_PERM_RUNS = 2;
const DEFAULT_BOOT_RUNS = 3;
const DEFAULT_RENT = 25;
const DEFAULT_SEED = 42;
const INJECTED_FRACS = [0, 0.02, 0.05, 0.1, 0.2];

/** Deterministic PRNG (mulberry32). Duplicated from validation/calibration.ts
 * on purpose: that file executes its report on import (unconditional
 * `process.exit(main())`), so nothing can be imported from it. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export interface ReplicateGroup {
	taskId: string;
	totals: number[];
}

/**
 * Group recorded runs into replicate pools. Runs sharing
 * `taskHash|rulesetVersion|model` executed the IDENTICAL configuration —
 * genuine repeated measurements of one distribution, hence exchangeable under
 * the null. A task may appear at most once per simulated suite, so per
 * taskHash only the single largest group survives (ties resolve to the first
 * key in sorted order, for determinism); groups with fewer than `minRuns`
 * totals are dropped. Sorted by taskId.
 */
export function groupReplicates(
	rows: GoldenReplicateRun[],
	minRuns: number,
): ReplicateGroup[] {
	const byKey = new Map<string, { taskId: string; totals: number[] }>();
	for (const row of rows) {
		const key = `${row.taskHash}|${row.rulesetVersion}|${row.model}`;
		const group = byKey.get(key);
		if (group) group.totals.push(row.total);
		else byKey.set(key, { taskId: row.taskHash, totals: [row.total] });
	}
	const bestByTask = new Map<string, ReplicateGroup>();
	for (const key of [...byKey.keys()].sort()) {
		const group = byKey.get(key) as { taskId: string; totals: number[] };
		const current = bestByTask.get(group.taskId);
		if (!current || group.totals.length > current.totals.length) {
			bestByTask.set(group.taskId, group);
		}
	}
	return [...bestByTask.values()]
		.filter((g) => g.totals.length >= minRuns)
		.sort((a, b) => a.taskId.localeCompare(b.taskId));
}

/** In-place Fisher-Yates on a copy. */
function shuffled(rng: () => number, xs: number[]): number[] {
	const out = [...xs];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		const tmp = out[i] as number;
		out[i] = out[j] as number;
		out[j] = tmp;
	}
	return out;
}

/** n draws WITH replacement. */
function resample(rng: () => number, pool: number[], n: number): number[] {
	const out: number[] = [];
	for (let i = 0; i < n; i++) {
		out.push(pool[Math.floor(rng() * pool.length)] as number);
	}
	return out;
}

/** Wrap raw token totals as a completed-run task summary; `tag` keeps
 * sessionIds unique across the sides and top-up passes of one trial (merged
 * summaries concatenate result lists). */
function toSummary(taskId: string, totals: number[], tag: string): TaskSummary {
	return summarizeTask(
		taskId,
		totals.map((tokens, i) => ({
			sessionId: `${taskId}-${tag}-${i}`,
			tokens,
			completed: true,
		})),
	);
}

/**
 * The selector's candidate-promotion logic, on the real functions: not a
 * regression, measurable, and — after at most one top-up pass when the first
 * assessment is uncertain — confidently clearing the 2×-rent bar. Mirrors
 * `selectForAgent`'s decide() path for candidates (evict-when-uncertain).
 */
export function candidateKept(
	without: TaskSummary[],
	withRule: TaskSummary[],
	rent: number,
	topUp: ((measured: TaskSummary[]) => TaskSummary[] | null) | null,
): boolean {
	let a = assessDelta(without, withRule, rent);
	if (a.regression || a.delta === null) return false;
	if (a.uncertain && topUp !== null) {
		const extra = topUp(withRule);
		if (extra) {
			const merged = mergeSummaries(withRule, extra);
			a = assessDelta(without, merged, rent);
		}
	}
	return (
		!a.uncertain &&
		a.delta !== null &&
		verdict({ measuredDelta: a.delta, contextCost: rent }) === "active"
	);
}

/**
 * One A/A permutation trial. Exchangeable split (true delta 0 by
 * construction); uncertain verdicts get the hybrid bootstrap top-up from the
 * held-out replicates (see header). Returns whether the null rule was KEPT —
 * a false positive.
 */
export function permutationTrial(
	rng: () => number,
	groups: ReplicateGroup[],
	runsPerSide: number,
	rent: number,
): boolean {
	const without: TaskSummary[] = [];
	const withRule: TaskSummary[] = [];
	const heldOut = new Map<string, number[]>();
	for (const group of groups) {
		const deck = shuffled(rng, group.totals);
		without.push(toSummary(group.taskId, deck.slice(0, runsPerSide), "w"));
		withRule.push(
			toSummary(group.taskId, deck.slice(runsPerSide, 2 * runsPerSide), "m"),
		);
		// Top-up pool: the replicates NOT dealt into the initial split, so the
		// second look brings genuinely new information (as a real top-up does).
		// With fewer than 2 held-out runs there is no pool worth the name — fall
		// back to the whole group.
		const rest = deck.slice(2 * runsPerSide);
		heldOut.set(group.taskId, rest.length >= 2 ? rest : group.totals);
	}
	const topUp = (): TaskSummary[] =>
		groups.map((group) =>
			toSummary(
				group.taskId,
				resample(rng, heldOut.get(group.taskId) ?? group.totals, runsPerSide),
				"t",
			),
		);
	return candidateKept(without, withRule, rent, topUp);
}

/**
 * One bootstrap trial: both sides drawn with replacement from the pool, a
 * known `injectedSaving` subtracted from every with-side draw (floored at 0 —
 * a run cannot cost negative tokens). injectedSaving=0 is the bootstrap A/A;
 * injectedSaving>0 measures POWER under the recorded noise. The top-up is
 * more with-replacement draws, placed by the real Neyman allocator when it
 * returns an allocation (uniform runsPerSide per task otherwise).
 */
export function bootstrapTrial(
	rng: () => number,
	groups: ReplicateGroup[],
	runsPerSide: number,
	rent: number,
	injectedSaving: number,
): boolean {
	const drawWith = (group: ReplicateGroup, n: number): number[] =>
		resample(rng, group.totals, n).map((t) => Math.max(0, t - injectedSaving));
	const without = groups.map((group) =>
		toSummary(group.taskId, resample(rng, group.totals, runsPerSide), "w"),
	);
	const withRule = groups.map((group) =>
		toSummary(group.taskId, drawWith(group, runsPerSide), "m"),
	);
	const topUp = (measured: TaskSummary[]): TaskSummary[] | null => {
		// Same budget as the real selector's top-up: one full duplicate pass of
		// the measured side, poured into the high-variance tasks by Neyman.
		const budget = measured.reduce((sum, s) => sum + s.results.length, 0);
		const allocation = allocateTopUpRuns(without, measured, budget);
		const extra: TaskSummary[] = [];
		for (const group of groups) {
			const n = allocation ? (allocation.get(group.taskId) ?? 0) : runsPerSide;
			if (n > 0) extra.push(toSummary(group.taskId, drawWith(group, n), "t"));
		}
		return extra.length > 0 ? extra : null;
	};
	return candidateKept(without, withRule, rent, topUp);
}

/**
 * 95% Wilson score interval for a Monte-Carlo keep rate (z=1.96). Covers the
 * resampling error of the trial count only — it says nothing about how well
 * the small recorded pool represents the agent's true noise distribution.
 */
export function wilson(k: number, n: number): { lo: number; hi: number } {
	if (n <= 0) return { lo: 0, hi: 1 };
	const z = 1.96;
	const p = k / n;
	const z2n = z ** 2 / n;
	const center = (p + z2n / 2) / (1 + z2n);
	const half =
		(z * Math.sqrt((p * (1 - p)) / n + z ** 2 / (4 * n ** 2))) / (1 + z2n);
	return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

export type CalibrationMode = "permutation" | "bootstrap" | "both";

export interface EmpiricalArgs {
	agent: string | null;
	dbPath: string | null;
	mode: CalibrationMode;
	trials: number;
	permRuns: number;
	bootRuns: number;
	rent: number;
	seed: number;
}

export function parseEmpiricalArgs(argv: string[]): EmpiricalArgs {
	const args: EmpiricalArgs = {
		agent: null,
		dbPath: null,
		mode: "both",
		trials: DEFAULT_TRIALS,
		permRuns: DEFAULT_PERM_RUNS,
		bootRuns: DEFAULT_BOOT_RUNS,
		rent: DEFAULT_RENT,
		seed: DEFAULT_SEED,
	};
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === "--agent") {
			const agent = argv[++i] ?? "";
			if (!(DOMAIN_AGENTS as readonly string[]).includes(agent)) {
				throw new Error(
					`--agent must be one of: ${DOMAIN_AGENTS.join(", ")} (got "${agent}")`,
				);
			}
			args.agent = agent;
		} else if (flag === "--db") {
			const path = argv[++i];
			if (!path) throw new Error("--db requires a path");
			args.dbPath = path;
		} else if (flag === "--mode") {
			const mode = argv[++i] ?? "";
			if (mode !== "permutation" && mode !== "bootstrap" && mode !== "both") {
				throw new Error(
					`--mode must be permutation, bootstrap, or both (got "${mode}")`,
				);
			}
			args.mode = mode;
		} else if (flag === "--trials") {
			const n = Number(argv[++i]);
			if (!Number.isInteger(n) || n < 1) {
				throw new Error("--trials must be a positive integer");
			}
			args.trials = n;
		} else if (flag === "--runs") {
			const n = Number(argv[++i]);
			if (!Number.isInteger(n) || n < 1) {
				throw new Error("--runs must be a positive integer");
			}
			args.permRuns = n;
			args.bootRuns = n;
		} else if (flag === "--rent") {
			const n = Number(argv[++i]);
			if (!Number.isFinite(n) || n <= 0) {
				throw new Error("--rent must be a positive number");
			}
			args.rent = n;
		} else if (flag === "--seed") {
			const n = Number(argv[++i]);
			if (!Number.isInteger(n)) throw new Error("--seed must be an integer");
			args.seed = n;
		} else {
			throw new Error(`unknown flag: ${flag}`);
		}
	}
	return args;
}

function pct(x: number): string {
	return `${(x * 100).toFixed(1)}%`;
}

function ci(k: number, n: number): string {
	const w = wilson(k, n);
	return `${pct(k / n)} [${pct(w.lo)}, ${pct(w.hi)}]`;
}

const INSUFFICIENT =
	"insufficient replicate history (need >= 2 tasks with >= 2x runs-per-side completed active-set runs at one ruleset version)";

function reportAgent(
	agent: string,
	groups: ReplicateGroup[],
	args: EmpiricalArgs,
	agentSeed: number,
): void {
	console.log(`\n=== agent: ${agent} ===`);
	const permEligible = groups.filter(
		(g) => g.totals.length >= 2 * args.permRuns,
	);
	const bootEligible = groups.filter(
		(g) => g.totals.length >= 2 * args.bootRuns,
	);
	if (groups.length < 2) {
		console.log(INSUFFICIENT);
		return;
	}
	console.log(
		["task".padEnd(24), "runs".padStart(5), "mean tok".padStart(10)].join("  "),
	);
	for (const g of groups) {
		const m = g.totals.reduce((a, b) => a + b, 0) / g.totals.length;
		console.log(
			[
				g.taskId.padEnd(24),
				String(g.totals.length).padStart(5),
				String(Math.round(m)).padStart(10),
			].join("  "),
		);
	}

	if (args.mode !== "bootstrap") {
		if (permEligible.length < 2) {
			console.log(`permutation A/A: ${INSUFFICIENT}`);
		} else {
			const rng = mulberry32(agentSeed ^ 0x5eed);
			let kept = 0;
			for (let i = 0; i < args.trials; i++) {
				if (permutationTrial(rng, permEligible, args.permRuns, args.rent)) {
					kept++;
				}
			}
			console.log(
				`permutation A/A (runs=${args.permRuns}/side, ${permEligible.length} tasks, ${args.trials} trials): ` +
					`keep rate ${ci(kept, args.trials)} — empirical false-positive rate`,
			);
		}
	}

	if (args.mode !== "permutation") {
		if (bootEligible.length < 2) {
			console.log(`bootstrap: ${INSUFFICIENT}`);
		} else {
			const all = bootEligible.flatMap((g) => g.totals);
			const pooledMean = all.reduce((a, b) => a + b, 0) / all.length;
			console.log(
				`bootstrap (runs=${args.bootRuns}/side, ${bootEligible.length} tasks, ${args.trials} trials/row, pooled mean ${Math.round(pooledMean)} tok):`,
			);
			console.log(
				[
					"injected saving".padStart(20),
					"keep rate [95% CI]".padStart(26),
				].join("  "),
			);
			for (const frac of INJECTED_FRACS) {
				const injected = Math.round(pooledMean * frac);
				const rng = mulberry32(agentSeed ^ (0xb00 + Math.round(frac * 1000)));
				let kept = 0;
				for (let i = 0; i < args.trials; i++) {
					if (
						bootstrapTrial(
							rng,
							bootEligible,
							args.bootRuns,
							args.rent,
							injected,
						)
					) {
						kept++;
					}
				}
				const tag =
					frac === 0 ? "0 (A/A: FP)" : `${pct(frac)} (${injected} tok)`;
				console.log(
					[tag.padStart(20), ci(kept, args.trials).padStart(26)].join("  "),
				);
			}
		}
	}
}

export function main(argv: string[]): number {
	const args = parseEmpiricalArgs(argv);
	const agents = args.agent ? [args.agent] : [...DOMAIN_AGENTS];
	const db = args.dbPath ? openDb(args.dbPath) : openDb();
	try {
		const bar = Math.ceil(2 * effectiveRent(args.rent));
		console.log(
			"=== token-warden empirical calibration (recorded runs, zero tokens) ===",
		);
		console.log(
			`rent ${args.rent} (2x cache-aware bar ~${bar} tok) · confidence z=${confidenceZ()} · seed ${args.seed} · mode ${args.mode}`,
		);
		// The eligibility floor is the loosest active mode's requirement; each
		// mode re-filters to its own 2×runs floor before simulating.
		const minRuns =
			2 *
			(args.mode === "permutation"
				? args.permRuns
				: args.mode === "bootstrap"
					? args.bootRuns
					: Math.min(args.permRuns, args.bootRuns));
		agents.forEach((agent, idx) => {
			const groups = groupReplicates(goldenReplicateRuns(db, agent), minRuns);
			reportAgent(agent, groups, args, args.seed + idx * 7919);
		});
		console.log(
			"\nRead: the 0-saving rows (permutation A/A and bootstrap injected=0) are the empirical false-positive rate of candidate promotion under the agent's REAL recorded run-to-run noise — no Gaussian assumption. Compare against the synthetic harness's ~2-3% claim at z=2 (validation/calibration.ts): agreement means the noise model there is adequate; a higher empirical rate means real noise is nastier than modeled. The injected-saving rows are power: how big a true saving must be before the pipeline reliably keeps it on this data.",
		);
		return 0;
	} finally {
		db.close();
	}
}

/* v8 ignore start -- CLI entry shim, exercised by e2e subprocess smoke */
const invokedDirectly =
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
	try {
		process.exit(main(process.argv.slice(2)));
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}
/* v8 ignore stop */
