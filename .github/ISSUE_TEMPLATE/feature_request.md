---
name: Feature request
about: Propose a capability or change
title: ""
labels: enhancement
assignees: ""
---

## Problem

The concrete problem this solves. What is hard, expensive, or unmeasurable today?

## Proposal

What you would like to happen.

## Fit with the model

token-warden keeps a rule only when it is *measured* to save more than its
context rent, with no task regression (see [ARCHITECTURE.md](../../ARCHITECTURE.md)
design invariants). If your proposal touches rule selection, the golden suites,
or the benchmark, note how it preserves: measured-not-claimed, frozen baselines,
and generated `MEMORY.md`.

## Alternatives considered

Optional.
