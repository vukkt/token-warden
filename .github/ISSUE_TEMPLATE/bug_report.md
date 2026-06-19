---
name: Bug report
about: Something in the plugin behaves incorrectly
title: ""
labels: bug
assignees: ""
---

## What happened

A clear description of the behaviour, and what you expected instead.

## Reproduction

Steps to reproduce, including the command or hook involved (for example
`/warden-select sql`, or the Stop hook on session end).

## Environment

- token-warden version (`.claude-plugin/plugin.json`):
- Claude Code version (`claude --version`):
- Node version (`node --version`):
- OS:

## Evidence

Relevant output. Hooks fail open and log to `~/.token-warden/distill.log`;
include the tail if a Stop/distill issue. For a measurement question, the
`/warden-status` or `/warden-receipt` output is usually the most useful.

Do not paste secrets; token-warden stores no credentials, but transcripts and
DB rows can contain repo paths.
