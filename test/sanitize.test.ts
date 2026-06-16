import { describe, expect, it } from "vitest";
import { displayText } from "../src/sanitize.js";

describe("displayText", () => {
	it("strips control characters, ANSI escapes, and newlines", () => {
		expect(displayText("a\nb\r\nc\x1b[31mred\x1b[0m\x07d")).toBe("a b c red d");
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
