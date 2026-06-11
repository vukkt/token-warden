import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "../src/db.js";
import {
	getProductById,
	insertProduct,
	listProducts,
} from "../src/repositories/productRepo.js";

let db: Db;

beforeEach(() => {
	db = createDb();
});

describe("productRepo", () => {
	it("inserts and fetches a product", () => {
		const product = insertProduct(db, "Keyboard", 4999, 10);
		expect(getProductById(db, product.id)).toMatchObject({
			name: "Keyboard",
			price_cents: 4999,
			stock: 10,
		});
	});

	it("lists products sorted by name", () => {
		insertProduct(db, "Monitor", 19999, 3);
		insertProduct(db, "Cable", 999, 50);
		expect(listProducts(db).map((p) => p.name)).toEqual(["Cable", "Monitor"]);
	});

	it("returns undefined for a missing product", () => {
		expect(getProductById(db, 42)).toBeUndefined();
	});
});
