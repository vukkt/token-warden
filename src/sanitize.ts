/**
 * Presentation sanitizer for untrusted text — the single chokepoint every
 * model- or environment-derived string must pass through before it is
 * rendered into a report, a log line, or a user-facing permission prompt.
 *
 * Rule bodies and eviction reasons are model-generated; project paths,
 * tool/skill/MCP names, transcript agent names, and inter-agent message text
 * come from the environment. Stripping escape sequences and control
 * characters means collected data cannot fake report lines, forge a terminal
 * prompt, or hide its real content; deleting invisible formatting characters
 * means what the reader sees is what the value actually is; collapsing
 * whitespace keeps it to one line; clamping keeps one weird value from
 * flooding the output.
 *
 * Threat model, concretely — a string arriving here may try to:
 *   - repaint the terminal or move the cursor (ANSI/CSI escapes)
 *   - forge extra report rows (newlines, carriage returns)
 *   - trigger a terminal side effect (BEL, OSC clipboard/title sequences)
 *   - render as text other than it is (bidi overrides, zero-width joiners)
 * All four are neutralized below. The output of `displayText` contains no
 * character below U+0020, no U+007F-U+009F, and no invisible formatting
 * character, and running it through `displayText` again is a no-op.
 */

/**
 * CSI escape sequences plus C0, DEL, and C1 control characters. C1 matters
 * because U+009B is an 8-bit CSI on terminals that decode it — stripping only
 * the 7-bit `ESC [` form would leave a live escape introducer behind. Other
 * escape forms (OSC `ESC ]`, DCS, charset selects) are defused by the same
 * pass: their ESC/BEL/ST bytes are control characters, so what survives is
 * inert visible text rather than a sequence the terminal acts on.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point
const CONTROL = /\x1b\[[0-9;]*[A-Za-z]|[\x00-\x1f\x7f-\x9f]+/g;

/**
 * Invisible formatting characters: bidi marks, overrides and isolates (the
 * Trojan-Source trick, where the rendered order differs from the real order),
 * zero-width space/joiners, word joiner and invisible operators, soft hyphen,
 * deprecated format characters, interlinear annotation, and ZWNBSP/BOM.
 * Deleted rather than replaced with a space: a terminal draws them as
 * nothing, so deleting them is exactly what the reader already sees.
 */
const INVISIBLE =
	/[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb]/g;

/**
 * Surrogate code units without a partner. Untrusted input can contain them
 * outright, and clamping can create one by cutting a pair in half; either way
 * they are not valid text and render as a replacement glyph.
 */
const LONE_SURROGATE =
	/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** Neutralize and clamp an untrusted string for display. Total: every input
 * string yields a clean one-line string, whatever the caller passes as max. */
export function displayText(value: string, max = 300): string {
	const cap = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 300;
	const cleaned = value
		.replace(CONTROL, " ")
		.replace(INVISIBLE, "")
		.replace(LONE_SURROGATE, "")
		.replace(/\s+/g, " ")
		.trim();
	if (cleaned.length <= cap) return cleaned;
	// The cut can land between the halves of an astral character; drop the
	// orphaned half rather than emitting a lone surrogate.
	const head = cleaned.slice(0, cap - 1).replace(LONE_SURROGATE, "");
	return `${head}…`;
}
