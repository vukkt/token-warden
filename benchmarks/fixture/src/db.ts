import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

export type Db = Database.Database;

const schemaPath = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"db",
	"schema.sql",
);

export function createDb(path = ":memory:"): Db {
	const db = new Database(path);
	db.pragma("foreign_keys = ON");
	db.exec(readFileSync(schemaPath, "utf8"));
	return db;
}
