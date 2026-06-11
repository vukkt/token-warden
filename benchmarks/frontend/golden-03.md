---
id: frontend-03
agent: frontend
prompt: "Add a logout function to the auth context in web/context/AuthContext.tsx. It must clear both userId and token, be exposed on the context value, and be covered by the AuthState interface."
success_check: "grep -q 'logout' web/context/AuthContext.tsx"
---

Verifies the auth context exposes a logout capability.
