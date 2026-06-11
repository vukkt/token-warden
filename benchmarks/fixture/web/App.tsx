import { OrderSummary } from "./components/OrderSummary.js";
import { UserList } from "./components/UserList.js";
import { AuthProvider, useAuth } from "./context/AuthContext.js";

function Dashboard() {
	const { userId } = useAuth();
	return (
		<main>
			<h1>shopette admin</h1>
			<UserList />
			{userId !== null && <OrderSummary userId={userId} />}
		</main>
	);
}

export function App() {
	return (
		<AuthProvider>
			<Dashboard />
		</AuthProvider>
	);
}
