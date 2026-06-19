---
id: sql-04
agent: sql
prompt: "Add a getUserByEmail(db, email) function to src/repositories/userRepo.ts that returns the matching user row or undefined, mirroring the existing getUserById. Use a parameterized query and keep the whole suite passing."
success_check: "grep -q 'getUserByEmail' src/repositories/userRepo.ts && npx vitest run"
---

A single-file, additive query change (no cross-layer coordination), added as a
low-variance anchor for the sql suite — see FINDINGS.md.
