import { type Router, Router as createRouter } from "express";
import type { Db } from "../db.js";
import { createUser, getUser, listUsers } from "../services/userService.js";

export function usersRouter(db: Db): Router {
	const router = createRouter();

	router.get("/", (_req, res) => {
		res.json(listUsers(db));
	});

	router.get("/:id", (req, res, next) => {
		try {
			res.json(getUser(db, Number(req.params.id)));
		} catch (err) {
			next(err);
		}
	});

	router.post("/", (req, res, next) => {
		try {
			const { name, email } = req.body as { name: string; email: string };
			res.status(201).json(createUser(db, name, email));
		} catch (err) {
			next(err);
		}
	});

	return router;
}
