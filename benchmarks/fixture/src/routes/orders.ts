import { type Router, Router as createRouter } from "express";
import type { Db } from "../db.js";
import { createOrder, listUserOrders } from "../services/orderService.js";

export function ordersRouter(db: Db): Router {
	const router = createRouter();

	router.get("/", (req, res, next) => {
		try {
			const userId = Number(req.query.userId);
			res.json(listUserOrders(db, userId));
		} catch (err) {
			next(err);
		}
	});

	router.post("/", (req, res, next) => {
		try {
			const body = req.body as {
				user_id: number;
				product_id: number;
				quantity: number;
			};
			res
				.status(201)
				.json(createOrder(db, body.user_id, body.product_id, body.quantity));
		} catch (err) {
			next(err);
		}
	});

	return router;
}
