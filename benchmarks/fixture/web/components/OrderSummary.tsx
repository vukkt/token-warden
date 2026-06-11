import { useEffect, useState } from "react";
import { type ApiOrder, fetchJson } from "../api.js";

interface OrderSummaryProps {
	userId: number;
}

export function OrderSummary({ userId }: OrderSummaryProps) {
	const [orders, setOrders] = useState<ApiOrder[]>([]);

	useEffect(() => {
		let cancelled = false;
		fetchJson<ApiOrder[]>(`/orders?userId=${userId}`)
			.then((result) => {
				if (!cancelled) setOrders(result);
			})
			.catch(() => {
				if (!cancelled) setOrders([]);
			});
		return () => {
			cancelled = true;
		};
	}, [userId]);

	const totalCents = orders.reduce((sum, order) => sum + order.total_cents, 0);

	return (
		<div className="order-summary">
			<h3>Orders: {orders.length}</h3>
			<p>Total: ${(totalCents / 100).toFixed(2)}</p>
		</div>
	);
}
