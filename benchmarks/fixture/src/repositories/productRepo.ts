import type { Db } from "../db.js";

export interface Product {
	id: number;
	name: string;
	price_cents: number;
	stock: number;
}

export function listProducts(db: Db): Product[] {
	return db
		.prepare<[], Product>("SELECT * FROM products ORDER BY name")
		.all();
}

export function getProductById(db: Db, id: number): Product | undefined {
	return db
		.prepare<[number], Product>("SELECT * FROM products WHERE id = ?")
		.get(id);
}

export function insertProduct(
	db: Db,
	name: string,
	priceCents: number,
	stock: number,
): Product {
	const row = db
		.prepare<[string, number, number], Product>(
			"INSERT INTO products (name, price_cents, stock) VALUES (?, ?, ?) RETURNING *",
		)
		.get(name, priceCents, stock);
	if (!row) throw new Error("insert failed");
	return row;
}
