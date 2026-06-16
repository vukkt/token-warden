/**
 * Presentation sanitizer for untrusted text — the single chokepoint every
 * model- or environment-derived string must pass through before it is
 * rendered into a report, a log line, or a user-facing permission prompt.
 *
 * Rule bodies and eviction reasons are model-generated; project paths,
 * tool/skill/MCP names, and inter-agent message text come from the
 * environment. Stripping ANSI escape sequences and control characters means
 * collected data cannot fake report lines, forge a terminal prompt, or hide
 * its real content; collapsing whitespace keeps it to one line; clamping
 * keeps one weird value from flooding the output.
 */

/** Neutralize and clamp an untrusted string for display. */
export function displayText(value: string, max = 300): string {
	const cleaned = value
		// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point
		.replace(/\x1b\[[0-9;]*[A-Za-z]|[\x00-\x1f\x7f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max - 1)}…`;
}
