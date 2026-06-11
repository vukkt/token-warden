import express, { type Express } from "express";
import type { Db } from "./db.js";
import { ordersRouter } from "./routes/orders.js";
import { productsRouter } from "./routes/products.js";
import { usersRouter } from "./routes/users.js";
import { NotFoundError, ValidationError } from "./services/errors.js";

export function createServer(db: Db): Express {
	const app = express();
	app.use(express.json());

	app.use("/users", usersRouter(db));
	app.use("/products", productsRouter(db));
	app.use("/orders", ordersRouter(db));

	app.use(
		(
			err: unknown,
			_req: express.Request,
			res: express.Response,
			_next: express.NextFunction,
		) => {
			if (err instanceof NotFoundError) {
				res.status(404).json({ error: err.message });
			} else if (err instanceof ValidationError) {
				res.status(400).json({ error: err.message });
			} else {
				res.status(500).json({ error: "internal error" });
			}
		},
	);

	return app;
}
