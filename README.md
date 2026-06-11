# token-warden

A Claude Code plugin that makes coding agents measurably cheaper over time. It records the
token cost of every agent session into SQLite, distills candidate efficiency rules from
unusually expensive sessions, benchmarks each candidate's real token impact on a frozen
golden task suite, and compiles only the rules that save at least 2x their context cost
into each agent's persistent memory — evicting the rest. Four domain agents ship with the
plugin (`frontend`, `backend`, `sql`, `testing`), each with its own memory, golden suite,
and learning curve.
