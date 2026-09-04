# Claude pack - Anthropic review for Codex Orchestra

This optional pack supplies the opposite-family judgment lane when Codex is in
the Director's chair. OpenAI agents still direct, scout, investigate, and
execute. When the pack is installed, an OpenAI-authored campaign goes to
`reviewer-claude` by default; Claude-authored work goes to the fresh-context
native OpenAI reviewer so author and reviewer remain on different providers.

```bash
node install.js /path/to/project --packs claude
node .codex/hooks/orchestra-review.js --doctor
```

The pack also retains `planner-claude`, the optional read-only Anthropic
counterpart for a cross-family planning round.

## Review invocation

`reviewer-claude` calls the pack's project-scoped
`orchestra_claude_review.orchestra_review` MCP tool once. The tool accepts the
work order, executor report, refs, and explicit controls as typed arguments,
writes its own temporary input files, and blocks until the runner process has
closed. It then relays the runner's stdout verbatim.

The runner remains directly invokable for diagnosis and standalone use:

```bash
node .codex/hooks/orchestra-review.js \
  --work-order <path> \
  --executor-report <path> \
  --base-ref <commit> \
  --head-ref <commit>
```

Useful overrides are `--tier full|inert`, `--model`, `--effort`,
`--timeout-ms`, `--retries`, `--worktree-root`, `--claude-bin`,
`--no-auth-probe`, `--no-tests`, and repeatable `--forbid <command>`.
`--no-tests` and `--forbid` become explicit hard prohibitions in the external
review brief; they are not advisory prose.

Pass committed base/head references whenever possible. Each attempt receives a
new detached worktree outside the reviewed repository, pinned to `head-ref`, and
the runner removes it afterward. The runner hashes the checkout before and
after Claude runs. Any mutation is surfaced as `INTEGRITY WARNING`; a mutation
inside a pinned checkout is contained when that checkout is removed.

One retry is enabled by default. Retries use new Claude processes and new
pinned worktrees but produce one outcome. Every outcome contains `FINALITY`.
Missing/auth-failed Claude, timeout, non-zero exit, or anything other than one
parseable `VERDICT: APPROVE|REVISE` produces:

```text
REVIEW ENGINE: NONE - no verdict produced (attempted: Claude CLI, cross-vendor)
FINALITY: FINAL (...)

VERDICT: REVIEW_UNAVAILABLE
```

`REVIEW_UNAVAILABLE` is never approval. The Director raises the protocol's
cross-family-unavailable warning and uses the native fresh-context OpenAI
reviewer.

The MCP transport independently enforces the same boundary. Empty or
whitespace-only runner stdout (including exit code 0), abnormal runner exit,
cancellation, a wedged-runner backstop, capture overflow, or output without one
recognized verdict becomes a non-empty `REVIEW_UNAVAILABLE` report. Diagnostic
tails are bounded and credential-shaped values are redacted. A valid runner
report is returned byte-for-byte; the launcher must not append its own text.

## Configuration

Durable settings live under `claude` in `.codex/orchestra.json`:

```json
{
  "claude": {
    "bin": "claude",
    "reviewModel": "opus",
    "reviewEffort": "high",
    "reviewTimeoutMs": 1800000,
    "reviewRetries": 1,
    "authProbe": true,
    "probeTimeoutMs": 90000,
    "worktreeRoot": "",
    "doNotRun": ["npm run destructive-e2e"],
    "integrityIgnore": ["coverage/**"]
  }
}
```

An empty or omitted `worktreeRoot` uses the OS temporary directory. Settings
resolve in this order: command flag, environment variable, project config,
default.

| Setting | Environment variable | Default |
|---|---|---|
| `bin` | `CLAUDE_BIN` | `claude` |
| `reviewModel` | `ORCHESTRA_CLAUDE_REVIEW_MODEL` | `opus` |
| `reviewEffort` | `ORCHESTRA_CLAUDE_REVIEW_EFFORT` | `high` |
| `reviewTimeoutMs` | `ORCHESTRA_CLAUDE_REVIEW_TIMEOUT_MS` | `1800000` |
| `reviewRetries` | `ORCHESTRA_CLAUDE_REVIEW_RETRIES` | `1` |
| `authProbe` | `ORCHESTRA_CLAUDE_AUTH_PROBE` | `true` |
| `probeTimeoutMs` | `ORCHESTRA_CLAUDE_PROBE_TIMEOUT_MS` | `90000` |
| `worktreeRoot` | `ORCHESTRA_CLAUDE_WORKTREE_ROOT` | OS temporary directory |
| `doNotRun` | `ORCHESTRA_CLAUDE_DO_NOT_RUN` (comma-separated additions) | `[]` |
| `integrityIgnore` | - | `[]` |

The runner reads the project's top-level `verification` manifest and includes
it in the review brief. A malformed `.codex/orchestra.json` fails the lane
loudly instead of silently applying defaults.

## Isolation and doctor

Every review is a new
`claude --print --restricted --safe-mode --no-session-persistence` process
with only `Bash,Read,Grep,Glob` exposed; edit and MCP tools are explicitly
disabled. The runner never resumes a
prior Claude session. Before review it checks `claude --version` and, by
default, `claude auth status`. Run the same checks without spending a review:

```bash
node .codex/hooks/orchestra-review.js --doctor
```

The planner uses `ORCHESTRA_CLAUDE_PLAN_MODEL` (default `fable`),
`ORCHESTRA_CLAUDE_PLAN_EFFORT` (default `max`), and
`ORCHESTRA_CLAUDE_PLAN_TIMEOUT_MS` (default `900000`). It receives only the
supplied plan and brief, runs under the same restricted safe-mode isolation,
sets `ORCHESTRA_ROLE=planner-claude-external`, and exposes no repository tools.
