---
name: orchestra-status
description: "Report the Codex Orchestra harness state: protocol version, Director enforcement and pause state, guard wiring, installed TOML agents, Claude review pack, skills, project policy, verification manifest, plans, and review-lane availability. Read-only."
---

# Orchestra status

Produce one compact factual status report. This skill is orchestration-class,
but repository facts are reconnaissance: in active Director mode gather them
through one read-only scout mission carrying the checklist below.

## Gather

1. **Enforcement:** whether `.codex/orchestra.pause` exists and whether
   `ORCHESTRA_PAUSE=1` is set.
2. **Protocol:** `.codex/ORCHESTRA.md` presence and stamped version; root
   `AGENTS.md` managed `ORCHESTRA:BEGIN/END` block.
3. **Guard:** `.codex/hooks/orchestra-guard.js` presence and SessionStart plus
   PreToolUse entries in `.codex/hooks.json` that reference it.
4. **Company:** presence of `scout.toml`, `detective.toml`, `executor.toml`,
   `executor-heavy.toml`, `executor-heavy-xhigh.toml`, and `reviewer.toml` under
   `.codex/agents/`; list other TOML profiles as specialists or pack roles.
5. **Pack:** `.codex/orchestra-install.json` recorded packs/specialists and
   whether `reviewer-claude.toml` plus `.codex/hooks/orchestra-review.js` exist.
6. **Skills:** directories under `.agents/skills/`, including the core
   `orchestra-plan`, `orchestra-review`, and `orchestra-status` skills.
7. **Config:** from `.codex/orchestra.json`, or defaults when absent: verification
   manifest, director blocked/allowed/plan patterns, and the `claude`
   runner block including model, effort, timeout, retries, auth probe,
   do-not-run count, worktree root, and integrity-ignore count.
8. **Claude lane:** read-only availability check for the Claude CLI, respecting
   configured `CLAUDE_BIN`. Do not run a doctor that repairs files during this
   status command; name it as a suggested fix instead.
9. **Plans:** Markdown count under `.codex/plans/` and whether `ledger.md` exists.

## Report

```text
ORCHESTRA STATUS
Mode:         DIRECTOR | PAUSED
Enforcement:  active | paused (.codex/orchestra.pause) | paused (ORCHESTRA_PAUSE=1) | guard not wired
Protocol:     .codex/ORCHESTRA.md <present (vX.Y.Z|unversioned)|MISSING> · AGENTS.md block <present|MISSING>
Company:      scout <✓|✗> detective <✓|✗> executor <✓|✗> executor-heavy <✓|✗> executor-heavy-xhigh <✓|✗> reviewer <✓|✗> · specialists: <names|none>
Packs:        <names|none> · reviewer-claude <✓|✗>
Skills:       <names|none>
Review route: OpenAI-authored → Claude <available|UNAVAILABLE|pack not installed> · Anthropic-authored → native Sol
Claude config: model <id|default> · effort <level|default> · timeout <ms|default> · doNotRun <n>
Policy:       blocked-patterns <n> · allowed-tools <names|none> · plan-patterns <n>
Verification: manifest present (full: <command>) | no manifest
Plans:        <n> plan file(s) · ledger <present|none>
```

Add one `FINDINGS:` line only for inconsistencies, each with a one-line fix.
An installed but unavailable Claude lane is an alarm condition: state that
campaign review falls back to fresh native Sol with the §5 alarm. Pack absence
is expected configuration, not an availability failure.
