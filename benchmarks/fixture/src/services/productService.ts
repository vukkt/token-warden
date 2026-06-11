import type { Db } from "../db.js";
import {
	getProductById,
	insertProduct,
	listProducts as listProductRows,
	type Product,
} from "../repositories/productRepo.js";
import { NotFoundError, ValidationError } from "./errors.js";

export function listProducts(db: Db): Product[] {
	return listProductRows(db);
}

export function getProduct(db: Db, id: number): Product {
	const product = getProductById(db, id);
	if (!product) throw new NotFoundError(`product ${id} not found`);
	return product;
}

export function createProduct(
	db: Db,
	name: string,
	priceCents: number,
	stock = 0,
): Product {
	if (!name.trim()) throw new ValidationError("name is required");
	if (!Number.isInteger(priceCents) || priceCents <= 0) {
		throw new ValidationError("price_cents must be a positive integer");
	}
	if (!Number.isInteger(stock) || stock < 0) {
		throw new ValidationError("stock must be a non-negative integer");
	}
	return insertProduct(db, name.trim(), priceCents, stock);
}
