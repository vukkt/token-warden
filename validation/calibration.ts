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
import { assessDelta, verdict } from "../src/select.js";

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
	console.log(
		"\nRead: each cell is the keep-rate. The '0 (FP)' row is the false-positive rate (keeping a zero-effect rule); it must stay low. z=1 was the old default (~16% FP); z=2 is the new default (~2-3% FP) — at the cost of needing a bigger effect or more runs for power. The derailment model shows the cost of heavy-tailed outliers.",
	);
	return 0;
}

process.exit(main());
