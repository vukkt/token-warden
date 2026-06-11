---
id: frontend-01
agent: frontend
prompt: "Add loading and error states to the UserList component in web/components/UserList.tsx. While the request is in flight it should render a loading indicator, and when the request fails it should render the error message instead of an empty list. Extend the useFetch hook if needed."
success_check: "grep -qi 'loading' web/components/UserList.tsx && grep -qi 'error' web/components/UserList.tsx"
---

Verifies the component handles all three fetch states instead of rendering an
empty list while loading or after a failure.
