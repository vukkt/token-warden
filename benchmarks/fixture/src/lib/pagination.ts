export interface Page<T> {
	items: T[];
	page: number;
	totalPages: number;
	hasMore: boolean;
}

/** Paginate an array. `page` is 1-based. */
export function paginate<T>(items: T[], page: number, pageSize: number): Page<T> {
	if (page < 1) throw new RangeError("page must be >= 1");
	if (pageSize < 1) throw new RangeError("pageSize must be >= 1");
	const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
	const offset = page * pageSize;
	const slice = items.slice(offset, offset + pageSize);
	return {
		items: slice,
		page,
		totalPages,
		hasMore: page < totalPages,
	};
}
