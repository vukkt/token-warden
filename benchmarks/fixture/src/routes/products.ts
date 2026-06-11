import { type Router, Router as createRouter } from "express";
import type { Db } from "../db.js";
import {
	createProduct,
	getProduct,
	listProducts,
} from "../services/productService.js";

export function productsRouter(db: Db): Router {
	const router = createRouter();

	router.get("/", (_req, res) => {
		res.json(listProducts(db));
	});

	router.get("/:id", (req, res, next) => {
		try {
			res.json(getProduct(db, Number(req.params.id)));
		} catch (err) {
			next(err);
		}
	});

	router.post("/", (req, res, next) => {
		try {
			const { name, price_cents, stock } = req.body as {
				name: string;
				price_cents: number;
				stock?: number;
			};
			res.status(201).json(createProduct(db, name, price_cents, stock));
		} catch (err) {
			next(err);
		}
	});

	return router;
}
