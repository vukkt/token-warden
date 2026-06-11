import type { Db } from "../db.js";
import {
	getUserById,
	insertUser,
	listUsers as listUserRows,
	type User,
} from "../repositories/userRepo.js";
import { NotFoundError, ValidationError } from "./errors.js";

export function listUsers(db: Db): User[] {
	return listUserRows(db);
}

export function getUser(db: Db, id: number): User {
	const user = getUserById(db, id);
	if (!user) throw new NotFoundError(`user ${id} not found`);
	return user;
}

export function createUser(db: Db, name: string, email: string): User {
	if (!name.trim()) throw new ValidationError("name is required");
	if (!email.includes("@")) throw new ValidationError("email is invalid");
	return insertUser(db, name.trim(), email.toLowerCase());
}
