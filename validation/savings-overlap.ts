/**
 * CAN THE PACKER'S REDUNDANCY SIGNAL BE MEASURED INSTEAD OF GUESSED?
 *
 * `memory.ts#packToBudget` feeds the submodular packer TRIGRAM OVERLAP between
 * rule bodies, and both that function and `knapsack.ts` say the same thing about
 * it: textual similarity is a PROXY for savings overlap, and the reason it is
 * still a proxy is "measuring real pairwise savings overlap is a token burn
 * nobody has run".
 *
 * THE CLAIM THIS HARNESS TESTS. That sentence contains a hidden assumption --
 * that the only thing standing between the project and a measured signal is
 * money. It is not obviously true. The `runs` table already holds hundreds of
 * per-task token totals tagged with agent, task, ruleset version and config, so
 * a rule's per-task SAVING PROFILE -- a vector over tasks of (without-rule cost
 * minus with-rule cost) -- looks derivable from runs that were already paid
 * for. Two rules that save on the SAME tasks are redundant in the way the
 * facility-location objective actually cares about; two rules that save on
 * DISJOINT tasks are complementary however alike they read.
 *
 * So: derive those vectors from the recorded pool, and see whether the overlap
 * between them is a signal or an artifact. Zero tokens, no subprocess, and the
 * ledger is opened READ-ONLY (never `openDb`, which would run migrations
 * against the user's real file).
 *
 * WHAT IT REPORTS, in the order the question has to be answered.
 *
 * 1. ATTRIBUTION. `runs` has no rule column. A candidate pass is tied to the
 *    rule it measured only by lying between two `rules.decided_at` stamps, so
 *    every vector below rests on archaeology rather than on a recorded fact.
 *    The audit prints, per rule, whether its pass is recoverable AT ALL, and
 *    validates each recovery by re-deriving the mean saving and comparing it to
 *    the `measured_delta` the selector actually banked. A pass that does not
 *    reproduce its own verdict is reported as NOT separable and is dropped.
 *
 * 2. OVERLAP. For the rules that survive step 1, the measured cosine between
 *    saving vectors next to the trigram similarity between bodies -- the
 *    comparison the whole idea rests on.
 *
 * 3. THE NULL. A permutation null in which NEITHER rule has any effect: within
 *    a task, all recorded runs are exchangeable, so re-split them into groups
 *    of the recorded sizes and recompute the cosine. This is the same
 *    methodology `validation/empirical-calibration.ts` uses on the verdict path.
 *
 * 4. DEPTH. What a purpose-built burn would have to buy, given that step 3
 *    reports the recorded pool cannot answer the question.
 *
 * THE STRUCTURAL RESULT, which is the part worth reading. Every rule is
 * measured against a SHARED baseline pass, so its saving vector is
 * `s_r,t = true_r,t + (e_W,t - e_r,t)` and the baseline error `e_W,t` is the
 * SAME TERM in every rule's vector. Under a null where no rule does anything,
 *
 *     cov(s_A,t, s_B,t) = Var(e_W,t)     Var(s_r,t) = Var(e_W,t) + Var(e_r,t)
 *
 * and with equal run depth on every side that is a correlation of exactly 1/2 --
 * INDEPENDENT OF THE NUMBER OF RUNS, because more runs shrink both terms by the
 * same factor. Two rules that do nothing at all look half-redundant however long
 * the burn. `SHARED_BASELINE_NULL_CORRELATION` pins that constant and the depth
 * sweep in step 4 demonstrates it does not decay.
 *
 * Run it:
 *   cp ~/.token-warden/warden.db /tmp/ledger.db   # never point it at the original
 *   npx tsx validation/savings-overlap.ts --db /tmp/ledger.db --agent sql
 */

import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { type RunResult, summarizeTask } from "../src/bench.js";
import { defaultDbPath } from "../src/db.js";
import { trigramSimilarity } from "../src/rules.js";
import { mulberry32, shuffled } from "./rng.js";

// ---------------------------------------------------------------------------
// The recorded pool
// ---------------------------------------------------------------------------

/** One recorded golden run, as this harness needs it. */
export interface LedgerRun {
	taskId: string;
	config: string;
	rulesetVersion: number;
	completed: boolean;
	ts: string;
	tokens: number;
}

/** One rule with the verdict the selector banked for it. */
export interface LedgerRule {
	id: number;
	body: string;
	status: string;
	measuredDelta: number | null;
	decidedAt: string | null;
}

/**
 * A contiguous stretch of runs sharing one (config, ruleset version).
 *
 * The unit matters: the selector runs a baseline pass, then one candidate pass
 * per rule, then any re-audit, back to back. Contiguity in the run log is the
 * only thing that separates them, since no column does.
 */
export interface RunBlock {
	config: string;
	rulesetVersion: number;
	start: string;
	end: string;
	runs: LedgerRun[];
}

/** How close a block's last run must sit to `decided_at` to be that rule's
 * measurement pass. The selector writes the verdict immediately after the last
 * run returns, so the real gap is milliseconds; two seconds is slack, not a
 * search window. */
const DECISION_GAP_MS = 2_000;

/**
 * Cut the run log into passes.
 *
 * A change of (config, ruleset version) always starts a new block. So does a
 * decision boundary INSIDE a block: the selector benchmarks candidate A, banks
 * its verdict, and benchmarks candidate B without anything on the rows changing,
 * so two consecutive candidate passes are one contiguous stretch of identical
 * rows. Cutting at `decided_at` is what separates them, and it is the strongest
 * attribution the schema permits -- which is the point being tested, so it is
 * built at full strength rather than conceded.
 */
export function toBlocks(
	runs: readonly LedgerRun[],
	decisions: readonly string[] = [],
): RunBlock[] {
	const ordered = [...runs].sort((a, b) => a.ts.localeCompare(b.ts));
	const cuts = [...decisions].map((d) => Date.parse(d)).sort((a, b) => a - b);
	const blocks: RunBlock[] = [];
	for (const run of ordered) {
		const last = blocks.at(-1);
		const crossesDecision =
			last !== undefined &&
			cuts.some(
				(cut) =>
					Date.parse(last.end) <= cut + DECISION_GAP_MS &&
					cut + DECISION_GAP_MS < Date.parse(run.ts),
			);
		if (
			last &&
			!crossesDecision &&
			last.config === run.config &&
			last.rulesetVersion === run.rulesetVersion
		) {
			last.runs.push(run);
			last.end = run.ts;
		} else {
			blocks.push({
				config: run.config,
				rulesetVersion: run.rulesetVersion,
				start: run.ts,
				end: run.ts,
				runs: [run],
			});
		}
	}
	return blocks;
}

// ---------------------------------------------------------------------------
// Step 1 -- attribution
// ---------------------------------------------------------------------------

/** How far a re-derived mean saving may sit from the banked `measured_delta`
 * and still count as the same measurement. Generous on purpose: the point is to
 * catch attributions that recovered the WRONG runs, not to reproduce the
 * selector's weighting to the token. */
const REPRODUCTION_TOLERANCE = 0.15;

export interface AttributedPass {
	rule: LedgerRule;
	/** Per-task saving, `without - with`, over tasks present on both sides. */
	vector: Map<string, number>;
	/** Mean of `vector` -- the number that must match `measured_delta`. */
	derivedDelta: number;
	/** True when the pass was recovered AND reproduces the banked verdict. */
	separable: boolean;
	/** Why not, when not. */
	reason: string;
}

/** Per-task mean of completed runs, through the shipped estimator rather than a
 * second one: `summarizeTask` is what `perTaskComparisons` subtracts. */
export function taskMeans(runs: readonly LedgerRun[]): Map<string, number> {
	const byTask = new Map<string, RunResult[]>();
	for (const [i, run] of runs.entries()) {
		const list = byTask.get(run.taskId) ?? [];
		list.push({
			sessionId: `${run.taskId}-${i}`,
			tokens: run.tokens,
			completed: run.completed,
		});
		byTask.set(run.taskId, list);
	}
	const means = new Map<string, number>();
	for (const [taskId, results] of byTask) {
		const summary = summarizeTask(taskId, results);
		if (summary.results.some((r) => r.completed)) {
			means.set(taskId, summary.meanCompletedTokens);
		}
	}
	return means;
}

/**
 * Recover each rule's measurement pass from the run log, and say whether the
 * recovery can be trusted.
 *
 * A candidate pass is the block whose LAST run lands within `DECISION_GAP_MS`
 * of the rule's `decided_at`; its baseline is the nearest preceding block of
 * `config='active'`. An `audit` block is the same shape with the sides swapped,
 * since a re-audit removes the rule and so is the WITHOUT side.
 */
export function attributePasses(
	rules: readonly LedgerRule[],
	blocks: readonly RunBlock[],
): AttributedPass[] {
	const out: AttributedPass[] = [];
	for (const rule of rules) {
		const decidedAt = rule.decidedAt;
		const empty: Omit<AttributedPass, "reason"> = {
			rule,
			vector: new Map(),
			derivedDelta: 0,
			separable: false,
		};
		if (decidedAt === null) {
			out.push({ ...empty, reason: "never decided" });
			continue;
		}
		const decided = Date.parse(decidedAt);
		const index = blocks.findIndex(
			(b) =>
				(b.config === "candidate" || b.config === "audit") &&
				Math.abs(Date.parse(b.end) - decided) < DECISION_GAP_MS,
		);
		const measured = index < 0 ? undefined : blocks[index];
		if (measured === undefined) {
			out.push({
				...empty,
				reason:
					"no candidate/audit block ends at decided_at -- the pass is inside a longer block shared with another rule",
			});
			continue;
		}
		let reference: RunBlock | undefined;
		for (let j = index - 1; j >= 0; j--) {
			const block = blocks[j];
			if (block?.config === "active") {
				reference = block;
				break;
			}
		}
		if (reference === undefined) {
			out.push({ ...empty, reason: "no preceding active-set baseline block" });
			continue;
		}
		const measuredMeans = taskMeans(measured.runs);
		const referenceMeans = taskMeans(reference.runs);
		const vector = new Map<string, number>();
		for (const [taskId, referenceMean] of referenceMeans) {
			const measuredMean = measuredMeans.get(taskId);
			if (measuredMean === undefined) continue;
			// An audit block is the WITHOUT side; a candidate block is the WITH side.
			vector.set(
				taskId,
				measured.config === "audit"
					? measuredMean - referenceMean
					: referenceMean - measuredMean,
			);
		}
		if (vector.size === 0) {
			out.push({ ...empty, reason: "no task comparable on both sides" });
			continue;
		}
		const derivedDelta =
			[...vector.values()].reduce((a, b) => a + b, 0) / vector.size;
		const banked = rule.measuredDelta;
		const scale = Math.max(Math.abs(banked ?? 0), 1);
		const reproduces =
			banked !== null &&
			Math.abs(derivedDelta - banked) / scale <= REPRODUCTION_TOLERANCE;
		out.push({
			rule,
			vector,
			derivedDelta,
			separable: reproduces,
			reason: reproduces
				? `reproduces measured_delta (${Math.round(derivedDelta)} vs ${banked})`
				: `re-derived mean ${Math.round(derivedDelta)} does not reproduce banked measured_delta ${banked} -- the recovered runs are not the ones the verdict was taken on`,
		});
	}
	return out;
}

// ---------------------------------------------------------------------------
// Step 2 -- the overlap itself
// ---------------------------------------------------------------------------

/** Cosine between two saving vectors over the tasks they share. Null when they
 * share no task, or when either vector is all-zero on the shared tasks (no
 * direction to compare). */
export function savingCosine(
	a: ReadonlyMap<string, number>,
	b: ReadonlyMap<string, number>,
): number | null {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	let shared = 0;
	for (const [taskId, x] of a) {
		const y = b.get(taskId);
		if (y === undefined) continue;
		shared++;
		dot += x * y;
		normA += x * x;
		normB += y * y;
	}
	if (shared === 0 || normA === 0 || normB === 0) return null;
	return dot / Math.sqrt(normA * normB);
}

/**
 * The map a `Similarity` would need: cosine lives in [-1, 1], and the packer's
 * objective requires [0, 1] with 1 on the diagonal (`knapsack.ts`,
 * non-negativity precondition). `(c + 1) / 2` is the symmetric, diagonal-1 map;
 * it is written down here so the harness reports the number the packer WOULD
 * have been handed, not a number nothing would consume.
 */
export function toSimilarity(cosine: number): number {
	return (cosine + 1) / 2;
}

// ---------------------------------------------------------------------------
// Step 3 -- the null
// ---------------------------------------------------------------------------

/**
 * The correlation two saving vectors carry under a null where NEITHER rule has
 * any effect, purely because they were measured against the same baseline pass
 * at equal depth. Derived, not fitted: `cov = Var(e_W)` and
 * `Var = Var(e_W) + Var(e_r)`, so `rho = 1/2`. `nullCosineDistribution` at
 * increasing depth is the demonstration that it does not decay.
 */
export const SHARED_BASELINE_NULL_CORRELATION = 0.5;

export interface TaskPool {
	taskId: string;
	/** Recorded baseline-side totals. */
	without: number[];
	/** Recorded with-rule totals, first rule. */
	withA: number[];
	/** Recorded with-rule totals, second rule. */
	withB: number[];
}

/**
 * Permutation null over the recorded runs: within a task the runs are
 * exchangeable if no rule does anything, so re-split each task's pooled totals
 * into groups of the recorded sizes and recompute the cosine.
 */
export function nullCosineDistribution(
	pools: readonly TaskPool[],
	draws: number,
	rng: () => number,
): number[] {
	const out: number[] = [];
	for (let d = 0; d < draws; d++) {
		const a = new Map<string, number>();
		const b = new Map<string, number>();
		for (const pool of pools) {
			const shuffledPool = shuffled(rng, [
				...pool.without,
				...pool.withA,
				...pool.withB,
			]);
			const nw = pool.without.length;
			const na = pool.withA.length;
			const mean = (xs: number[]): number =>
				xs.reduce((s, x) => s + x, 0) / Math.max(xs.length, 1);
			const baseline = mean(shuffledPool.slice(0, nw));
			a.set(pool.taskId, baseline - mean(shuffledPool.slice(nw, nw + na)));
			b.set(pool.taskId, baseline - mean(shuffledPool.slice(nw + na)));
		}
		const cosine = savingCosine(a, b);
		if (cosine !== null) out.push(cosine);
	}
	return out.sort((x, y) => x - y);
}

export function quantile(sorted: readonly number[], p: number): number {
	if (sorted.length === 0) return Number.NaN;
	const at = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
	return sorted[at] ?? Number.NaN;
}

export function fractionAtLeast(
	sorted: readonly number[],
	threshold: number,
): number {
	if (sorted.length === 0) return Number.NaN;
	return sorted.filter((x) => x >= threshold).length / sorted.length;
}

// ---------------------------------------------------------------------------
// Step 4 -- what depth would buy
// ---------------------------------------------------------------------------

export interface TaskNoise {
	taskId: string;
	mean: number;
	sd: number;
}

/** Standard normal via Box-Muller, off the shared seeded stream. */
function standardNormal(rng: () => number): number {
	const u = Math.max(rng(), Number.EPSILON);
	return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/**
 * The same null at an arbitrary run depth, drawn parametrically from the
 * recorded per-task mean and spread. This is the sweep that shows the
 * shared-baseline correlation is a structural constant rather than a
 * small-sample artifact: the answer does not improve with depth.
 */
export function drawNullSavingVectors(
	noise: readonly TaskNoise[],
	runsPerSide: number,
	rng: () => number,
): { a: Map<string, number>; b: Map<string, number> } {
	const a = new Map<string, number>();
	const b = new Map<string, number>();
	for (const task of noise) {
		const passMean = (): number => {
			let acc = 0;
			for (let i = 0; i < runsPerSide; i++) {
				acc += task.mean + task.sd * standardNormal(rng);
			}
			return acc / runsPerSide;
		};
		// ONE baseline draw, subtracted from BOTH with-rule draws. That single
		// shared term is the whole finding.
		const baseline = passMean();
		a.set(task.taskId, baseline - passMean());
		b.set(task.taskId, baseline - passMean());
	}
	return { a, b };
}

export function nullCosineAtDepth(
	noise: readonly TaskNoise[],
	runsPerSide: number,
	draws: number,
	rng: () => number,
): number[] {
	const out: number[] = [];
	for (let d = 0; d < draws; d++) {
		const { a, b } = drawNullSavingVectors(noise, runsPerSide, rng);
		const cosine = savingCosine(a, b);
		if (cosine !== null) out.push(cosine);
	}
	return out.sort((x, y) => x - y);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface OverlapArgs {
	dbPath: string | null;
	agent: string;
	draws: number;
	seed: number;
}

export function parseOverlapArgs(argv: readonly string[]): OverlapArgs {
	const args: OverlapArgs = {
		dbPath: null,
		agent: "sql",
		draws: 50_000,
		seed: 20260906,
	};
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const value = argv[i + 1];
		if (flag === "--db") {
			if (value === undefined) throw new Error("--db needs a path");
			args.dbPath = value;
			i++;
		} else if (flag === "--agent") {
			if (value === undefined) throw new Error("--agent needs a name");
			args.agent = value;
			i++;
		} else if (flag === "--draws" || flag === "--seed") {
			const n = Number(value);
			if (!Number.isInteger(n) || n <= 0) {
				throw new Error(`${flag} needs a positive integer`);
			}
			if (flag === "--draws") args.draws = n;
			else args.seed = n;
			i++;
		} else {
			throw new Error(`unknown flag: ${flag}`);
		}
	}
	return args;
}

const pct = (x: number): string => `${(100 * x).toFixed(1)}%`;

export function renderReport(
	args: OverlapArgs,
	passes: readonly AttributedPass[],
	pools: readonly TaskPool[],
	nulls: readonly number[],
	depths: readonly { runsPerSide: number; cosines: number[] }[],
	/** The pair the null was built for, and the cosine actually observed on it. */
	nullPair: { a: number; b: number; observed: number } | null = null,
): string[] {
	const lines: string[] = [
		"=== token-warden savings-overlap probe (recorded runs, zero tokens) ===",
		`agent ${args.agent} - ${passes.length} decided rules - ${args.draws.toLocaleString("en-US")} permutation draws - seed ${args.seed}`,
		"",
		"1. ATTRIBUTION -- can a recorded run be tied to the rule it measured?",
	];
	for (const pass of passes) {
		const mark = pass.separable ? "OK:  " : "NO:  ";
		lines.push(
			`   ${mark}rule ${pass.rule.id} [${pass.rule.status}] ${pass.reason}`,
		);
	}
	const separable = passes.filter((p) => p.separable);
	lines.push(
		"",
		`   ${separable.length} of ${passes.length} decided rules have a separable, self-reproducing pass.`,
		"",
		"2. MEASURED OVERLAP vs TEXTUAL OVERLAP, for the pairs that survived step 1",
	);
	for (const [i, a] of separable.entries()) {
		for (const b of separable.slice(i + 1)) {
			const cosine = savingCosine(a.vector, b.vector);
			const shared = [...a.vector.keys()].filter((t) => b.vector.has(t)).length;
			const trigram = trigramSimilarity(a.rule.body, b.rule.body);
			lines.push(
				`   rule ${a.rule.id} vs rule ${b.rule.id}: shared tasks ${shared}` +
					`  measured ${cosine === null ? "n/a" : `cosine ${cosine.toFixed(3)} -> similarity ${toSimilarity(cosine).toFixed(3)}`}` +
					`  textual ${trigram.toFixed(3)}`,
			);
		}
	}
	if (nulls.length > 0) {
		lines.push(
			"",
			"3. THE NULL -- the same statistic when NEITHER rule has any effect",
			`   pools (baseline/A/B runs per task): ${pools.map((p) => `${p.taskId} ${p.without.length}/${p.withA.length}/${p.withB.length}`).join("  ")}`,
			`   cosine quantiles: p05 ${quantile(nulls, 0.05).toFixed(3)}` +
				`  median ${quantile(nulls, 0.5).toFixed(3)}` +
				`  p95 ${quantile(nulls, 0.95).toFixed(3)}`,
			`   P(null cosine >= 0.5) = ${pct(fractionAtLeast(nulls, 0.5))}` +
				" -- how often two rules that do NOTHING read as half-redundant",
		);
		if (nullPair !== null) {
			const above = fractionAtLeast(nulls, nullPair.observed);
			lines.push(
				`   observed on rules ${nullPair.a}/${nullPair.b}: cosine ${nullPair.observed.toFixed(3)}` +
					`, at the ${((1 - above) * 100).toFixed(0)}th percentile of that null` +
					` (P(null >= observed) = ${pct(above)}).`,
				above > 0.05
					? "   VERDICT: the measured overlap is not distinguishable from no overlap at all."
					: "   VERDICT: the measured overlap sits outside the no-effect null.",
			);
		}
	}
	if (depths.length > 0) {
		lines.push(
			"",
			"4. DEPTH -- does a bigger burn fix it? (parametric null at the recorded spread)",
		);
		for (const depth of depths) {
			lines.push(
				`   runs/side ${String(depth.runsPerSide).padStart(4)}:` +
					`  median null cosine ${quantile(depth.cosines, 0.5).toFixed(3)}` +
					`  P(>= 0.5) ${pct(fractionAtLeast(depth.cosines, 0.5))}`,
			);
		}
		lines.push(
			"",
			`   Flat by construction. Every rule is measured against the SAME baseline pass, so`,
			`   its saving vector carries that pass's error as a shared term: correlation`,
			`   ${SHARED_BASELINE_NULL_CORRELATION} between any two rules' vectors under the null, at every depth. More runs`,
			"   shrink the shared term and the private terms by the same factor.",
		);
	}
	return lines;
}

/** Read one agent's golden runs and decided rules, read-only. */
export function loadLedger(
	db: Database.Database,
	agent: string,
): { runs: LedgerRun[]; rules: LedgerRule[] } {
	const runs = db
		.prepare<
			[string],
			{
				taskId: string;
				config: string;
				rulesetVersion: number;
				completed: number;
				ts: string;
				tokens: number;
			}
		>(
			`SELECT task_hash AS taskId, config, ruleset_version AS rulesetVersion,
				completed, ts,
				input_tokens + output_tokens + cache_creation + cache_read AS tokens
			 FROM runs
			 WHERE agent = ? AND task_hash IS NOT NULL
			 ORDER BY ts ASC`,
		)
		.all(agent)
		.map((row) => ({ ...row, completed: row.completed === 1 }));
	const rules = db
		.prepare<
			[string],
			{
				id: number;
				body: string;
				status: string;
				measuredDelta: number | null;
				decidedAt: string | null;
			}
		>(
			`SELECT id, body, status, measured_delta AS measuredDelta,
				decided_at AS decidedAt
			 FROM rules WHERE agent = ? ORDER BY id ASC`,
		)
		.all(agent);
	return { runs, rules };
}

function blockEndingAt(
	blocks: readonly RunBlock[],
	at: string | null,
): RunBlock | undefined {
	if (at === null) return undefined;
	return blocks.find(
		(block) =>
			(block.config === "candidate" || block.config === "audit") &&
			Math.abs(Date.parse(block.end) - Date.parse(at)) < DECISION_GAP_MS,
	);
}

function referenceBefore(
	blocks: readonly RunBlock[],
	index: number,
): RunBlock | undefined {
	for (let j = index - 1; j >= 0; j--) {
		const block = blocks[j];
		if (block?.config === "active") return block;
	}
	return undefined;
}

/**
 * Build the two-rule permutation pools for a pair of attributed passes.
 *
 * Both passes must be `candidate` (a with-rule side; an `audit` pass is the
 * WITHOUT side and would enter the pool with the opposite sign) and must resolve
 * to the SAME baseline block -- which is not a limitation of the harness but the
 * condition the null is about.
 */
export function poolsFor(
	blocks: readonly RunBlock[],
	a: AttributedPass,
	b: AttributedPass,
): TaskPool[] {
	const blockA = blockEndingAt(blocks, a.rule.decidedAt);
	const blockB = blockEndingAt(blocks, b.rule.decidedAt);
	if (!blockA || !blockB) return [];
	if (blockA.config !== "candidate" || blockB.config !== "candidate") return [];
	const reference = referenceBefore(blocks, blocks.indexOf(blockA));
	if (
		!reference ||
		reference !== referenceBefore(blocks, blocks.indexOf(blockB))
	) {
		return [];
	}
	const totals = (block: RunBlock, taskId: string): number[] =>
		block.runs
			.filter((r) => r.taskId === taskId && r.completed)
			.map((r) => r.tokens);
	const pools: TaskPool[] = [];
	for (const taskId of a.vector.keys()) {
		if (!b.vector.has(taskId)) continue;
		const without = totals(reference, taskId);
		const withA = totals(blockA, taskId);
		const withB = totals(blockB, taskId);
		if (without.length === 0 || withA.length === 0 || withB.length === 0) {
			continue;
		}
		pools.push({ taskId, without, withA, withB });
	}
	return pools;
}

export function noiseFrom(pools: readonly TaskPool[]): TaskNoise[] {
	return pools.map((pool) => {
		const all = [...pool.without, ...pool.withA, ...pool.withB];
		const mean = all.reduce((a, b) => a + b, 0) / all.length;
		const sd =
			all.length < 2
				? 0
				: Math.sqrt(
						all.reduce((s, x) => s + (x - mean) ** 2, 0) / (all.length - 1),
					);
		return { taskId: pool.taskId, mean, sd };
	});
}

const DEPTH_SWEEP = [2, 4, 8, 16, 32, 64, 128] as const;
const DEPTH_DRAWS = 20_000;

export function main(argv: readonly string[]): number {
	const args = parseOverlapArgs(argv);
	// READ-ONLY, and deliberately not `openDb`: that runs pending migrations,
	// and a measurement of the user's ledger must never write to it.
	const db = new Database(args.dbPath ?? defaultDbPath(), {
		readonly: true,
		fileMustExist: true,
	});
	try {
		const { runs, rules } = loadLedger(db, args.agent);
		if (runs.length === 0) {
			console.log(`NO: agent ${args.agent} has no recorded golden runs.`);
			return 1;
		}
		const decided = rules.filter((r) => r.decidedAt !== null);
		const blocks = toBlocks(
			runs,
			decided.flatMap((r) => (r.decidedAt === null ? [] : [r.decidedAt])),
		);
		const passes = attributePasses(decided, blocks);
		const separable = passes.filter((p) => p.separable);

		// The first pair sharing a baseline -- the configuration the null is about.
		let pools: TaskPool[] = [];
		let nullPair: { a: number; b: number; observed: number } | null = null;
		for (const [i, first] of separable.entries()) {
			for (const second of separable.slice(i + 1)) {
				const candidatePools = poolsFor(blocks, first, second);
				const observed = savingCosine(first.vector, second.vector);
				if (candidatePools.length > 0 && observed !== null) {
					pools = candidatePools;
					nullPair = {
						a: first.rule.id,
						b: second.rule.id,
						observed,
					};
					break;
				}
			}
			if (pools.length > 0) break;
		}
		const rng = mulberry32(args.seed);
		const nulls =
			pools.length > 0 ? nullCosineDistribution(pools, args.draws, rng) : [];
		const noise = noiseFrom(pools);
		const depths =
			noise.length > 0
				? DEPTH_SWEEP.map((runsPerSide) => ({
						runsPerSide,
						cosines: nullCosineAtDepth(noise, runsPerSide, DEPTH_DRAWS, rng),
					}))
				: [];

		for (const line of renderReport(
			args,
			passes,
			pools,
			nulls,
			depths,
			nullPair,
		)) {
			console.log(line);
		}
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
