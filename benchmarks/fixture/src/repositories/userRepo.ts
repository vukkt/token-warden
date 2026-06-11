import type { Db } from "../db.js";

export interface User {
	id: number;
	name: string;
	email: string;
	created_at: string;
}

export function listUsers(db: Db): User[] {
	return db
		.prepare<[], User>("SELECT * FROM users ORDER BY created_at DESC")
		.all();
}

export function getUserById(db: Db, id: number): User | undefined {
	return db.prepare<[number], User>("SELECT * FROM users WHERE id = ?").get(id);
}

export function insertUser(db: Db, name: string, email: string): User {
	const row = db
		.prepare<[string, string], User>(
			"INSERT INTO users (name, email) VALUES (?, ?) RETURNING *",
		)
		.get(name, email);
	if (!row) throw new Error("insert failed");
	return row;
}
