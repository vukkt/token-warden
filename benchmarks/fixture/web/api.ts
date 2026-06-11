const BASE_URL = "/api";

export async function fetchJson<T>(path: string): Promise<T> {
	const response = await fetch(`${BASE_URL}${path}`);
	if (!response.ok) {
		throw new Error(`request failed: ${response.status}`);
	}
	return (await response.json()) as T;
}

export interface ApiUser {
	id: number;
	name: string;
	email: string;
}

export interface ApiOrder {
	id: number;
	user_id: number;
	product_id: number;
	quantity: number;
	total_cents: number;
}
