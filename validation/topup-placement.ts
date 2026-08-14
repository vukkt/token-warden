/**
 * TOP-UP PLACEMENT — is the permutation A/A arm still measuring the shipped
 * selector? ZERO TOKENS: every "run" is a token total already in the ledger.
 *
 * THE DIVERGENCE THIS EXISTS TO SIZE. When a candidate's first look lands
 * uncertain, `measureWithTopUp` spends one more pass on the measured side and
 * places it with `allocateTopUpRuns` — the Neyman allocator, which pours the
 * whole round into whichever tasks look noisiest. `bootstrapLook` in
 * validation/empirical-calibration.ts models that. `permutationTrial`, whose
 * keep rate IS the published empirical false-positive rate, does NOT: its
 * top-up spreads `runsPerSide` over every task UNIFORMLY. Same budget,
 * different placement, and nothing in the harness said so.
 *
 * That is the same shape as the two errors already recorded against this
 * feature — a harness importing the real functions and still describing a call
 * sequence the selector does not make (FINDINGS.md, "the harness was measuring
 * a policy the code does not implement", and "the banked delta was a constant
 * in the harness and a moving column in the ledger").
 *
 * WHAT IT MEASURES. One trial is one exchangeable split, decided BOTH ways off
 * the identical top-up draw sequence — only the task each drawn value lands on
 * differs — so the two rates are paired trial by trial and the difference is
 * the placement rule alone, never the RNG. Discordant counts are reported
 * because the rates alone hide how often the two policies actually disagree.
 *
 * MEASURED (2026-08-14). Both arms paired trial by trial:
 *
 *   pool                                  uniform   neyman   difference
 *   committed fixture (3 tasks x 12 reps)   5.50%    7.27%   +1.77pt
 *   recorded sql pool (3 tasks x 4-5 reps)  8.41%    8.48%   +0.07pt
 *
 * Fixture: 20,000 trials, seed 42, discordant 65 vs 418 — pinned in
 * test/empirical-calibration.test.ts. Ledger: 50,000 trials, seed 42,
 * discordant 9 vs 45; reproduce with `--db <copy of the ledger>`.
 *
 * The direction is up on both, and it is up for a known reason: Neyman
 * placement pours a whole round into whichever task drew widest, and at 2
 * runs/side that estimate carries ONE degree of freedom, so it chases an
 * artifact and the occasional spuriously narrow SE admits a null rule. The same
 * one-degree-of-freedom effect sank Neyman placement on the retention side in
 * v0.43.0 and set the depth requirement in v0.44.0.
 *
 * The magnitude grows sharply with pool depth — 0.07pt at 4-5 replicates per
 * task, 1.77pt at 12 — because a shallow pool leaves the allocator nothing to
 * concentrate. So the published permutation figure is a FLOOR, and it drifts
 * further below the shipped gate's true rate exactly as the ledger deepens,
 * which is the direction this project is going.
 *
 * Nothing here changes `permutationTrial`. Correcting the placement moves a
 * published number, and this repo does not move a calibration number without
 * correcting the document that quotes it in the same commit.
 *
 *   npx tsx validation/topup-placement.ts [--agent <name>] [--db <path>]
 *     [--trials N] [--runs N] [--rent N] [--seed N]
 */
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { summarizeTask, type TaskSummary } from "../src/bench.js";
import { numericFlag } from "../src/cli.js";
import { defaultDbPath, goldenReplicateRuns } from "../src/db.js";
import { assertKnownAgent } from "../src/registry.js";
import { allocateTopUpRuns } from "../src/select.js";
import {
	candidateKept,
	groupReplicates,
	type ReplicateGroup,
	wilson,
} from "./empirical-calibration.js";
import { mulberry32 } from "./rng.js";

export interface PlacementCounts {
	trials: number;
	/** Kept under the harness's UNIFORM top-up (what `permutationTrial` does). */
	uniform: number;
	/** Kept under the shipped NEYMAN placement (what the selector does). */
	neyman: number;
	/** Trials the uniform arm kept and the Neyman arm did not, and vice versa —
	 * the McNemar pair, which the two rates on their own conceal. */
	uniformOnly: number;
	neymanOnly: number;
}

/**
 * One exchangeable split, resolved under BOTH placement rules.
 *
 * The top-up values are drawn ONCE per task, before either arm runs, and each
 * arm takes the prefix its allocation asks for. Drawing them inside each arm
 * would let the two consume the RNG differently and turn a placement difference
 * into a sampling difference — the exact confusion that made an earlier comment
 * in empirical-calibration.ts claim two eviction arms were paired when they
 * were not.
 */
export function placementTrial(
	rng: () => number,
	groups: readonly ReplicateGroup[],
	runsPerSide: number,
	rent: number,
): { uniform: boolean; neyman: boolean } {
	const without: TaskSummary[] = [];
	const withRule: TaskSummary[] = [];
	const heldOut = new Map<string, number[]>();
	const toSummary = (
		taskId: string,
		totals: number[],
		tag: string,
	): TaskSummary =>
		summarizeTask(
			taskId,
			totals.map((tokens, i) => ({
				sessionId: `${taskId}-${tag}-${i}`,
				tokens,
				completed: true,
			})),
		);
	for (const group of groups) {
		// Fisher-Yates on a copy, matching `permutationTrial`'s deal exactly.
		const deck = [...group.totals];
		for (let i = deck.length - 1; i > 0; i--) {
			const j = Math.floor(rng() * (i + 1));
			const tmp = deck[i] as number;
			deck[i] = deck[j] as number;
			deck[j] = tmp;
		}
		without.push(toSummary(group.taskId, deck.slice(0, runsPerSide), "w"));
		withRule.push(
			toSummary(group.taskId, deck.slice(runsPerSide, 2 * runsPerSide), "m"),
		);
		const rest = deck.slice(2 * runsPerSide);
		heldOut.set(group.taskId, rest.length >= 2 ? rest : group.totals);
	}
	// Enough draws per task that any allocation can be served from the prefix:
	// the whole budget could land on one task.
	const budget = runsPerSide * groups.length;
	const drawn = new Map<string, number[]>();
	for (const group of groups) {
		const pool = heldOut.get(group.taskId) ?? group.totals;
		const values: number[] = [];
		for (let i = 0; i < budget; i++) {
			values.push(pool[Math.floor(rng() * pool.length)] as number);
		}
		drawn.set(group.taskId, values);
	}
	const place = (
		allocation: ReadonlyMap<string, number> | null,
	): TaskSummary[] =>
		groups.flatMap((group) => {
			const n = allocation ? (allocation.get(group.taskId) ?? 0) : runsPerSide;
			if (n <= 0) return [];
			const values = (drawn.get(group.taskId) as number[]).slice(0, n);
			return [toSummary(group.taskId, values, "t")];
		});
	return {
		uniform: candidateKept(without, withRule, rent, () => place(null)),
		neyman: candidateKept(without, withRule, rent, (measured) =>
			place(
				allocateTopUpRuns(
					without,
					measured,
					measured.reduce((sum, s) => sum + s.results.length, 0),
				),
			),
		),
	};
}

export function comparePlacements(
	groups: readonly ReplicateGroup[],
	runsPerSide: number,
	rent: number,
	trials: number,
	seed: number,
): PlacementCounts {
	const rng = mulberry32(seed);
	const counts: PlacementCounts = {
		trials,
		uniform: 0,
		neyman: 0,
		uniformOnly: 0,
		neymanOnly: 0,
	};
	for (let i = 0; i < trials; i++) {
		const { uniform, neyman } = placementTrial(rng, groups, runsPerSide, rent);
		if (uniform) counts.uniform++;
		if (neyman) counts.neyman++;
		if (uniform && !neyman) counts.uniformOnly++;
		if (neyman && !uniform) counts.neymanOnly++;
	}
	return counts;
}

export interface PlacementArgs {
	agent: string;
	dbPath: string | null;
	trials: number;
	runs: number;
	rent: number;
	seed: number;
}

export function parsePlacementArgs(argv: readonly string[]): PlacementArgs {
	const args: PlacementArgs = {
		agent: "sql",
		dbPath: null,
		// High enough that the fixture's ~2-point gap is many standard errors
		// wide. This project was fooled once by a 400-trial reading that vanished
		// at 3,000; a placement gap this small needs tens of thousands.
		trials: 50_000,
		runs: 2,
		rent: 25,
		seed: 42,
	};
	const positive = (raw: string | undefined, flag: string): number => {
		const n = numericFlag(raw);
		if (!Number.isInteger(n) || n < 1) {
			throw new Error(`${flag} must be a positive integer`);
		}
		return n;
	};
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === "--agent") {
			const agent = argv[++i] ?? "";
			assertKnownAgent(agent);
			args.agent = agent;
		} else if (flag === "--db") {
			const path = argv[++i];
			if (!path) throw new Error("--db requires a path");
			args.dbPath = path;
		} else if (flag === "--trials") {
			args.trials = positive(argv[++i], "--trials");
		} else if (flag === "--runs") {
			args.runs = positive(argv[++i], "--runs");
		} else if (flag === "--rent") {
			const n = numericFlag(argv[++i]);
			if (!Number.isFinite(n) || n <= 0) {
				throw new Error("--rent must be a positive number");
			}
			args.rent = n;
		} else if (flag === "--seed") {
			const n = numericFlag(argv[++i]);
			if (!Number.isInteger(n)) throw new Error("--seed must be an integer");
			args.seed = n;
		} else {
			throw new Error(`unknown flag: ${flag}`);
		}
	}
	return args;
}

const pct = (x: number): string => `${(100 * x).toFixed(2)}%`;

export function renderPlacement(
	counts: PlacementCounts,
	groups: readonly ReplicateGroup[],
	args: PlacementArgs,
): string[] {
	const { trials } = counts;
	const band = (k: number): string => {
		const w = wilson(k, trials);
		return `${pct(k / trials)} [${pct(w.lo)}, ${pct(w.hi)}]`;
	};
	return [
		"=== token-warden top-up placement (recorded runs, zero tokens) ===",
		`agent ${args.agent} · ${groups.length} tasks (${groups
			.map((g) => `${g.taskId}:${g.totals.length}`)
			.join(
				" ",
			)}) · runs=${args.runs}/side · rent ${args.rent} · ${trials} paired trials · seed ${args.seed}`,
		"",
		`harness  (UNIFORM top-up, what permutationTrial does): ${band(counts.uniform)}`,
		`shipped  (NEYMAN top-up, what the selector does):      ${band(counts.neyman)}`,
		`difference: ${((100 * (counts.neyman - counts.uniform)) / trials).toFixed(2)}pt` +
			`  ·  discordant: uniform-only ${counts.uniformOnly}, neyman-only ${counts.neymanOnly}`,
		"",
		"Read: both arms see the SAME split and the SAME drawn top-up values, so the",
		"difference is the placement rule alone. A positive difference means the published",
		"permutation false-positive rate UNDERSTATES the gate the selector actually runs.",
	];
}

export function main(argv: string[]): number {
	const args = parsePlacementArgs(argv);
	// READ-ONLY, and deliberately not `openDb`: that runs pending migrations, and
	// a measurement of the user's ledger must never write to it.
	const db = new Database(args.dbPath ?? defaultDbPath(), {
		readonly: true,
		fileMustExist: true,
	});
	try {
		const groups = groupReplicates(
			goldenReplicateRuns(db, args.agent),
			2 * args.runs,
		);
		if (groups.length < 2) {
			console.log(
				`NO: agent ${args.agent} has fewer than 2 tasks with ${2 * args.runs}+ recorded active-set replicates.`,
			);
			return 1;
		}
		const counts = comparePlacements(
			groups,
			args.runs,
			args.rent,
			args.trials,
			args.seed,
		);
		for (const line of renderPlacement(counts, groups, args)) console.log(line);
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
