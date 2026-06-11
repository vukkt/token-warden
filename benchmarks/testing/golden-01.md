---
id: testing-01
agent: testing
prompt: "Write vitest unit tests for src/services/productService.ts in tests/productService.test.ts. Cover createProduct validation (name, price, stock), getProduct including the not-found case, and listProducts. Follow the style of the existing tests and make sure the whole suite passes."
success_check: "test -f tests/productService.test.ts && npx vitest run"
---

Verifies the untested product service gains a passing test file.
