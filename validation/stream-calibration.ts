/**
 * STREAM CALIBRATION — does online FDR hold its rate on the REAL noise?
 *
 * `empirical-calibration.ts` measures one decision at a time: every trial is
 * independent, and the answer is a per-decision false-positive rate (8.9% on
 * the recorded `sql` pool). That is the right question for a fixed threshold
 * and the WRONG one for LORD++, whose whole claim is about a sequence. A
 * procedure that spends and re-earns alpha-wealth cannot be evaluated by
 * replaying its first decision N times.
 *
 * So this harness runs STREAMS. Each trial is a long run of arrivals, some
 * genuinely valuable and some worthless, decided in order, with the alpha-wealth
 * carried forward exactly as `select.ts` carries it. The reported number is the
 * false-discovery proportion over the whole stream: of the rules this agent
 * ended up carrying, what fraction were noise?
 *
 * Both arms see IDENTICAL draws (common random numbers), so the comparison
 * isolates the decision rule from the sampling. They diverge only in which
 * arrivals they promote -- which is the point, since that divergence is what
 * feeds back into LORD's wealth.
 *
 * Sampling matches empirical-calibration:
 *   - a NULL arrival is a permutation A/A split of one task's replicate pool,
 *     so its true delta is 0 by construction with no distributional assumption;
 *   - a REAL arrival is a bootstrap draw of both sides with a known saving
 *     subtracted from the with-rule side.
 *
 * Zero tokens: every "run" is a token total already in the runs table.
 *
 *   npx tsx validation/stream-calibration.ts [--agent <name>] [--db <path>]
 *     [--trials N] [--length N] [--runs N] [--rent N] [--alpha F]
 *     [--true-rate F] [--saving F] [--seed N]
 */
import { pathToFileURL } from "node:url";
import { numericFlag } from "../src/cli.js";
import { goldenReplicateRuns, openDb } from "../src/db.js";
import { lordZ } from "../src/fdr.js";
import { assertKnownAgent } from "../src/registry.js";
import { assessDelta } from "../src/select.js";
import {
	groupReplicates,
	promotedAt,
	toSummary,
} from "./empirical-calibration.js";

/** Deterministic LCG so a reported number can be reproduced exactly. */
function lcg(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (1664525 * s + 1013904223) >>> 0;
		return s / 4294967296;
	};
}

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

function resample(rng: () => number, pool: number[], n: number): number[] {
	const out: number[] = [];
	for (let i = 0; i < n; i++) {
		out.push(pool[Math.floor(rng() * pool.length)] as number);
	}
	return out;
}

interface Arrival {
	/** Whether this arrival carries a genuine saving. */
	real: boolean;
	without: ReturnType<typeof toSummary>[];
	withRule: ReturnType<typeof toSummary>[];
}

/** One arrival's measurement, drawn once and shown to both arms. */
function drawArrival(
	rng: () => number,
	groups: { taskId: string; totals: number[] }[],
	runs: number,
	trueRate: number,
	savingFraction: number,
	tag: string,
): Arrival {
	const real = rng() < trueRate;
	const without = [];
	const withRule = [];
	for (const group of groups) {
		if (real) {
			// Bootstrap both sides, then subtract a KNOWN saving from the
			// with-rule side: a semi-synthetic true effect on real noise.
			const pool = group.totals;
			const a = resample(rng, pool, runs);
			const b = resample(rng, pool, runs);
			const mean = pool.reduce((x, y) => x + y, 0) / pool.length;
			const saving = mean * savingFraction;
			without.push(toSummary(group.taskId, a, `${tag}-wo`));
			withRule.push(
				toSummary(
					group.taskId,
					b.map((t) => Math.max(1, t - saving)),
					`${tag}-wi`,
				),
			);
		} else {
			// Permutation A/A: both sides from one shuffle of the same pool, so
			// the true delta is 0 and the runs are exchangeable under that null.
			const deck = shuffled(rng, group.totals);
			without.push(toSummary(group.taskId, deck.slice(0, runs), `${tag}-wo`));
			withRule.push(
				toSummary(group.taskId, deck.slice(runs, runs * 2), `${tag}-wi`),
			);
		}
	}
	return { real, without, withRule };
}

interface ArmResult {
	label: string;
	falseDiscoveryProportion: number;
	discoveries: number;
	trueDiscoveries: number;
	missedReal: number;
	/**
	 * Expected NET tokens per run from the memory this arm ends up carrying:
	 * every genuinely valuable rule pays its saving, every kept rule pays its
	 * rent. This is the objective the project actually has, and it is not the
	 * one an FDR is a proxy for -- see the note this harness prints.
	 */
	netTokensPerRun: number;
}

function summarise(
	label: string,
	perTrialFdp: number[],
	discoveries: number,
	trueDiscoveries: number,
	missedReal: number,
	trials: number,
	trueSaving: number,
	rent: number,
	overlap: number,
): ArmResult {
	const kept = discoveries / trials;
	const realKept = trueDiscoveries / trials;
	// Geometric decay of the marginal saving: sum_{j=0}^{k-1} overlap^j.
	// At overlap = 1 this is exactly k, the additive model.
	const jointSaving =
		overlap >= 1
			? realKept * trueSaving
			: trueSaving * ((1 - overlap ** realKept) / (1 - overlap));
	return {
		label,
		falseDiscoveryProportion:
			perTrialFdp.reduce((a, b) => a + b, 0) / Math.max(1, perTrialFdp.length),
		discoveries: kept,
		trueDiscoveries: realKept,
		missedReal: missedReal / trials,
		// Real rules pay their JOINT saving; EVERY kept rule pays rent.
		netTokensPerRun: jointSaving - kept * rent,
	};
}

export function runStreams(
	groups: { taskId: string; totals: number[] }[],
	options: {
		trials: number;
		length: number;
		runs: number;
		rent: number;
		alpha: number;
		trueRate: number;
		saving: number;
		seed: number;
		/**
		 * How much the j-th kept real rule still saves, relative to the one
		 * before it: joint saving is `s * (1 - overlap^k) / (1 - overlap)`.
		 *
		 * 1.0 is ADDITIVE -- every real rule saves in full, forever. That is the
		 * model this harness started with, and it is wrong in a direction that
		 * flatters permissiveness: it is what makes "keep everything" look
		 * optimal. Real rules overlap (theorem IV's whole premise), so the
		 * marginal saving of the k-th decays. Below 1 the sum converges and the
		 * net-token optimum becomes finite.
		 */
		overlap?: number;
		/** Confidence multiple for the fixed arm. Omitted means the shipped
		 * `confidenceZ()`; supplied lets a sweep find where the net-token
		 * optimum actually sits, including below the 1.0 floor that
		 * `confidenceZ` refuses from the environment. */
		fixedZ?: number;
	},
): ArmResult[] {
	const lordFdp: number[] = [];
	const fixedFdp: number[] = [];
	let lordFound = 0;
	let lordTrue = 0;
	let lordMissed = 0;
	let fixedFound = 0;
	let fixedTrue = 0;
	let fixedMissed = 0;

	for (let trial = 0; trial < options.trials; trial++) {
		// One RNG per trial, seeded from the trial index, so both arms replay the
		// identical arrival sequence and any difference is the decision rule.
		const rng = lcg(options.seed + trial * 7919);
		const lordHistory: boolean[] = [];
		let lordFalse = 0;
		let lordTotal = 0;
		let fixedFalse = 0;
		let fixedTotal = 0;

		for (let t = 0; t < options.length; t++) {
			const arrival = drawArrival(
				rng,
				groups,
				options.runs,
				options.trueRate,
				options.saving,
				`t${t}`,
			);

			// LORD arm: threshold from this arrival's position in the stream.
			const z = lordZ(lordHistory, options.alpha);
			const lordAssessment = assessDelta(
				arrival.without,
				arrival.withRule,
				options.rent,
				z,
			);
			const lordKeep = promotedAt(lordAssessment, options.rent);
			lordHistory.push(lordKeep);
			if (lordKeep) {
				lordTotal += 1;
				if (arrival.real) lordTrue += 1;
				else lordFalse += 1;
			} else if (arrival.real) {
				lordMissed += 1;
			}

			// Fixed arm: the shipped gate, same draws.
			const fixedAssessment = assessDelta(
				arrival.without,
				arrival.withRule,
				options.rent,
				options.fixedZ,
			);
			const fixedKeep = promotedAt(fixedAssessment, options.rent);
			if (fixedKeep) {
				fixedTotal += 1;
				if (arrival.real) fixedTrue += 1;
				else fixedFalse += 1;
			} else if (arrival.real) {
				fixedMissed += 1;
			}
		}

		lordFdp.push(lordTotal === 0 ? 0 : lordFalse / lordTotal);
		fixedFdp.push(fixedTotal === 0 ? 0 : fixedFalse / fixedTotal);
		lordFound += lordTotal;
		fixedFound += fixedTotal;
	}

	// The saving a genuinely valuable arrival carries, in tokens per run: the
	// same quantity drawArrival subtracts from the with-rule side.
	const pooledMean =
		groups.reduce(
			(acc, g) => acc + g.totals.reduce((x, y) => x + y, 0) / g.totals.length,
			0,
		) / groups.length;
	const trueSaving = pooledMean * options.saving;

	const fixedLabel =
		options.fixedZ === undefined
			? "fixed z=2 (shipped)"
			: `fixed z=${options.fixedZ}`;
	return [
		summarise(
			fixedLabel,
			fixedFdp,
			fixedFound,
			fixedTrue,
			fixedMissed,
			options.trials,
			trueSaving,
			options.rent,
			options.overlap ?? 1,
		),
		summarise(
			"LORD++ online FDR",
			lordFdp,
			lordFound,
			lordTrue,
			lordMissed,
			options.trials,
			trueSaving,
			options.rent,
			options.overlap ?? 1,
		),
	];
}

function main(argv: string[]): number {
	const agentFlag = argv.indexOf("--agent");
	const agent = agentFlag >= 0 ? (argv[agentFlag + 1] as string) : "sql";
	assertKnownAgent(agent);
	const dbFlag = argv.indexOf("--db");
	const dbPath = dbFlag >= 0 ? (argv[dbFlag + 1] as string) : undefined;

	/** Read `--flag VALUE`, falling back to `fallback` when absent or blank.
	 * `numericFlag` maps missing/blank to NaN so a typo cannot silently become
	 * a policy nobody chose -- the same discipline as the env readers in
	 * stats.ts. */
	const flag = (name: string, fallback: number): number => {
		const at = argv.indexOf(name);
		if (at < 0) return fallback;
		const value = numericFlag(argv[at + 1]);
		return Number.isFinite(value) ? value : fallback;
	};

	const trials = flag("--trials", 200);
	const length = flag("--length", 60);
	const runs = flag("--runs", 2);
	const rent = flag("--rent", 25);
	const alpha = flag("--alpha", 0.1);
	const trueRate = flag("--true-rate", 0.2);
	const saving = flag("--saving", 0.1);
	const seed = flag("--seed", 42);
	const overlap = flag("--overlap", 1);
	const fixedZAt = argv.indexOf("--fixed-z");
	const fixedZ = fixedZAt >= 0 ? numericFlag(argv[fixedZAt + 1]) : undefined;

	const db = openDb(dbPath);
	const groups = groupReplicates(goldenReplicateRuns(db, agent), runs * 2);
	if (groups.length < 2) {
		console.log(
			`insufficient replicate history for ${agent} at runs=${runs}/side`,
		);
		return 0;
	}

	console.log("=== token-warden stream calibration (zero tokens) ===");
	console.log(
		`agent ${agent} - ${groups.length} tasks - runs ${runs}/side - rent ${rent}\n` +
			`streams of ${length} arrivals x ${trials} trials - ` +
			`${(trueRate * 100).toFixed(0)}% of arrivals carry a real ` +
			`${(saving * 100).toFixed(0)}% saving - alpha ${alpha} - seed ${seed}\n`,
	);

	const results = runStreams(groups, {
		trials,
		length,
		runs,
		rent,
		alpha,
		trueRate,
		saving,
		seed,
		overlap,
		...(fixedZ !== undefined && Number.isFinite(fixedZ) ? { fixedZ } : {}),
	});

	console.log(
		"arm                    stream FDR   kept   real kept   real missed   NET tok/run",
	);
	for (const r of results) {
		console.log(
			`${r.label.padEnd(22)} ${(r.falseDiscoveryProportion * 100)
				.toFixed(1)
				.padStart(
					9,
				)}%   ${r.discoveries.toFixed(1).padStart(4)}   ${r.trueDiscoveries
				.toFixed(1)
				.padStart(9)}   ${r.missedReal.toFixed(1).padStart(11)}   ${Math.round(
				r.netTokensPerRun,
			)
				.toLocaleString("en-US")
				.padStart(11)}`,
		);
	}
	console.log(
		`\nRead: stream FDR is the fraction of KEPT rules that were worthless,\n` +
			`averaged over trials. The online arm holds it far below the fixed arm.\n` +
			`\nBUT READ THE LAST COLUMN FIRST. FDR is a proxy, and for this project it\n` +
			`is a BADLY MISCALIBRATED one: a worthless rule costs only its rent\n` +
			`(${rent} tok/run) while a missed real rule forfeits its whole saving\n` +
			`(~${Math.round(
				(groups.reduce(
					(acc, g) =>
						acc + g.totals.reduce((x, y) => x + y, 0) / g.totals.length,
					0,
				) /
					groups.length) *
					saving,
			).toLocaleString(
				"en-US",
			)} tok/run here). False positives are roughly two orders of\n` +
			`magnitude cheaper than false negatives, so the arm with the WORSE FDR\n` +
			`can still be the arm that saves more tokens. Judge on NET tok/run.`,
	);
	return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	process.exit(main(process.argv.slice(2)));
}
