/**
 * ENGINE CALIBRATION — how small a real saving can the selector reliably keep?
 *
 * The engine calibrating itself: this Monte-Carlo injects synthetic rules with a
 * KNOWN true effect size and KNOWN run-to-run noise into the *real* verdict path
 * (`assessDelta` + `verdict` from src/select.ts), then measures how often the
 * engine keeps them. Spends NO tokens — it is pure simulation over the actual
 * decision functions.
 *
 *   - true effect = 0  → keep-rate is the FALSE-POSITIVE rate (should be ~0)
 *   - true effect > 0  → keep-rate is the POWER (we want this high)
 *   - the smallest effect with power ≥ 0.8 is the MINIMUM DETECTABLE SAVING
 *
 * It runs two noise models: a clean Gaussian, and a "derailment" model where a
 * fraction of runs blow up to ~1.8× cost (the heavy right tail we saw on real
 * golden tasks, e.g. sql-05 96k vs 42k). The gap between the two quantifies how
 * much the outliers cost us — and motivates robust aggregation.
 *
 *   npx tsx validation/calibration.ts
 */
import { summarizeTask, type TaskSummary } from "../src/bench.js";
import { assessDelta, effectiveRent, verdict } from "../src/select.js";

const BASELINE = 60_000; // representative golden-session token cost
const RENT = 25; // representative rule context rent (tokens)
const TASKS = 5; // golden-suite size
const TRIALS = 4000;
const SIGMA_FRAC = 0.25; // observed run-to-run noise (~25% of baseline)
const DERAIL_PROB = 0.15; // chance a run "derails"
const DERAIL_FACTOR = 1.8; // ...to ~1.8× cost
const EFFECT_FRACS = [0, 0.02, 0.05, 0.08, 0.1, 0.15, 0.2, 0.3];
const RUN_COUNTS = [2, 3, 5];
const POWER_TARGET = 0.8;

// --- anytime-valid confidence-sequence retention policy (validation only) ---
// A candidate retention rule tested against two-strike on the SAME simulated
// re-audit draws. Parameters of the normal-mixture time-uniform boundary
// (Howard, Ramdas, McAuliffe, Sekhon 2021, "Time-uniform, nonparametric,
// nonasymptotic confidence sequences", Ann. Statist. 49(2)): significance level
// alpha and mixing scale rho of the conjugate-normal mixture. Both are fixed and
// documented here; they are NOT tuned after seeing results (pre-declared).
const CS_ALPHA = 0.05; // one-mixture significance level
const CS_RHO = 1; // mixture scale (tuning parameter of the normal mixture)
const CS_SE_DRAWS = 4000; // draws used to estimate the per-audit standard error
const CS_MC_LIVES = 2000; // Monte-Carlo rule-lifetimes per cell
const CS_LIFE_CAP = 500; // cap a simulated life at this many cycles ("> 500")
// Pre-declared decision criterion (see docs/specs/confidence-sequences.md): the
// CS policy wins only if BOTH the dead-rule expected exit is at most this many
// cycles AND the true-earner lifetime is at least two-strike's at every effect.
const CS_DEAD_EXIT_MAX = 8;

/** Deterministic PRNG (mulberry32) so the calibration is reproducible. */
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

/** Standard normal via Box-Muller. */
function normal(rng: () => number, mean: number, sd: number): number {
	const u = Math.max(rng(), 1e-12);
	const v = rng();
	return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

type NoiseModel = "gaussian" | "derailment";

function runTokens(
	rng: () => number,
	mean: number,
	sd: number,
	model: NoiseModel,
): number {
	if (model === "derailment" && rng() < DERAIL_PROB) {
		return Math.round(mean * DERAIL_FACTOR);
	}
	return Math.max(0, Math.round(normal(rng, mean, sd)));
}

function side(
	rng: () => number,
	mean: number,
	sd: number,
	runs: number,
	model: NoiseModel,
): TaskSummary[] {
	const out: TaskSummary[] = [];
	for (let t = 0; t < TASKS; t++) {
		const results = Array.from({ length: runs }, (_, i) => ({
			sessionId: `t${t}-r${i}`,
			tokens: runTokens(rng, mean, sd, model),
			completed: true,
		}));
		out.push(summarizeTask(`t${t}`, results));
	}
	return out;
}

/** One trial: keep iff the candidate clears the gate confidently (the real
 * candidate-promotion logic: not regressed, not uncertain, verdict active). */
function keptOnce(
	rng: () => number,
	trueDelta: number,
	sd: number,
	runs: number,
	model: NoiseModel,
): boolean {
	const without = side(rng, BASELINE, sd, runs, model);
	const withRule = side(rng, BASELINE - trueDelta, sd, runs, model);
	const a = assessDelta(without, withRule, RENT);
	if (a.regression || a.delta === null || a.uncertain) return false;
	return verdict({ measuredDelta: a.delta, contextCost: RENT }) === "active";
}

export function keepRate(
	rng: () => number,
	trueDelta: number,
	runs: number,
	model: NoiseModel,
): number {
	const sd = BASELINE * SIGMA_FRAC;
	let kept = 0;
	for (let i = 0; i < TRIALS; i++) {
		if (keptOnce(rng, trueDelta, sd, runs, model)) kept++;
	}
	return kept / TRIALS;
}

function pct(x: number): string {
	return `${(x * 100).toFixed(1)}%`;
}

function report(model: NoiseModel, z: number): void {
	process.env.WARDEN_CONFIDENCE_Z = String(z);
	console.log(
		`\n=== noise model: ${model} · confidence z=${z} (σ=${pct(SIGMA_FRAC)} of baseline${model === "derailment" ? `, ${pct(DERAIL_PROB)} runs ×${DERAIL_FACTOR}` : ""}) ===`,
	);
	const header = [
		"effect".padStart(10),
		...RUN_COUNTS.map((r) => `runs=${r}`.padStart(9)),
	];
	console.log(header.join("  "));
	const minDetectable: Record<number, number | null> = {};
	for (const r of RUN_COUNTS) minDetectable[r] = null;
	for (const frac of EFFECT_FRACS) {
		const delta = Math.round(BASELINE * frac);
		const cells = RUN_COUNTS.map((runs) => {
			// Fresh-seeded per cell for reproducibility independent of order.
			const rng = mulberry32(
				0x9e3779b1 ^ (runs * 131 + Math.round(frac * 1000)),
			);
			const rate = keepRate(rng, delta, runs, model);
			if (frac > 0 && minDetectable[runs] === null && rate >= POWER_TARGET) {
				minDetectable[runs] = frac;
			}
			return pct(rate).padStart(9);
		});
		const tag = frac === 0 ? "0 (FP)" : `${pct(frac)} (${delta})`;
		console.log([tag.padStart(10), ...cells].join("  "));
	}
	const md = RUN_COUNTS.map(
		(r) =>
			`runs=${r}: ${minDetectable[r] === null ? "> 30%" : `~${pct(minDetectable[r] as number)} (${Math.round(BASELINE * (minDetectable[r] as number))} tok/session)`}`,
	);
	console.log(
		`min detectable saving (power ≥ ${pct(POWER_TARGET)}): ${md.join("  ·  ")}`,
	);
}

/** One simulated re-audit of an ACTIVE rule with known true effect: measures
 * the without-configuration against the with-rule baseline (the real re-audit
 * frame) and returns whether the point estimate lands below the bar — the
 * event that costs a strike (two-strike policy) or the rule (old one-strike
 * policy). Uncertainty is irrelevant here: re-audits are a point-estimate
 * test by design. */
function reAuditSubThreshold(
	rng: () => number,
	trueDelta: number,
	sd: number,
	runs: number,
	model: NoiseModel,
): boolean {
	const withRule = side(rng, BASELINE - trueDelta, sd, runs, model);
	const without = side(rng, BASELINE, sd, runs, model);
	const a = assessDelta(without, withRule, RENT);
	if (a.regression || a.delta === null) return true;
	return verdict({ measuredDelta: a.delta, contextCost: RENT }) === "evicted";
}

/** One simulated re-audit returning the point ESTIMATE (not just the pass/fail
 * of reAuditSubThreshold) plus the regression flag — the confidence sequence
 * accumulates the running mean of these estimates across cycles. Same draws,
 * same assessDelta path as reAuditSubThreshold; only the return value differs. */
function reAuditDelta(
	rng: () => number,
	trueDelta: number,
	sd: number,
	runs: number,
	model: NoiseModel,
): { delta: number | null; regression: boolean } {
	const withRule = side(rng, BASELINE - trueDelta, sd, runs, model);
	const without = side(rng, BASELINE, sd, runs, model);
	const a = assessDelta(without, withRule, RENT);
	return { delta: a.delta, regression: a.regression };
}

/** Per-audit standard error of the re-audit point estimate, estimated as the
 * empirical standard deviation of many independent single-audit draws (the
 * "same simulation draws" the boundary is applied to). */
function estimateAuditSE(
	seed: number,
	trueDelta: number,
	sd: number,
	runs: number,
	model: NoiseModel,
): number {
	const rng = mulberry32(seed);
	const xs: number[] = [];
	for (let i = 0; i < CS_SE_DRAWS; i++) {
		const { delta } = reAuditDelta(rng, trueDelta, sd, runs, model);
		if (delta !== null) xs.push(delta);
	}
	if (xs.length < 2) return 0;
	const mu = xs.reduce((a, b) => a + b, 0) / xs.length;
	const v = xs.reduce((acc, x) => acc + (x - mu) ** 2, 0) / (xs.length - 1);
	return Math.sqrt(v);
}

/**
 * Anytime-valid half-width of the running-mean confidence sequence after `t`
 * audits, the normal-mixture time-uniform boundary (Howard et al. 2021, eq. for
 * the conjugate-mixture sub-Gaussian bound):
 *
 *   u(t) = SE * sqrt( ((t*rho^2 + 1) / (t^2 * rho^2)) * log( (t*rho^2 + 1) / alpha^2 ) )
 *
 * with alpha = CS_ALPHA and rho = CS_RHO. UCB_t = mean_t + u(t). Unlike a fixed
 * z*SE/sqrt(t) band it stays valid under continuous peeking across every cycle.
 */
function csHalfWidth(se: number, t: number): number {
	const r2 = CS_RHO * CS_RHO;
	const num = t * r2 + 1;
	return (
		se * Math.sqrt((num / (t * t * r2)) * Math.log(num / (CS_ALPHA * CS_ALPHA)))
	);
}

/**
 * Monte-Carlo expected lifetime of a rule under the confidence-sequence policy:
 * evidence accumulates across re-audits (running mean of all past point
 * estimates); the rule is evicted the first cycle its anytime-valid UPPER
 * confidence bound falls below the bar (time-uniform confidence it does not earn
 * its rent) or a regression fires (immediate, as in every policy). Path-dependent
 * so it is simulated, not analytic. Lives are capped at CS_LIFE_CAP cycles;
 * `capped` is set when every simulated life reached the cap without eviction.
 */
function confSeqLife(
	seed: number,
	trueDelta: number,
	sd: number,
	runs: number,
	model: NoiseModel,
	se: number,
	bar: number,
): { mean: number; capped: boolean } {
	const rng = mulberry32(seed);
	let total = 0;
	let cappedCount = 0;
	for (let life = 0; life < CS_MC_LIVES; life++) {
		let sum = 0;
		let lifetime = CS_LIFE_CAP;
		let reachedCap = true;
		for (let t = 1; t <= CS_LIFE_CAP; t++) {
			const { delta, regression } = reAuditDelta(
				rng,
				trueDelta,
				sd,
				runs,
				model,
			);
			if (regression || delta === null) {
				lifetime = t;
				reachedCap = false;
				break;
			}
			sum += delta;
			const ucb = sum / t + csHalfWidth(se, t);
			if (ucb < bar) {
				lifetime = t;
				reachedCap = false;
				break;
			}
		}
		if (reachedCap) cappedCount++;
		total += lifetime;
	}
	return { mean: total / CS_MC_LIVES, capped: cappedCount === CS_MC_LIVES };
}

/**
 * RE-AUDIT CHURN — why retention is two-strike, not one-strike.
 *
 * Admission demands delta ≥ bar + z·SE, but retention only tests the point
 * estimate against the bar. Because bar (~2×rent, tens of tokens) is tiny
 * next to the SE (thousands), every re-audit of a genuine earner is a coin
 * with a small — but compounding — chance of landing below the bar
 * (regression to the mean). Under the old one-strike policy that chance IS
 * the per-cycle eviction rate; under two-strike (evict only on the second
 * CONSECUTIVE sub-threshold re-audit, a pass clears the strike) it is
 * squared. Re-audit draws are independent across cycles, so expected
 * lifetimes follow exactly: one-strike 1/p, two-strike (1+p)/p².
 *
 * The flip side to check: a DEAD rule (effect 0) must still leave quickly.
 * With p ≈ 0.5 for a dead rule, two-strike stretches its stay from ~2 to ~6
 * cycles — a few extra sessions of ~rent tokens, trivial against losing a
 * multi-thousand-token earner to one noisy draw.
 *
 * The fourth column pits an anytime-valid CONFIDENCE SEQUENCE against
 * two-strike on the identical draws (see the Howard et al. 2021 boundary
 * above), evaluated against the pre-declared decision criterion.
 */
function churnReport(model: NoiseModel): void {
	const sd = BASELINE * SIGMA_FRAC;
	const runs = 3;
	// The retention bar the CS upper bound must clear: 2x the (cache-aware)
	// effective rent — the exact quantity the production verdict() tests against.
	const bar = 2 * effectiveRent(RENT);
	console.log(
		`\n=== re-audit churn: one/two-strike vs confidence-sequence · noise model: ${model} · runs=${runs} · bar=${bar.toFixed(1)} tok ===`,
	);
	console.log(
		[
			"effect".padStart(10),
			"P(sub)/cycle".padStart(13),
			"1-strike life".padStart(14),
			"2-strike life".padStart(14),
			"per-audit SE".padStart(13),
			"conf-seq life".padStart(14),
		].join("  "),
	);
	// Per-effect results, gathered to apply the pre-declared criterion below.
	let deadCsLife = Number.POSITIVE_INFINITY;
	let deadCsCapped = false;
	let earnerBeatsTwoStrike = true; // does CS keep every earner at least as long?
	for (const frac of [0, 0.05, 0.1, 0.2]) {
		const delta = Math.round(BASELINE * frac);
		const rng = mulberry32(0x51ed270b ^ Math.round(frac * 1000));
		let sub = 0;
		for (let i = 0; i < TRIALS; i++) {
			if (reAuditSubThreshold(rng, delta, sd, runs, model)) sub++;
		}
		const p = sub / TRIALS;
		const oneStrike = p === 0 ? Number.POSITIVE_INFINITY : 1 / p;
		const twoStrike = p === 0 ? Number.POSITIVE_INFINITY : (1 + p) / p ** 2;
		const life = (x: number): string =>
			Number.isFinite(x) ? `${x.toFixed(1)} cyc` : "never";

		// Confidence-sequence policy on the same generative model. Distinct seed
		// namespaces (0xC5..., 0x5E...) so the CS draws never perturb the
		// established one/two-strike columns above.
		const se = estimateAuditSE(
			0x5e5e0000 ^ (Math.round(frac * 1000) + (model === "derailment" ? 7 : 0)),
			delta,
			sd,
			runs,
			model,
		);
		const cs = confSeqLife(
			0xc5c50000 ^ (Math.round(frac * 1000) + (model === "derailment" ? 7 : 0)),
			delta,
			sd,
			runs,
			model,
			se,
			bar,
		);
		const csLife = cs.capped ? "> 500 cyc" : `${cs.mean.toFixed(1)} cyc`;
		if (frac === 0) {
			deadCsLife = cs.mean;
			deadCsCapped = cs.capped;
		} else {
			// CS "keeps the earner at least as long" when its lifetime is censored at
			// the cap (it never churned the earner within the horizon) or its mean
			// meets/exceeds two-strike's.
			if (!(cs.capped || cs.mean >= twoStrike)) earnerBeatsTwoStrike = false;
		}

		const tag = frac === 0 ? "0 (dead)" : `${pct(frac)} (${delta})`;
		console.log(
			[
				tag.padStart(10),
				pct(p).padStart(13),
				life(oneStrike).padStart(14),
				life(twoStrike).padStart(14),
				se.toFixed(0).padStart(13),
				csLife.padStart(14),
			].join("  "),
		);
	}

	// Pre-declared criterion: CS wins iff dead-rule exit <= CS_DEAD_EXIT_MAX AND
	// earner lifetime >= two-strike at every effect. A negative result is valid.
	const deadOk = !deadCsCapped && deadCsLife <= CS_DEAD_EXIT_MAX;
	const deadLifeStr = deadCsCapped ? "> 500" : deadCsLife.toFixed(1);
	const csWins = deadOk && earnerBeatsTwoStrike;
	console.log(
		`criterion [${model}]: dead-rule exit ${deadLifeStr} cyc <= ${CS_DEAD_EXIT_MAX}? ${deadOk ? "yes" : "NO"} AND earner life >= two-strike at every effect? ${earnerBeatsTwoStrike ? "yes" : "NO"} => confidence-sequence ${csWins ? "WINS (would replace two-strike)" : "LOSES (two-strike stays)"}`,
	);
}

function main(): number {
	console.log(
		"=== token-warden engine calibration (synthetic, zero tokens) ===",
	);
	console.log(
		`baseline ${BASELINE} tok/session · rent ${RENT} · ${TASKS} tasks · ${TRIALS} trials/cell`,
	);
	for (const z of [1, 2]) {
		report("gaussian", z);
		report("derailment", z);
	}
	delete process.env.WARDEN_CONFIDENCE_Z;
	churnReport("gaussian");
	churnReport("derailment");
	console.log(
		"\nRead: each cell is the keep-rate. The '0 (FP)' row is the false-positive rate (keeping a zero-effect rule); it must stay low. z=1 was the old default (~16% FP); z=2 is the new default (~2-3% FP) — at the cost of needing a bigger effect or more runs for power. The derailment model shows the cost of heavy-tailed outliers.",
	);
	console.log(
		"The churn tables show expected active lifetime (in re-audit cycles) of a rule with a given TRUE effect: one-strike churns real earners at the per-cycle sub-threshold rate; two-strike squares it while a dead rule still exits within a few cycles.",
	);
	console.log(
		"Confidence-sequence column (NEGATIVE result): the anytime-valid upper bound UCB_t = mean_t + u(t) evicts only when it drops below the bar (~54 tok), but the per-audit SE is thousands of tokens. Shrinking u(t) below the bar needs t on the order of (SE/bar)^2 audits, so a DEAD rule essentially never exits (> 500 cycles) — the dead-rule leg of the pre-declared criterion fails. CS keeps genuine earners effectively forever, but so does it keep zero-value rules; the binding constraint is the bar/SE ratio, not the CS theory. Two-strike stays as the retention policy. Tuning alpha/rho would not close a gap this large and was not attempted.",
	);
	return 0;
}

process.exit(main());
