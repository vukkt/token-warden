---
id: frontend-02
agent: frontend
prompt: "OrderSummary in web/components/OrderSummary.tsx duplicates the fetch logic that already exists in the useFetch hook. Refactor OrderSummary to use the useFetch hook instead of its own useEffect/useState fetch code, preserving its current rendering output."
success_check: "grep -q 'useFetch' web/components/OrderSummary.tsx && ! grep -q 'useEffect' web/components/OrderSummary.tsx"
---

Verifies the duplicated fetch effect was replaced by the shared hook.
