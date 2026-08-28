/**
 * STREAM CALIBRATION — does online FDR hold its rate on the REAL noise?
 *
 * `empirical-calibration.ts` measures one decision at a time and reports a
 * per-decision false-positive rate (8.9% on the recorded `sql` pool). That
 * number cannot answer the question this project actually has, which is about a
 * whole memory file accumulated over many decisions: of the rules this agent
 * ended up carrying, what fraction were noise, and what did the set save?
 *
 * So this harness runs STREAMS. Each trial is a long run of arrivals, some
 * genuinely valuable and some worthless, decided in order. It compares the
 * shipped confidence multiple against any other, and reports NET TOKENS beside
 * the error rates -- which is what turned "better false-discovery rate" into
 * "fewer tokens saved" and set the shipped default of z=1.5.
 *
 * Both arms see IDENTICAL draws (common random numbers), so the comparison
 * isolates the decision rule from the sampling.
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
 *     [--trials N] [--length N] [--runs N] [--rent N] [--compare-z F]
 *     [--overlap F] [--true-rate F] [--saving F] [--seed N] [--harm N]
 *
 * `--harm` is the term every earlier sweep set to zero without saying so; the
 * run always reports the BREAK-EVEN harm between the two arms, which is the
 * number that decides the comparison. See FINDINGS 2026-08-26.
 */
import { pathToFileURL } from "node:url";
import { numericFlag } from "../src/cli.js";
import { goldenReplicateRuns, openDb } from "../src/db.js";
import { assertKnownAgent } from "../src/registry.js";
import { assessDelta } from "../src/select.js";
import { confidenceZ } from "../src/stats.js";
import {
	groupReplicates,
	promotedAt,
	toSummary,
} from "./empirical-calibration.js";
import { lcg32, shuffled } from "./rng.js";

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
	 * rent, and every kept WORTHLESS rule additionally pays `harm`. This is the
	 * objective the project actually has, and it is not the one an FDR is a
	 * proxy for -- see the note this harness prints.
	 */
	netTokensPerRun: number;
	/** Worthless rules kept per stream. The coefficient on `harm`, and the
	 * quantity the break-even calculation differences between arms. */
	falseDiscoveries: number;
	/** Net tokens excluding the harm term, so a break-even can be solved
	 * without re-running the streams at every candidate harm. */
	netBeforeHarm: number;
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
	harm: number,
): ArmResult {
	const kept = discoveries / trials;
	const realKept = trueDiscoveries / trials;
	const falseKept = kept - realKept;
	// Geometric decay of the marginal saving: sum_{j=0}^{k-1} overlap^j.
	// At overlap = 1 this is exactly k, the additive model.
	const jointSaving =
		overlap >= 1
			? realKept * trueSaving
			: trueSaving * ((1 - overlap ** realKept) / (1 - overlap));
	// Real rules pay their JOINT saving; EVERY kept rule pays rent.
	const netBeforeHarm = jointSaving - kept * rent;
	return {
		label,
		falseDiscoveryProportion:
			perTrialFdp.reduce((a, b) => a + b, 0) / Math.max(1, perTrialFdp.length),
		discoveries: kept,
		trueDiscoveries: realKept,
		missedReal: missedReal / trials,
		falseDiscoveries: falseKept,
		netBeforeHarm,
		netTokensPerRun: netBeforeHarm - falseKept * harm,
	};
}

/** The two numbers a net-tokens line is made of. Everything else on an
 * `ArmResult` is reporting; these two are the algebra. */
export type HarmLine = Pick<ArmResult, "netBeforeHarm" | "falseDiscoveries">;

/**
 * The harm at which two arms tie on net tokens.
 *
 * Net is linear in `harm`: `net = netBeforeHarm - falseKept * harm`, so the
 * arms cross at exactly one point and it can be solved rather than searched:
 *
 *     h* = (netBeforeHarm_a - netBeforeHarm_b) / (falseKept_a - falseKept_b)
 *
 * Null when the arms keep the same number of worthless rules (the lines are
 * parallel -- one arm dominates at every harm), or when the crossing is at a
 * negative harm, which is not a quantity this project can have: it would mean
 * a worthless rule PAYS beyond saving its own rent.
 */
export function breakEvenHarm(a: HarmLine, b: HarmLine): number | null {
	const spread = a.falseDiscoveries - b.falseDiscoveries;
	if (Math.abs(spread) < 1e-9) return null;
	const h = (a.netBeforeHarm - b.netBeforeHarm) / spread;
	return h > 0 ? h : null;
}

export function runStreams(
	groups: { taskId: string; totals: number[] }[],
	options: {
		trials: number;
		length: number;
		runs: number;
		rent: number;
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
		/**
		 * What one KEPT WORTHLESS rule costs per run BEYOND its rent.
		 *
		 * Defaults to 0, which is the assumption every earlier sweep made
		 * silently, and it is the reason they all pointed the same way. At harm=0
		 * a false positive is nearly free -- 25 tokens of rent against a missed
		 * rule's ~4,769 -- so net tokens rise monotonically as the gate loosens
		 * and the optimum sits at z=0 for any overlap this project can defend.
		 * "Be maximally permissive" is not a finding about the noise; it is that
		 * assumption read back.
		 *
		 * The assumption is also the least defensible thing in the model. A
		 * worthless rule is not inert: it is an instruction in the agent's prompt
		 * every session, and one that provokes a single extra tool call costs
		 * 14,018 tokens (FINDINGS: within-task regression, R^2 94.6%) -- 560x its
		 * rent. Nobody has measured it, so this stays a parameter rather than a
		 * new default, and `breakEvenHarm` reports the value at which the
		 * shipped gate becomes the right one.
		 */
		harm?: number;
		/** Confidence multiple for the COMPARISON arm. Omitted means the shipped
		 * `confidenceZ()`; supplied lets a sweep find where the net-token
		 * optimum actually sits, including below the 1.0 floor that
		 * `confidenceZ` refuses from the environment. */
		compareZ?: number;
	},
): ArmResult[] {
	const altFdp: number[] = [];
	const baseFdp: number[] = [];
	let altFound = 0;
	let altTrue = 0;
	let altMissed = 0;
	let baseFound = 0;
	let baseTrue = 0;
	let baseMissed = 0;

	for (let trial = 0; trial < options.trials; trial++) {
		// One RNG per trial, seeded from the trial index, so both arms replay the
		// identical arrival sequence and any difference is the decision rule.
		const rng = lcg32(options.seed + trial * 7919);
		let altFalse = 0;
		let altTotal = 0;
		let baseFalse = 0;
		let baseTotal = 0;

		for (let t = 0; t < options.length; t++) {
			const arrival = drawArrival(
				rng,
				groups,
				options.runs,
				options.trueRate,
				options.saving,
				`t${t}`,
			);

			// Baseline arm: the shipped gate.
			const baseKeep = promotedAt(
				assessDelta(arrival.without, arrival.withRule, options.rent),
				options.rent,
			);
			if (baseKeep) {
				baseTotal += 1;
				if (arrival.real) baseTrue += 1;
				else baseFalse += 1;
			} else if (arrival.real) {
				baseMissed += 1;
			}

			// Comparison arm: a different confidence multiple, same draws.
			const altKeep = promotedAt(
				assessDelta(
					arrival.without,
					arrival.withRule,
					options.rent,
					options.compareZ,
				),
				options.rent,
			);
			if (altKeep) {
				altTotal += 1;
				if (arrival.real) altTrue += 1;
				else altFalse += 1;
			} else if (arrival.real) {
				altMissed += 1;
			}
		}

		altFdp.push(altTotal === 0 ? 0 : altFalse / altTotal);
		baseFdp.push(baseTotal === 0 ? 0 : baseFalse / baseTotal);
		altFound += altTotal;
		baseFound += baseTotal;
	}

	// The saving a genuinely valuable arrival carries, in tokens per run: the
	// same quantity drawArrival subtracts from the with-rule side.
	const pooledMean =
		groups.reduce(
			(acc, g) => acc + g.totals.reduce((x, y) => x + y, 0) / g.totals.length,
			0,
		) / groups.length;
	const trueSaving = pooledMean * options.saving;

	return [
		summarise(
			`shipped z=${confidenceZ()}`,
			baseFdp,
			baseFound,
			baseTrue,
			baseMissed,
			options.trials,
			trueSaving,
			options.rent,
			options.overlap ?? 1,
			options.harm ?? 0,
		),
		summarise(
			`compare z=${options.compareZ ?? confidenceZ()}`,
			altFdp,
			altFound,
			altTrue,
			altMissed,
			options.trials,
			trueSaving,
			options.rent,
			options.overlap ?? 1,
			options.harm ?? 0,
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
	const trueRate = flag("--true-rate", 0.2);
	const saving = flag("--saving", 0.1);
	const seed = flag("--seed", 42);
	const overlap = flag("--overlap", 1);
	const harm = flag("--harm", 0);
	const compareZAt = argv.indexOf("--compare-z");
	const compareZ =
		compareZAt >= 0 ? numericFlag(argv[compareZAt + 1]) : undefined;

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
			`${(saving * 100).toFixed(0)}% saving - seed ${seed}\n`,
	);

	const results = runStreams(groups, {
		trials,
		length,
		runs,
		rent,
		trueRate,
		saving,
		seed,
		overlap,
		harm,
		...(compareZ !== undefined && Number.isFinite(compareZ)
			? { compareZ }
			: {}),
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
			`averaged over trials.\n` +
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
			`can still be the arm that saves more tokens. Judge on NET tok/run.\n` +
			`This sweep is what set the shipped default of z=1.5.`,
	);

	const [shipped, compared] = results as [ArmResult, ArmResult];
	const crossing = breakEvenHarm(shipped, compared);
	console.log(
		`\n--- harm accounting (harm = ${Math.round(harm).toLocaleString("en-US")} tok/run per kept worthless rule) ---`,
	);
	if (crossing === null) {
		console.log(
			"The two arms keep the same number of worthless rules, so harm cannot\n" +
				"separate them: one dominates at every harm.",
		);
	} else {
		const looser =
			compared.falseDiscoveries > shipped.falseDiscoveries ? compared : shipped;
		const tighter = looser === compared ? shipped : compared;
		console.log(
			`BREAK-EVEN HARM: ${Math.round(crossing).toLocaleString("en-US")} tok/run.\n` +
				`Below it '${looser.label}' wins; above it '${tighter.label}' does.\n` +
				`\nThat number is the whole argument, because harm has never been\n` +
				`measured. It is the cost of one worthless rule sitting in the prompt\n` +
				`every session, BEYOND the ${rent} tokens of rent already charged. Every\n` +
				`sweep before this one fixed it at 0 without saying so, which is why\n` +
				`they all concluded the gate should loosen -- at harm=0 a false positive\n` +
				`is nearly free and the optimum is z=0 for any overlap this project can\n` +
				`defend. Compare the break-even against 14,018 tok/run, the measured\n` +
				`cost of ONE extra tool call (FINDINGS, R^2 94.6%): if a worthless rule\n` +
				`provokes an extra call in even ${((crossing / 14018) * 100).toFixed(
					1,
				)}% of sessions, the tighter arm wins.`,
		);
	}
	return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	process.exit(main(process.argv.slice(2)));
}
