# Claude pack - Anthropic review for Codex Orchestra

This optional pack supplies the opposite-family judgment lane when Codex is in
the Director's chair. OpenAI agents still direct, scout, investigate, and
execute. When the pack is installed, a GPT-authored campaign goes through
the project-scoped Opus 5.5 review MCP transport by default; Anthropic-authored work
goes to the fresh-context native OpenAI reviewer so author and reviewer remain
on different providers.

```bash
node install.js /path/to/project --packs claude
node .codex/hooks/orchestra-review.js --doctor
```

The pack also retains `planner-claude`, the optional read-only Anthropic
counterpart for a cross-family planning round, and installs `modeler-claude`,
an explicit user-routable Opus 5.5 visual-development executor launcher.

## Visual executor invocation

Route a self-contained Blender/Godot or related visual-development order to
the `modeler-claude` profile when the user wants an Anthropic partner to Astra.
The launcher calls this runner exactly once and relays its report verbatim:

```bash
node .codex/hooks/orchestra-visual.js --work-order .codex/plans/visual-order.md
```

The stable executable model alias is `opus`; harness policy identifies that
alias as Opus 5.5. Effort defaults to `high`. Add `--effort xhigh` only for an
explicitly large or complex visual order. The executor must return inspectable
renders/exports/logs and mesh, material, texture, collider, and LOD evidence.

## Review invocation

The Director calls the pack's project-scoped
`orchestra_claude_review.orchestra_review` MCP tool once. This narrow transport
exception does not make the Director the reviewer: the tool starts a fresh,
independent Claude CLI process. The tool accepts the
work order, executor report, refs, and explicit controls as typed arguments,
writes its own temporary input files, and blocks until the runner process has
closed. It then relays the runner's stdout verbatim.

## Final review report contract

Claude must return exactly one `VERDICT: APPROVE` or `VERDICT: REVISE` line,
followed once each and in this order by `## FINDINGS`, `## CLAIMS CHECKED`,
`## VERIFICATION`, and `## NITS`. The headings may be plain Markdown text for
older Claude CLI output and may carry a parenthesized count such as
`## FINDINGS (2 issues)`, but their spelling and order are fixed. Sections use
top-level `-` entries; an entry may contain indented wrapped prose, nested
bullets, or fenced code. Indent continuations, nested bullets, and complete
fences beneath the top-level entry they support. Structural-looking tokens
inside a fence are inert. Free-floating prose is rejected. `FINDINGS` is
either `- none` or severity-tagged actionable entries. The preferred
canonical CLAIMS CHECKED grammar is
`- <claim> -> CONFIRMED|REFUTED|UNVERIFIED <concrete evidence>`; the
preferred VERIFICATION grammar is
`- <command/check> -> PASS|FAIL|NOT-RUN <concrete result or reason>`.
The Unicode right arrow is accepted as an equivalent delimiter. A status alone
may use one exact matching pair of `**`, `__`, `*`, `_`, or backtick
wrappers. The subject, arrow, and status must remain on the top-level bullet.
Evidence may be inline or in a clearly owned indented non-fenced prose
continuation or evidence-only nested bullet. Competing status constructs,
mismatched wrappers, em-dash delimiters, split or nested status bullets, and
fenced-only evidence are rejected. Natural forms such as
`-> PASS (65 passed)`, `-> PASS as a search, negative as evidence (no matches)`,
and `-> PASS by inspection (read src/app.js)` are valid. Nits are explicit
entries or `- none`.

The runner and MCP relay use the same validator. Missing, empty, duplicate, or
out-of-order sections; whole-entry placeholder markers; invalid statuses;
multiple verdicts; and contradictory outcomes all become one final
`REVIEW_UNAVAILABLE`. `APPROVE` permits `- none` or MINOR-only findings, but
rejects any CRITICAL/MAJOR finding, REFUTED claim, or FAIL check in a top-level
or nested semantic entry. Explained UNVERIFIED claims and NOT-RUN checks record
evidence limits and may accompany APPROVE. `REVISE` requires an actionable
severity finding or decisive adverse REFUTED/FAIL status; uncertainty or
NOT-RUN alone does not justify REVISE.

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

No retry is enabled by default: each review request makes one Claude invocation.
An explicit retry allowance may be used only after a true runner-detected Claude
timeout. Nonzero Claude exits and signals are terminal; authentication,
configuration, spawn, cancellation, overflow, and report-contract failures also
stop after one attempt. Retries use new Claude
processes and new pinned worktrees but produce one outcome. Every unavailable
outcome contains `FINALITY` and a stable non-secret `STAGE` label. Missing/
auth-failed Claude, timeout, non-zero exit, or a malformed final review report
produces:

```text
REVIEW ENGINE: NONE - no verdict produced (attempted: Claude CLI, cross-vendor)
FINALITY: FINAL (...)
STAGE: <stable_failure_stage>

VERDICT: REVIEW_UNAVAILABLE
```

`REVIEW_UNAVAILABLE` is never approval. The Director raises the protocol's
cross-family-unavailable warning and uses the native fresh-context OpenAI
reviewer.

The MCP transport independently enforces the same boundary. Empty or
whitespace-only runner stdout (including exit code 0), abnormal runner exit,
cancellation, a wedged-runner backstop, capture overflow, or output without one
complete validator-accepted report becomes a non-empty `REVIEW_UNAVAILABLE`
report. The exact validator reason is retained on its own bounded, redacted
line, while raw stdout/stderr are independently represented by one bounded,
redacted head-and-tail preview so both the beginning and failure suffix survive.
A valid runner
report is returned byte-for-byte; the Director must not append its own text.
Its `retries` argument is strictly a JSON integer `0` or `1`; invalid runtime
types or values return an MCP invalid-parameters error before the runner starts.

## Configuration

The installer maintains only the marked Claude-pack block in
`.codex/config.toml`; all other project settings remain user-owned. The MCP
registration is project-scoped because Codex 0.153.x can omit servers declared
only in a spawned custom-agent TOML. Re-run the installer after selecting or
removing the pack so the marked block matches the installed hooks.

Durable settings live under `claude` in `.codex/orchestra.json`:

```json
{
  "claude": {
    "bin": "claude",
    "reviewModel": "opus",
    "reviewEffort": "high",
    "visualModel": "opus",
    "visualEffort": "high",
    "visualTimeoutMs": 1800000,
    "reviewTimeoutMs": 1800000,
    "reviewRetries": 0,
    "reviewKillSurvivors": true,
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
| `visualModel` | `ORCHESTRA_CLAUDE_VISUAL_MODEL` | `opus` |
| `visualEffort` | `ORCHESTRA_CLAUDE_VISUAL_EFFORT` | `high` (`xhigh` selectable) |
| `visualTimeoutMs` | `ORCHESTRA_CLAUDE_VISUAL_TIMEOUT_MS` | `1800000` |
| `reviewTimeoutMs` | `ORCHESTRA_CLAUDE_REVIEW_TIMEOUT_MS` | `1800000` |
| `reviewRetries` | `ORCHESTRA_CLAUDE_REVIEW_RETRIES` | `0` |
| `reviewKillSurvivors` | `ORCHESTRA_CLAUDE_REVIEW_KILL_SURVIVORS` | `true` |
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

## Process supervision

The real Claude review and planning invocations run under the shared
process-tree supervisor. Each attempted run reports a process census before
the Claude output or unavailable verdict. Missing or incomplete supervisor
receipts fail closed. Attributed descendants that outlive Claude are reaped by
default.

For review, set `ORCHESTRA_CLAUDE_REVIEW_KILL_SURVIVORS=0` or
`claude.reviewKillSurvivors=false` only for diagnosis. Planning uses
`ORCHESTRA_CLAUDE_PLAN_KILL_SURVIVORS` with a default of `true`.
`ORCHESTRA_JOBRUN=off` disables supervision for both lanes and is stated
loudly in their output.

Every receipt and process-census block labels overall descendant coverage
`BEST-EFFORT` on every current platform. Engines are launched unsuspended, so
on Windows a child can start before the engine is assigned to the Job object.
After successful assignment, separate receipt/output metadata labels Job
membership and enabled Job enforcement `AUTHORITATIVE` only from that instant
onward; it does not upgrade whole-run lineage coverage. On Linux, best-effort
attribution also scans only same-uid processes started after the run for an
exact inherited, non-secret `ORCHESTRA_JOBRUN_TOKEN` entry in
`/proc/<pid>/environ`; the scan never retains or prints environment contents.
A descendant can still evade attribution through the Windows pre-assignment
window, by clearing its environment, changing uid, or running on a platform
without readable Linux `/proc` environment data. Accordingly, an empty
attributed-survivor list is evidence about the available sources, not proof of
complete lineage cleanup. These limitations do not disable review or planning
lanes.

On Windows, prefer a native Claude executable when one is available. A
`.cmd` or `.bat` shim is launched through an explicitly quoted `cmd.exe`
command line, but Windows can let a very fast shim spawn its child before
Job-object assignment completes. The supervisor reports what it can prove
and keeps a missing receipt fail closed.

The installed planning runner remains directly invokable:

```bash
node .codex/hooks/orchestra-ultraplan.js \
  --plan <path> --brief <path> --round <n>
```

Its stable defaults remain model `fable`, effort `max`, timeout `900000`
milliseconds, external role `planner-claude-external`, and no tools.
