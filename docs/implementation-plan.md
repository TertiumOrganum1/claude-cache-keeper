> Исторический документ версии 0.1. Текущее поведение 0.2 описано в README.md; лимиты и отдельная Pane отменены.

# Claude Cache Keeper Implementation Plan

> Implement inline using the accepted in-session design, TDD, and verification before completion.

**Goal:** Install a session-local Claude Code mod that controls cache refreshes from the graphical chat.

**Architecture:** Pure scheduling and accounting policy plus a Claude mod adapter. The adapter owns the timer, observes main turns, calls `model.fork`, and draws a dedicated pane and command controls.

**Tech Stack:** TypeScript, Claude Code 2.1.300 mods/testing APIs, no runtime npm dependencies.

**Spec:** [design.md](design.md).

## Constraints

Claude only; default off; no maintenance turns in the transcript; no tools or external resume processes; estimated TTL; stop on errors and cache misses; restore temporary environment changes; no changes to fastreports.

## Review focus

Time at epoch zero must be valid. Real turns, pause, and reset must invalidate stale in-flight results. Long responses and sleeping machines must not make a cold cache appear warm. Missing/invalid token counts must fail closed. Other sessions and configured TTLs must remain independent.

## Task 1: Scheduling policy

- [x] Write failing native tests for default off, enabling, TTL boundaries, busy state, expiry, idle/ping limits, accounting, and stale generations.
- [x] Implement `hooks/policy.ts` with typed state and pure eligibility/result transitions.
- [x] Run the tests, verify all cases, and commit.

## Task 2: Native adapter and GUI

- [x] Add failing integration tests for command/button controls, the timer and main turn events, model errors, cache misses, and environment restoration.
- [x] Implement `hooks/register.tsx`; load exact CLI-generated declarations; draw a supported VS Code pane and register `/cache-keeper`.
- [x] Validate with `claude plugin validate --strict`, run `claude plugin test`, and type-check.
- [x] Commit the tested adapter.

## Task 3: Local installation and delivery

- [x] Add local marketplace metadata and concise installation/use documentation.
- [x] Review the complete change and resolve material findings with regression tests.
- [x] Validate and install the local plugin without replacing existing settings; verify the installed inventory.
- [x] Record exact checks and GUI/provider verification boundaries in `verification.md`.
