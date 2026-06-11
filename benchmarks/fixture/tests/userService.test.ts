import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "../src/db.js";
import { NotFoundError, ValidationError } from "../src/services/errors.js";
import { createUser, getUser, listUsers } from "../src/services/userService.js";

let db: Db;

beforeEach(() => {
	db = createDb();
});

describe("userService", () => {
	it("creates a user and normalizes the email", () => {
		const user = createUser(db, "  Ada Lovelace ", "Ada@Example.COM");
		expect(user.name).toBe("Ada Lovelace");
		expect(user.email).toBe("ada@example.com");
	});

	it("rejects an empty name", () => {
		expect(() => createUser(db, "   ", "a@b.com")).toThrow(ValidationError);
	});

	it("rejects an invalid email", () => {
		expect(() => createUser(db, "Ada", "not-an-email")).toThrow(
			ValidationError,
		);
	});

	it("gets a user by id", () => {
		const created = createUser(db, "Grace", "grace@example.com");
		expect(getUser(db, created.id).name).toBe("Grace");
	});

	it("throws NotFoundError for a missing user", () => {
		expect(() => getUser(db, 999)).toThrow(NotFoundError);
	});

	it("lists created users", () => {
		createUser(db, "Ada", "ada@example.com");
		createUser(db, "Grace", "grace@example.com");
		expect(listUsers(db)).toHaveLength(2);
	});
});
