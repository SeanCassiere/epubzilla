# ADR-0005: Contracts and ADRs on disk; milestone specs in GitHub issues

Status: Accepted · 2026-08-23

## Context

The project needs durable reference material and per-milestone plans, and
these have different lifespans.

## Decision

- **Contracts** (`docs/contracts/`) — durable interface truth code is written
  against. Changed via PR.
- **ADRs** (`docs/adr/`) — durable decision rationale. Immutable once
  accepted; superseded by new ADRs, never edited into a different decision.
- **Milestone specs** — plans (scope, sub-issue breakdown, acceptance
  checklist). They live as GitHub **parent issues** with native sub-issues,
  one per milestone, mirrored by a GitHub Milestone. They close when done and
  are not kept on disk.
- Durable truths discovered during a milestone get promoted into a contract
  or ADR in the same PR that implements them.

## Consequences

- The repo never accumulates stale planning docs; issues never serve as
  living reference.
