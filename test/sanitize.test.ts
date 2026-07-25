import { describe, expect, it } from "vitest";
import { displayText } from "../src/sanitize.js";

/** Control and formatting characters are built from char codes so this test
 * file stays pure ASCII on disk — an invisible byte in a source file is the
 * exact trick being defended against. */
const ch = (code: number): string => String.fromCharCode(code);
const NUL = ch(0x00);
const BEL = ch(0x07);
const ESC = ch(0x1b);
const DEL = ch(0x7f);
const CSI8 = ch(0x9b); // 8-bit CSI (C1)
const SHY = ch(0x00ad); // soft hyphen
const ZWSP = ch(0x200b);
const ZWJ = ch(0x200d);
const RLO = ch(0x202e); // right-to-left override (Trojan Source)
const LRI = ch(0x2066); // left-to-right isolate
const WJ = ch(0x2060); // word joiner
const BOM = ch(0xfeff);
const LS = ch(0x2028); // line separator
const PS = ch(0x2029); // paragraph separator

/** No control character (C0, DEL, C1) may survive sanitizing. Scanned by
 * code point rather than by regex: a regex literal holding control characters
 * is exactly what the lint rule (rightly) forbids in source. */
function hasControl(text: string): boolean {
	return [...text].some((c) => {
		const n = c.codePointAt(0) ?? 0;
		return n <= 0x1f || (n >= 0x7f && n <= 0x9f);
	});
}

/** Nor any invisible formatting character. */
function hasInvisible(text: string): boolean {
	return [...text].some((c) => {
		const n = c.codePointAt(0) ?? 0;
		return (
			n === 0x00ad ||
			n === 0x061c ||
			n === 0x180e ||
			(n >= 0x200b && n <= 0x200f) ||
			(n >= 0x202a && n <= 0x202e) ||
			(n >= 0x2060 && n <= 0x2064) ||
			(n >= 0x2066 && n <= 0x206f) ||
			n === 0xfeff ||
			(n >= 0xfff9 && n <= 0xfffb)
		);
	});
}

describe("displayText", () => {
	it("strips control characters, ANSI escapes, and newlines", () => {
		expect(displayText(`a\nb\r\nc${ESC}[31mred${ESC}[0m${BEL}d`)).toBe(
			"a b c red d",
		);
	});

	it("collapses whitespace and trims", () => {
		expect(displayText("  many   spaces\t\there  ")).toBe("many spaces here");
	});

	it("clamps runaway values to the cap (with ellipsis)", () => {
		const out = displayText("x".repeat(1000));
		expect(out.length).toBe(300);
		expect(out.endsWith("…")).toBe(true);
	});

	it("respects a custom max", () => {
		expect(displayText("x".repeat(50), 10).length).toBe(10);
	});

	it("leaves a short clean string untouched", () => {
		expect(displayText("backend")).toBe("backend");
	});
});

describe("displayText — terminal injection defence", () => {
	it("defuses an OSC sequence, leaving inert text", () => {
		// OSC 52 writes the user's clipboard on terminals that honour it.
		const out = displayText(`rule${ESC}]52;c;cm0gLXJmIC8K${BEL} body`);
		expect(out).not.toContain(ESC);
		expect(out).not.toContain(BEL);
		expect(hasControl(out)).toBe(false);
	});

	it("strips an 8-bit C1 CSI introducer, not just the 7-bit ESC form", () => {
		const out = displayText(`a${CSI8}31mb`);
		expect(out).toBe("a 31mb");
		expect(hasControl(out)).toBe(false);
	});

	it("strips NUL and DEL", () => {
		expect(displayText(`a${NUL}${DEL}b`)).toBe("a b");
	});

	it("cannot forge extra report rows with newlines", () => {
		const forged = displayText(
			'harmless\n  [backend #99] delta=+9999 rent=0 "totally legit"\r\n',
		);
		expect(forged.split("\n")).toHaveLength(1);
		expect(forged.startsWith("harmless")).toBe(true);
	});

	it("collapses Unicode line and paragraph separators", () => {
		expect(displayText(`a${LS}b${PS}c`)).toBe("a b c");
	});

	it("removes bidi overrides and isolates (Trojan Source reordering)", () => {
		const out = displayText(`invoice${RLO}fdp.exe${LRI}`);
		expect(out).toBe("invoicefdp.exe");
		expect(hasInvisible(out)).toBe(false);
	});

	it("removes zero-width and other invisible formatting characters", () => {
		const out = displayText(`ad${SHY}m${ZWSP}i${ZWJ}n${WJ}${BOM}`);
		expect(out).toBe("admin");
		expect(hasInvisible(out)).toBe(false);
	});

	it("never emits a lone surrogate, including at the truncation cut", () => {
		const lone = displayText(`a${ch(0xd800)}b${ch(0xdfff)}c`);
		expect(lone).toBe("abc");
		// Cap lands in the middle of an astral pair.
		const clamped = displayText("\u{1F600}".repeat(10), 6);
		expect(clamped.length).toBeLessThanOrEqual(6);
		expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(clamped)).toBe(false);
		expect(/(?<![\ud800-\udbff])[\udc00-\udfff]/.test(clamped)).toBe(false);
	});

	it("is idempotent — sanitizing twice changes nothing", () => {
		const hostile = `${ESC}[2J${RLO}rm -rf /${ZWSP}\n${CSI8}6n${NUL}`;
		const once = displayText(hostile);
		expect(displayText(once)).toBe(once);
	});

	it("holds the output contract over a hostile corpus", () => {
		const corpus = [
			`${ESC}[38;5;196mred`,
			`${ESC}]0;window title${BEL}`,
			`${ESC}Pq dcs data${ESC}\\`,
			`${CSI8}2K${DEL}`,
			`${RLO}${LRI}${ZWSP}${WJ}${BOM}${SHY}`,
			`line1\nline2\r\nline3${LS}line4`,
			`${NUL}${ch(0x01)}${ch(0x1f)}${ch(0x80)}${ch(0x9f)}`,
			"x".repeat(5000),
			`${ch(0xd800)}${ch(0xdc00)}${ch(0xdfff)}`,
			"",
			"   ",
		];
		for (const value of corpus) {
			const out = displayText(value);
			expect(hasControl(out), JSON.stringify(value)).toBe(false);
			expect(hasInvisible(out), JSON.stringify(value)).toBe(false);
			expect(out.includes("\n"), JSON.stringify(value)).toBe(false);
			expect(out.length).toBeLessThanOrEqual(300);
			expect(displayText(out), JSON.stringify(value)).toBe(out);
		}
	});

	it("falls back to the default cap for an unusable max", () => {
		// Total: no caller can make displayText throw or return junk.
		for (const max of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(displayText("hello", max)).toBe("hello");
		}
		expect(displayText("x".repeat(400), Number.NaN).length).toBe(300);
	});
});
