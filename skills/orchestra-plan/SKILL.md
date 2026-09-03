---
name: orchestra-plan
description: "Author a durable Codex Orchestra plan under .codex/plans with self-contained work orders, acceptance criteria, executor tiers, sequencing, campaign review checkpoints, and cadence clauses. Use when the user asks for a saved plan or when decomposition is the next deliverable."
---

# Orchestra plan

Turn a goal into an executable plan under `.codex/plans/<slug>.md`. This is an
orchestration skill: the Director may author plan Markdown through the guard's
narrow plan exception. It never implements repository work.

## Procedure

1. **INTAKE.** State the desired outcome first and define observable
   done-criteria. Resolve material ambiguity before decomposition.
2. **RECON.** Unless the exact territory is already mapped in this campaign,
   dispatch scouts for files, patterns, tests, mechanical limits, and prior art.
   Launch independent missions together. Route causal questions to a detective.
3. **Probe risky breadth.** For multi-subsystem work, schedule an early
   mechanical-limit scout probe and a small risk-first executor order that
   forces the most dangerous cross-system interaction.
4. **Decompose.** Each order has one deliverable kind, touches roughly three or
   fewer subsystems, and should finish in one executor run and one review round.
   Split author-plus-migrate work. Fan-out migrations use isolated/disjoint
   orders and finish with a sweep for missed consumers. A generator, migrator,
   or pipeline must validate its own output.
5. **Route execution.** Use `executor` (Terra/high) for routine work,
   `executor-heavy` (Sol/high) for hard/coupled/escalated work, and
   `executor-heavy-xhigh` only for the hardest split-resistant order. Choose at
   plan time; a worker never self-promotes.
6. **Declare verification.** Default `TIER: full`. Use `inert` only for a
   provably behavior-neutral docs/comment/format-only diff. Name exact commands
   or say "per `.codex/orchestra.json` verification manifest." Verification is
   performed by both executor and reviewer.
7. **Schedule campaign review.** At least one independent checkpoint must occur
   before final report, handoff, merge, release, or deploy. OpenAI-authored work
   routes to `reviewer-claude` when the Claude pack is installed; Anthropic-
   authored work and Claude-unavailable fallback route to fresh native
   `reviewer`. Require exact base/head refs for committed checkpoints.
8. **Add cadence only where needed.** A deliberately bundled long order carries
   numbered parts, a named progress file, checkpoint commits when authorized,
   and a tool-call budget. Crossing it yields CHECKPOINT.
9. **Write the plan** with the template below. Present phase count,
   parallelism, material risks, review points, and any decision requiring user
   sign-off. Do not start risky execution without required sign-off.

## Plan template

```markdown
# Plan: <title>
Date: <date> · Status: DRAFT | APPROVED | IN FLIGHT | DONE

## Outcome
<what will be true when this succeeds>

## Done-criteria
- [ ] <observable criterion>

## Recon summary
- <verified fact> (`path:line`)

## Orders

### WO-1: <title>
- **Outcome:** <one delivered result>
- **Kind:** <one deliverable kind>
- **Executor:** executor | executor-heavy | executor-heavy-xhigh | <specialist>
- **Scope:** <exact paths/globs>
- **Constraints:** <what must not change>
- **Context to paste:** <findings and prior reports the worker cannot infer>
- **Acceptance criteria:** <observable proof of completion>
- **Verification:** TIER: full|inert — <commands or manifest>
- **Cadence:** <numbered parts, progress path, checkpoint/budget; or none>
- **Depends on:** <WO ids or none>

## Sequencing
- Parallel: <disjoint orders>
- Serial: <dependency chains>
- Gates: <integration and sweep orders>

## Review checkpoints
- <name>: <orders/goals> · author family <OpenAI|Anthropic> · committed
  base/head refs required at execution · route per ORCHESTRA.md §5

## Risks
- <risk> → <mitigation or probe>
```

For long campaigns, update `.codex/plans/ledger.md` with each agent run,
checkpoint, wall-clock duration, and verification performed.
