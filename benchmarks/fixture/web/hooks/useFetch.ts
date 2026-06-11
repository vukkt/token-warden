import { useCallback, useEffect, useState } from "react";
import { fetchJson } from "../api.js";

export interface FetchState<T> {
	data: T | null;
	error: string | null;
	refetch: () => void;
}

export function useFetch<T>(path: string): FetchState<T> {
	const [data, setData] = useState<T | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [tick, setTick] = useState(0);

	useEffect(() => {
		let cancelled = false;
		fetchJson<T>(path)
			.then((result) => {
				if (!cancelled) setData(result);
			})
			.catch((err: unknown) => {
				if (!cancelled) setError(err instanceof Error ? err.message : "error");
			});
		return () => {
			cancelled = true;
		};
	}, [path, tick]);

	const refetch = useCallback(() => setTick((t) => t + 1), []);

	return { data, error, refetch };
}
