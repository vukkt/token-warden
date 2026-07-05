import { describe, expect, it } from "vitest";
import { parseModelbenchArgs } from "../src/modelbench.js";

describe("parseModelbenchArgs", () => {
	it("parses agent, model, and defaults", () => {
		expect(parseModelbenchArgs(["--agent", "sql", "--model", "haiku"])).toEqual(
			{
				agent: "sql",
				model: "haiku",
				baseline: null,
				runs: 2,
				topUp: 1,
				task: null,
			},
		);
	});

	it("parses overrides", () => {
		expect(
			parseModelbenchArgs([
				"--agent",
				"backend",
				"--model",
				"opus",
				"--baseline",
				"sonnet",
				"--runs",
				"3",
				"--top-up",
				"0",
				"--task",
				"backend-01",
			]),
		).toEqual({
			agent: "backend",
			model: "opus",
			baseline: "sonnet",
			runs: 3,
			topUp: 0,
			task: "backend-01",
		});
	});

	it("accepts --agent all for the category sweep, but not with --task", () => {
		expect(
			parseModelbenchArgs(["--agent", "all", "--model", "haiku"]).agent,
		).toBe("all");
		expect(() =>
			parseModelbenchArgs([
				"--agent",
				"all",
				"--model",
				"haiku",
				"--task",
				"sql-01",
			]),
		).toThrow(/--task requires a specific --agent/);
	});

	it("rejects bad input", () => {
		expect(() =>
			parseModelbenchArgs(["--agent", "main", "--model", "x"]),
		).toThrow(/--agent/);
		expect(() => parseModelbenchArgs(["--agent", "sql"])).toThrow(/--model/);
		expect(() =>
			parseModelbenchArgs(["--agent", "sql", "--model", "x", "--runs", "0"]),
		).toThrow(/--runs/);
		expect(() =>
			parseModelbenchArgs(["--agent", "sql", "--model", "x", "--top-up", "-1"]),
		).toThrow(/--top-up/);
		expect(() =>
			parseModelbenchArgs(["--agent", "sql", "--model", "x", "--bogus"]),
		).toThrow(/unknown flag/);
	});
});
