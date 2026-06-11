import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
	useState,
} from "react";

interface AuthState {
	userId: number | null;
	token: string | null;
	login: (userId: number, token: string) => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
	const [userId, setUserId] = useState<number | null>(null);
	const [token, setToken] = useState<string | null>(null);

	const login = useCallback((nextUserId: number, nextToken: string) => {
		setUserId(nextUserId);
		setToken(nextToken);
	}, []);

	const value = useMemo(
		() => ({ userId, token, login }),
		[userId, token, login],
	);

	return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
	const ctx = useContext(AuthContext);
	if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
	return ctx;
}
