/**
 * The headless `claude -p --output-format json` boundary.
 *
 * Three paths call a model — the distiller, the compression rewriter, and the
 * prompt evolver — and each of them once hand-rolled `JSON.parse(stdout).result`.
 * That shape crashes on a bare `null` payload (valid JSON), and it silently
 * reads the CLI's own error envelope as if it were a model answer. Both bugs
 * were live. This module is the one place that knows what the envelope looks
 * like, so the three paths cannot drift again.
 *
 * Everything here treats model output as untrusted input: bounded before it is
 * parsed, validated at the boundary, and failing CLOSED with a reason the
 * caller can log. No retries — a caller drops the sample and moves on.
 */
import { z } from "zod";

/**
 * The model the distiller and the compression rewriter invoke.
 *
 * Read per call, not frozen at module load: every other config value in the
 * repo is read per call, and a module-level const silently ignores any
 * process.env set after import — which made the override untestable and let
 * import order decide the model.
 */
export function distillModel(): string {
	return process.env.TOKEN_WARDEN_DISTILL_MODEL ?? "sonnet";
}

/**
 * Hard ceiling on a model reply we are willing to run JSON.parse and two
 * regex passes over. The largest valid reply is two 200-character bodies, so
 * anything at this scale is garbage (or a 16 MB stdout buffer) and parsing it
 * only burns CPU on untrusted input.
 */
export const MAX_MODEL_REPLY_CHARS = 64_000;

/** Strip a stray markdown code fence the model wrapped its JSON in. The fence
 * is tolerated; nothing inside it is. */
export function stripJsonFence(text: string): string {
	return text
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/, "");
}

/** The `claude -p --output-format json` envelope, validated at the boundary.
 * Unknown fields are tolerated (the CLI adds them over time); the shape we
 * depend on is not. */
const claudeEnvelopeSchema = z.looseObject({
	result: z.string().optional(),
	is_error: z.boolean().optional(),
});

export type EnvelopeParse =
	| { ok: true; result: string }
	| { ok: false; reason: string };

/**
 * Validate a headless `claude` stdout envelope and extract its `result` text.
 *
 * Failing closed with a reason is the contract: callers log it and drop the
 * sample, never retry.
 */
export function parseClaudeEnvelope(stdout: string | undefined): EnvelopeParse {
	if (typeof stdout !== "string" || stdout.trim() === "") {
		return { ok: false, reason: "stdout was empty" };
	}
	if (stdout.length > MAX_MODEL_REPLY_CHARS) {
		return {
			ok: false,
			reason: `stdout was ${stdout.length} chars, over the ${MAX_MODEL_REPLY_CHARS} cap`,
		};
	}
	let raw: unknown;
	try {
		raw = JSON.parse(stdout);
	} catch {
		return {
			ok: false,
			reason: `stdout was not JSON. head: ${stdout.slice(0, 200)}`,
		};
	}
	const envelope = claudeEnvelopeSchema.safeParse(raw);
	if (!envelope.success) {
		return { ok: false, reason: "stdout JSON was not a result envelope" };
	}
	if (envelope.data.is_error === true) {
		return {
			ok: false,
			reason: `claude reported an error: ${(envelope.data.result ?? "").slice(0, 200)}`,
		};
	}
	return { ok: true, result: envelope.data.result ?? "" };
}
