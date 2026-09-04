# Changelog

## 3.0.2 — 2026-09-04

- Route Claude review through an installer-managed project MCP registration,
  avoiding Codex 0.153.x's dropped custom-agent MCP configuration.
- Make review input scratch owner-only and atomically randomized, remove the
  delayed process-group kill race, and cover cancellation and POSIX modes.
- Centralize diagnostic credential redaction, cover JSON keys, Basic auth,
  non-HTTP credential URLs, and case variants, and omit oversized diagnostics
  instead of scanning multi-megabyte buffers.
- Canonicalize managed text to LF before writing and hashing, while accepting
  legacy CRLF receipt hashes during update and uninstall.
- Manage only marked pack-owned blocks in `.codex/config.toml`, preserving all
  other project configuration during install, update, deselection, and removal.

## 3.0.0 — 2026-09-02

Codex-Orchestra is now the provider-inverted mirror of Claude-Orchestra 3.0.

- Codex is the helm: GPT-5.6 Sol directs, Luna scouts, and Terra/Sol executors implement.
- The optional `claude` pack supplies the default independent reviewer for OpenAI-authored campaigns through a fresh Claude CLI session.
- Fresh-context GPT-5.6 Sol review remains the fallback when the Claude lane is absent or unavailable, and the primary review path for Anthropic-authored changes.
- Every campaign crosses a review gate before its final report; inert work may narrow verification but never skip review.
- The canonical installer now owns `.codex/`, a managed block in root `AGENTS.md`, and bundled project skills under `.agents/skills/`.
- Installation preserves unrelated Codex hooks and `AGENTS.md` content, records namespace-limited content hashes for safe updates and uninstall, installs CommonJS hook armor, and supports packs, specialists, lint, scan/update, and uninstall.
- The Director guard understands Codex hook payloads and nested `functions.exec` calls, permits only goal tools and contained Markdown plan patches, and rejects self-pausing, traversal, aliases, and constructor/prototype indirection.
- Claude review supports pinned commit ranges, isolated temporary worktrees, configuration/flag precedence, bounded retry, fail-loud unavailable results, command prohibitions, and working-tree integrity checks.
- Claude-Orchestra and Codex-Orchestra can coexist in either install order; their files, receipts, updates, and uninstalls remain separate, and cross-family subprocesses use an explicit external-worker isolation handshake instead of inheriting the other Director.

The pre-conversion Claude-Orchestra development history remains available in Git history and the archival `plans/`, `research/`, and `roster/` directories; it is not part of the active Codex runtime.
