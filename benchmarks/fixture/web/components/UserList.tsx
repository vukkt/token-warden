import { type ApiUser } from "../api.js";
import { useFetch } from "../hooks/useFetch.js";

export function UserList() {
	const { data } = useFetch<ApiUser[]>("/users");

	return (
		<ul className="user-list">
			{(data ?? []).map((user) => (
				<li key={user.id}>
					<strong>{user.name}</strong> <span>{user.email}</span>
				</li>
			))}
		</ul>
	);
}
