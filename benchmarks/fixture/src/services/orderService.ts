import type { Db } from "../db.js";
import {
	getOrderById,
	insertOrder,
	listOrdersByUser,
	type Order,
} from "../repositories/orderRepo.js";
import { NotFoundError, ValidationError } from "./errors.js";
import { getProduct } from "./productService.js";
import { getUser } from "./userService.js";

export function getOrder(db: Db, id: number): Order {
	const order = getOrderById(db, id);
	if (!order) throw new NotFoundError(`order ${id} not found`);
	return order;
}

export function listUserOrders(db: Db, userId: number): Order[] {
	getUser(db, userId);
	return listOrdersByUser(db, userId);
}

export function createOrder(
	db: Db,
	userId: number,
	productId: number,
	quantity: number,
): Order {
	if (!Number.isInteger(quantity) || quantity <= 0) {
		throw new ValidationError("quantity must be a positive integer");
	}
	getUser(db, userId);
	const product = getProduct(db, productId);
	if (product.stock < quantity) {
		throw new ValidationError(`insufficient stock for product ${productId}`);
	}
	const totalCents = product.price_cents;
	return insertOrder(db, userId, productId, quantity, totalCents);
}
