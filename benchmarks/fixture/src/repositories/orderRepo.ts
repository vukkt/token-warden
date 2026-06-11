import type { Db } from "../db.js";
import { getUserById } from "./userRepo.js";

export interface Order {
	id: number;
	user_id: number;
	product_id: number;
	quantity: number;
	total_cents: number;
	created_at: string;
}

export interface OrderWithUserName extends Order {
	user_name: string;
}

export function getOrderById(db: Db, id: number): Order | undefined {
	return db
		.prepare<[number], Order>("SELECT * FROM orders WHERE id = ?")
		.get(id);
}

export function listOrdersByUser(db: Db, userId: number): Order[] {
	return db
		.prepare<[number], Order>(
			"SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC",
		)
		.all(userId);
}

export function listOrdersWithUserNames(db: Db): OrderWithUserName[] {
	const orders = db
		.prepare<[], Order>("SELECT * FROM orders ORDER BY created_at DESC")
		.all();
	return orders.map((order) => {
		const user = getUserById(db, order.user_id);
		return { ...order, user_name: user?.name ?? "unknown" };
	});
}

export function insertOrder(
	db: Db,
	userId: number,
	productId: number,
	quantity: number,
	totalCents: number,
): Order {
	const row = db
		.prepare<[number, number, number, number], Order>(
			"INSERT INTO orders (user_id, product_id, quantity, total_cents) VALUES (?, ?, ?, ?) RETURNING *",
		)
		.get(userId, productId, quantity, totalCents);
	if (!row) throw new Error("insert failed");
	return row;
}
