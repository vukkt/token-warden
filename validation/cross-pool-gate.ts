/**
 * CROSS-POOL GATE SWEEP — does the gate-loosening result survive a second
 * agent's noise? ZERO TOKENS: every "run" is a token total already recorded.
 *
 * THE LIMIT THIS EXISTS TO ATTACK. `validation/stream-calibration.ts` set the
 * shipped `z = 1.5` and produced the break-even-harm argument in FINDINGS, and
 * every number in both came off ONE replicate pool: the `sql` agent in the live
 * ledger. README listed that under Limits as "rests on one agent's replicate
 * pool. The direction is robust; the exact optimum is not" — which was an
 * assertion, because nothing had been run on a second pool.
 *
 * WHAT IT DOES. Takes any number of recorded ledgers, inventories each one's
 * golden replicate depth, SKIPS the ones too thin to support a permutation A/A
 * (saying so, with the depths, rather than quietly producing a number), and
 * runs the identical z-sweep and break-even solve on the rest through
 * `runStreams` — the same function that produced the published figures, so the
 * only thing that changes between pools is the noise.
 *
 * EVERY POOL IS COPIED BEFORE IT IS OPENED. `openDb` migrates on open, so
 * pointing a harness at the live ledger is a write. Each `--pool` is copied to
 * a temp file and the copy is what gets opened; the source is never touched.
 *
 * MEASURED (2026-09-06). Grid z in {0, 0.5, 1.0, 1.5, 2.0}, overlap 0.85,
 * 200 trials x 40 arrivals, runs 2/side, 20% of arrivals carrying a real 10%
 * saving, six seed families:
 *
 *   pool                     shape   NET at z = 0 / 0.5 / 1.0 / 1.5 / 2.0 (tok/run)
 *   live ledger `sql`      3 x 4-5   20,825  18,703  15,388  11,456   8,603
 *   dogfood `sql`            5 x 6   22,551  21,719  19,899  17,042  13,305
 *   full-loop `sql`        SKIPPED - no `config = 'active'` rows at all
 *   naive-headroom `sql`   SKIPPED - same, and 2 replicates per cell
 *
 * THE DIRECTION REPLICATES: monotone on both pools, at overlap 1.0, 0.85 and
 * 0.7, with a net-token optimum at z=0 under harm=0. So does the case for the
 * shipped gate against LOOSER ones — break-even 2.9%-11.0% of one tool call.
 *
 * ONE HALF DOES NOT. Against the TIGHTER z=2.0 the live ledger put the
 * break-even at 845% of a tool call (published: 664%) and the second pool puts
 * it at 18.4%. That gap is not depth — thinning the deeper pool to the live
 * pool's 3-task shape leaves it at 19.5%-23.8% — it is the live pool itself:
 * there, tightening from 1.5 to 2.0 drops real discoveries (2.8 -> 2.0) while
 * keeping the SAME 2.6 worthless ones, so the break-even's denominator nearly
 * vanishes and the ratio is an artifact, not a bracket. FINDINGS 2026-09-06.
 *
 * The two skipped pools are a result, not a gap: both burns recorded their runs
 * as `config = 'candidate'`, and `goldenReplicateRuns` — the pool every
 * calibration harness in this repo draws from — restricts to `config =
 * 'active'`. There is no honest way to promote candidate rows into an A/A null
 * here: in both ledgers the two ruleset versions ARE the two arms of a real
 * A/B, so pooling them would inject the very effect the null is supposed to
 * lack, and each arm alone is 2 replicates deep against a 4-replicate floor.
 *
 *   npx tsx validation/cross-pool-gate.ts [--pool label=path ...] [--agent <name>]
 *     [--trials N] [--length N] [--runs N] [--rent N] [--seed N] [--seeds N]
 *     [--overlap F] [--true-rate F] [--saving F] [--z 0,0.5,1,1.5,2]
 *     [--max-tasks N] [--max-depth N]
 *
 * With no `--pool`, it sweeps the four pools above by their conventional paths
 * and reports any that are absent (the burn ledgers are gitignored, so a fresh
 * clone will see two).
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { numericFlag } from "../src/cli.js";
import { defaultDbPath, goldenReplicateRuns, openDb } from "../src/db.js";
import { assertKnownAgent } from "../src/registry.js";
import { confidenceZ } from "../src/stats.js";
import { groupReplicates } from "./empirical-calibration.js";
import {
	breakEvenHarm,
	type HarmLine,
	runStreams,
} from "./stream-calibration.js";

/**
 * The measured cost of ONE extra tool call, in tokens per run (FINDINGS: the
 * within-task regression of cost on `tool_calls`, R^2 94.6%). Break-even harms
 * are reported against it because that is the only unit in which "what does a
 * worthless rule cost beyond its rent" has ever been anchored to something
 * measured.
 */
const ONE_TOOL_CALL_TOKENS = 14018;

/** Seed families are spaced far enough apart that no two overlap: `runStreams`
 * advances its seed by `7919` per trial, so at any trial count this repo runs,
 * consecutive families cannot share a draw sequence. */
const SEED_FAMILY_STRIDE = 10_000_019;

interface Pool {
	label: string;
	path: string;
}

/** The pools this repo has: the live ledger, plus the three burn ledgers the
 * validation runs left behind. Paths are conventional, and a missing one is
 * reported rather than fatal — `validation/*.db` is gitignored. */
function defaultPools(): Pool[] {
	return [
		{ label: "live-ledger", path: defaultDbPath() },
		{ label: "dogfood-sql", path: "validation/warden-dogfood-sql.db" },
		{ label: "full-loop", path: "validation/warden-fullloop.db" },
		{ label: "naive-headroom", path: "validation/warden-naive-headroom.db" },
	];
}

interface SweepCell {
	z: number;
	falseDiscoveryProportion: number;
	discoveries: number;
	trueDiscoveries: number;
	missedReal: number;
	netTokensPerRun: number;
	netBeforeHarm: number;
	falseDiscoveries: number;
	/** Spread of `netTokensPerRun` across seed families: max - min. Reported so
	 * a difference between pools can be read against the seed noise inside one. */
	netSpread: number;
	/** This arm's per-seed-family harm lines, kept so the break-even against the
	 * shipped arm can be solved PER SEED and its spread reported. The break-even
	 * is a ratio whose denominator is a difference of two worthless-rule counts,
	 * and when those counts nearly coincide the ratio explodes — a seed-mean
	 * alone would hide that. */
	lines: HarmLine[];
}

/**
 * Thin a pool to `maxTasks` tasks of at most `maxDepth` replicates each — the
 * control that separates "different agent" from "different depth".
 *
 * Two pools differ in more than one way at once, so a divergence between them
 * cannot be attributed without holding one of those ways fixed. Thinning the
 * DEEPER pool down to the shallower one's shape leaves the agent, the tasks and
 * the noise alone and changes only the evidence available per decision. If the
 * divergence follows the thinning, it was depth.
 *
 * Deterministic: tasks are already sorted by id and replicates keep their
 * recorded order, so no seed enters here. Non-positive caps mean "no cap".
 */
export function thinGroups(
	groups: { taskId: string; totals: number[] }[],
	maxTasks: number,
	maxDepth: number,
): { taskId: string; totals: number[] }[] {
	const kept = maxTasks > 0 ? groups.slice(0, maxTasks) : groups;
	if (maxDepth <= 0) return kept;
	return kept.map((g) => ({
		taskId: g.taskId,
		totals: g.totals.slice(0, maxDepth),
	}));
}

/** Mean of a non-empty list; 0 for an empty one (which the callers cannot
 * produce — the z grid and the seed list are both validated non-empty). */
function mean(values: number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * One pool's z-sweep. For each z, every seed family is run and the arms are
 * averaged; the SHIPPED arm is identical across the grid within a seed (same
 * draws, same rule), so it is collected once and cross-checked.
 */
function sweepPool(
	groups: { taskId: string; totals: number[] }[],
	options: {
		zGrid: number[];
		seeds: number[];
		trials: number;
		length: number;
		runs: number;
		rent: number;
		trueRate: number;
		saving: number;
		overlap: number;
	},
): { cells: SweepCell[]; shipped: HarmLine[] } {
	const shippedLines: HarmLine[] = [];
	const cells: SweepCell[] = [];

	for (const z of options.zGrid) {
		const nets: number[] = [];
		const fdps: number[] = [];
		const kept: number[] = [];
		const realKept: number[] = [];
		const missed: number[] = [];
		const netBeforeHarm: number[] = [];
		const falseKept: number[] = [];
		const lines: HarmLine[] = [];
		const shippedThisZ: HarmLine[] = [];

		for (const seed of options.seeds) {
			const [ship, alt] = runStreams(groups, {
				trials: options.trials,
				length: options.length,
				runs: options.runs,
				rent: options.rent,
				trueRate: options.trueRate,
				saving: options.saving,
				seed,
				overlap: options.overlap,
				compareZ: z,
			}) as [
				ReturnType<typeof runStreams>[number],
				ReturnType<typeof runStreams>[number],
			];
			shippedThisZ.push({
				netBeforeHarm: ship.netBeforeHarm,
				falseDiscoveries: ship.falseDiscoveries,
			});
			lines.push({
				netBeforeHarm: alt.netBeforeHarm,
				falseDiscoveries: alt.falseDiscoveries,
			});
			nets.push(alt.netTokensPerRun);
			fdps.push(alt.falseDiscoveryProportion);
			kept.push(alt.discoveries);
			realKept.push(alt.trueDiscoveries);
			missed.push(alt.missedReal);
			netBeforeHarm.push(alt.netBeforeHarm);
			falseKept.push(alt.falseDiscoveries);
		}

		// The shipped arm sees identical draws at every z, so its lines must be
		// identical too; recorded once, from the first z swept.
		if (shippedLines.length === 0) shippedLines.push(...shippedThisZ);

		cells.push({
			z,
			lines,
			falseDiscoveryProportion: mean(fdps),
			discoveries: mean(kept),
			trueDiscoveries: mean(realKept),
			missedReal: mean(missed),
			netTokensPerRun: mean(nets),
			netBeforeHarm: mean(netBeforeHarm),
			falseDiscoveries: mean(falseKept),
			netSpread: Math.max(...nets) - Math.min(...nets),
		});
	}

	return { cells, shipped: shippedLines };
}

/**
 * Break-even harm solved SEPARATELY on each seed family, sorted ascending.
 * Families where the two arms keep the same worthless count (or cross at a
 * negative harm) contribute nothing and are counted as unresolved, because a
 * mean over them would be a mean over a quantity that does not exist there.
 */
export function breakEvenPerSeed(
	shipped: HarmLine[],
	alternative: HarmLine[],
): { solved: number[]; unresolved: number } {
	const solved: number[] = [];
	let unresolved = 0;
	for (let i = 0; i < Math.min(shipped.length, alternative.length); i++) {
		const a = shipped[i];
		const b = alternative[i];
		if (a === undefined || b === undefined) {
			unresolved += 1;
			continue;
		}
		const h = breakEvenHarm(a, b);
		if (h === null) unresolved += 1;
		else solved.push(h);
	}
	solved.sort((x, y) => x - y);
	return { solved, unresolved };
}

/** Whether net tokens fall monotonically as the gate tightens across the grid
 * (the grid is ascending in z). This is the DIRECTION the published result
 * claimed; it is the thing a second pool either replicates or does not. */
export function loosensMonotonically(cells: SweepCell[]): boolean {
	for (let i = 1; i < cells.length; i++) {
		const prev = cells[i - 1];
		const here = cells[i];
		if (prev === undefined || here === undefined) return false;
		if (here.netTokensPerRun > prev.netTokensPerRun) return false;
	}
	return true;
}

/** The z with the highest net tokens per run. The grid arrives sorted
 * ascending and the comparison is strict, so an exact tie keeps the LOOSER z —
 * which is the honest reading here, because a tie means the extra strictness
 * bought nothing. */
export function argmaxZ(cells: SweepCell[]): number | null {
	let best: SweepCell | null = null;
	for (const cell of cells) {
		if (best === null || cell.netTokensPerRun > best.netTokensPerRun) {
			best = cell;
		}
	}
	return best === null ? null : best.z;
}

function fmt(n: number): string {
	return Math.round(n).toLocaleString("en-US");
}

function reportPool(
	pool: Pool,
	args: {
		agent: string;
		zGrid: number[];
		seeds: number[];
		trials: number;
		length: number;
		runs: number;
		rent: number;
		trueRate: number;
		saving: number;
		overlap: number;
		maxTasks: number;
		maxDepth: number;
	},
): void {
	console.log(`\n=== pool ${pool.label} (${pool.path}) ===`);
	if (!existsSync(pool.path)) {
		console.log("ABSENT: no such ledger on this machine - nothing measured.");
		return;
	}

	// Copy before opening: openDb migrates, and a source ledger is read-only.
	const scratch = mkdtempSync(join(tmpdir(), "warden-crosspool-"));
	const copy = join(scratch, basename(pool.path));
	copyFileSync(pool.path, copy);
	try {
		const db = openDb(copy);
		let groups: { taskId: string; totals: number[] }[];
		let rows: number;
		try {
			const replicates = goldenReplicateRuns(db, args.agent);
			rows = replicates.length;
			groups = thinGroups(
				groupReplicates(replicates, args.runs * 2),
				args.maxTasks,
				args.maxDepth,
			);
		} finally {
			db.close();
		}

		const depths = groups
			.map((g) => `${g.taskId}:${g.totals.length}`)
			.join(" ");
		console.log(
			`agent ${args.agent} - ${rows} active golden runs - ` +
				`${groups.length} tasks at >= ${args.runs * 2} replicates` +
				(depths === "" ? "" : ` (${depths})`),
		);
		if (groups.length < 2) {
			console.log(
				"SKIPPED: fewer than 2 usable tasks. A permutation A/A needs " +
					`${args.runs * 2} replicates of one identical (task, ruleset, model) ` +
					"configuration at `config = 'active'`; this ledger does not have them.",
			);
			return;
		}

		const { cells, shipped } = sweepPool(groups, args);
		console.log(
			"\n   z   stream FDR   kept   real kept   real missed   NET tok/run   seed spread",
		);
		for (const cell of cells) {
			console.log(
				`${cell.z.toFixed(1).padStart(4)}   ` +
					`${(cell.falseDiscoveryProportion * 100).toFixed(1).padStart(9)}%   ` +
					`${cell.discoveries.toFixed(1).padStart(4)}   ` +
					`${cell.trueDiscoveries.toFixed(1).padStart(9)}   ` +
					`${cell.missedReal.toFixed(1).padStart(11)}   ` +
					`${fmt(cell.netTokensPerRun).padStart(11)}   ` +
					`${fmt(cell.netSpread).padStart(11)}`,
			);
		}
		console.log(
			`\nmonotone (net falls as z rises): ${loosensMonotonically(cells) ? "YES" : "NO"}` +
				` - net-token optimum at z=${argmaxZ(cells) ?? "n/a"}` +
				` (shipped z=${confidenceZ()})`,
		);

		console.log(
			`\n--- break-even harm for shipped z=${confidenceZ()} vs each alternative ---`,
		);
		console.log(
			"   z   break-even tok/run (min - median - max over seeds)   median as % of one tool call",
		);
		for (const cell of cells) {
			if (cell.z === confidenceZ()) continue;
			const { solved, unresolved } = breakEvenPerSeed(shipped, cell.lines);
			const label = cell.z.toFixed(1).padStart(4);
			const lo = solved[0];
			const hi = solved[solved.length - 1];
			const mid = solved[Math.floor((solved.length - 1) / 2)];
			if (lo === undefined || hi === undefined || mid === undefined) {
				console.log(
					`${label}   UNRESOLVED on all ${unresolved} seed families - the arms keep the` +
						" same worthless count, so one dominates at every harm",
				);
				continue;
			}
			console.log(
				`${label}   ${`${fmt(lo)} - ${fmt(mid)} - ${fmt(hi)}`.padStart(48)}   ` +
					`${((mid / ONE_TOOL_CALL_TOKENS) * 100).toFixed(1).padStart(28)}%` +
					(unresolved > 0 ? `   (${unresolved} seed(s) unresolved)` : ""),
			);
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

function parsePools(argv: string[]): Pool[] {
	const pools: Pool[] = [];
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] !== "--pool") continue;
		const spec = argv[i + 1] ?? "";
		const at = spec.indexOf("=");
		if (at <= 0 || at === spec.length - 1) {
			throw new Error(`--pool must be label=path (got "${spec}")`);
		}
		pools.push({ label: spec.slice(0, at), path: spec.slice(at + 1) });
	}
	return pools.length > 0 ? pools : defaultPools();
}

function main(argv: string[]): number {
	const agentAt = argv.indexOf("--agent");
	const agent = agentAt >= 0 ? (argv[agentAt + 1] ?? "sql") : "sql";
	assertKnownAgent(agent);

	/** Read `--flag VALUE`, falling back when absent or unparseable — the same
	 * discipline as stream-calibration: a typo must not silently become a
	 * policy nobody chose. */
	const flag = (name: string, fallback: number): number => {
		const at = argv.indexOf(name);
		if (at < 0) return fallback;
		const value = numericFlag(argv[at + 1]);
		return Number.isFinite(value) ? value : fallback;
	};

	const trials = flag("--trials", 200);
	const length = flag("--length", 40);
	const runs = flag("--runs", 2);
	const rent = flag("--rent", 25);
	const trueRate = flag("--true-rate", 0.2);
	const saving = flag("--saving", 0.1);
	const overlap = flag("--overlap", 0.85);
	const seed = flag("--seed", 42);
	const families = Math.max(1, Math.round(flag("--seeds", 6)));
	// Thinning caps: 0 (the default) means "use the pool as recorded".
	const maxTasks = Math.max(0, Math.round(flag("--max-tasks", 0)));
	const maxDepth = Math.max(0, Math.round(flag("--max-depth", 0)));

	const zAt = argv.indexOf("--z");
	const zGrid = (
		zAt >= 0 ? (argv[zAt + 1] ?? "").split(",") : ["0", "0.5", "1", "1.5", "2"]
	)
		.map((part) => numericFlag(part))
		.filter((value) => Number.isFinite(value))
		.sort((a, b) => a - b);
	if (zGrid.length === 0) {
		throw new Error("--z must be a comma-separated list of numbers");
	}

	const seeds = Array.from(
		{ length: families },
		(_, i) => seed + i * SEED_FAMILY_STRIDE,
	);

	console.log("=== token-warden cross-pool gate sweep (zero tokens) ===");
	console.log(
		`runs ${runs}/side - rent ${rent} - overlap ${overlap} - ` +
			`streams of ${length} arrivals x ${trials} trials\n` +
			`${(trueRate * 100).toFixed(0)}% of arrivals carry a real ` +
			`${(saving * 100).toFixed(0)}% saving - ` +
			`${families} seed families from ${seed}\n` +
			(maxTasks > 0 || maxDepth > 0
				? `THINNED to ${maxTasks > 0 ? `${maxTasks} tasks` : "all tasks"} x ` +
					`${maxDepth > 0 ? `${maxDepth} replicates` : "full depth"}\n`
				: "") +
			"every pool is COPIED before it is opened; sources are never written",
	);

	for (const pool of parsePools(argv)) {
		reportPool(pool, {
			agent,
			zGrid,
			seeds,
			trials,
			length,
			runs,
			rent,
			trueRate,
			saving,
			overlap,
			maxTasks,
			maxDepth,
		});
	}

	console.log(
		"\nRead: NET tok/run is the objective, not FDR (see stream-calibration).\n" +
			"The published gate-loosening result is the MONOTONE column plus a\n" +
			"break-even harm small against one tool call. A second pool replicates\n" +
			"it only if both hold there too - and the break-even is the number that\n" +
			"is allowed to move, because it is a ratio of two pools' noise.",
	);
	return 0;
}

/* v8 ignore start -- CLI entry shim */
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	process.exit(main(process.argv.slice(2)));
}
/* v8 ignore stop */
