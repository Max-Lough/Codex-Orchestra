# Codex-Orchestra

Codex-Orchestra is the provider-inverted mirror of Claude-Orchestra: Codex
directs the work, OpenAI agents scout and implement it, and Claude supplies the
default independent review of OpenAI-authored campaigns.

The operating loop is deliberately small:

```text
INTAKE -> RECON -> PLAN -> EXECUTE -> REVIEW -> REPORT
```

The primary Codex task is the Director. It decomposes, delegates, arbitrates,
and communicates; custom agents do repository work. A project hook enforces
that split, and every campaign must cross an independent review gate before it
is reported complete.

## Company

| Role | Profile | Default model | Responsibility |
|---|---|---|---|
| Director | primary Codex task | GPT-5.6 Sol / high | intake, decisions, delegation, synthesis, user communication |
| Scout | `scout` | GPT-5.6 Luna / medium | fast read-only file, symbol, usage, history, and web mapping |
| Detective | `detective` | GPT-5.6 Sol / high | read-only causal investigation and invariant discovery |
| Executor | `executor` | GPT-5.6 Terra / high | routine scoped implementation and verification |
| Heavy executor | `executor-heavy` | GPT-5.6 Sol / high | hard or escalated implementation |
| Deep executor | `executor-heavy-xhigh` | GPT-5.6 Sol / xhigh | the hardest split-resistant implementation |
| Native reviewer | `reviewer` | GPT-5.6 Sol / max | fresh-context fallback; primary review of Anthropic-authored work |
| Claude reviewer | `reviewer-claude` | OpenAI launcher -> Claude | default independent review of OpenAI-authored work |

The Claude reviewer is installed by the optional `claude` pack. Without it,
the harness remains usable and routes review to the fresh native reviewer,
while stating that the cross-family lane is not installed.

## Requirements

- Node.js 20 or newer for the installer and local hooks.
- A current Codex installation for the Director and OpenAI worker profiles.
- For cross-family review: the Claude CLI, either authenticated interactively
  or configured with the credentials your Claude installation expects.

## Install

Clone this repository, then install into a different project directory:

```bash
node install.js /path/to/project --packs claude
```

PowerShell and POSIX wrappers are also included:

```powershell
.\install.ps1 "C:\path\to\project" -Packs claude
```

```bash
./install.sh /path/to/project --packs claude
```

The installer is idempotent. A plain re-run inherits the previously selected
packs and specialists. Use `--no-packs` to remove optional pack-owned files,
or pass a new comma-separated list to `--packs`.

Useful commands:

```bash
node install.js --lint
node install.js --scan /path/to/projects
node install.js --scan /path/to/projects --update
node install.js /path/to/project --specialists modeler
node install.js /path/to/project --uninstall
```

`install-codex.*` remains as a compatibility alias for the canonical
`install.*` entry point.

## Install beside Claude-Orchestra

Both harnesses can occupy one project. Install Claude-Orchestra into its
`.claude/` surface and Codex-Orchestra into its `.codex/` surface, with either
install order:

```bash
node /path/to/Claude-Orchestra/install.js /path/to/project --packs codex
node /path/to/Codex-Orchestra/install.js /path/to/project --packs claude
```

Their root integration files are also distinct: Claude-Orchestra manages a
block in `CLAUDE.md` and its own `.mcp.json` registration; Codex-Orchestra
manages a block in `AGENTS.md` and installs skills under `.agents/skills/`.
Updates and uninstall operate only on the owning harness's receipt and surface.

Cross-family subprocesses are isolated from the other installed Director:
Codex-Orchestra launches Claude with restricted safe mode, while the matching
Claude-Orchestra Codex review, execution, and cross-compare runners disable
project hooks and `AGENTS.md` discovery and identify themselves with scoped
external worker roles. This prevents a child session from recursively starting
the opposite Orchestra.

The per-harness pause files (`.claude/orchestra.pause` and
`.codex/orchestra.pause`) pause only their owner. The legacy environment switch
`ORCHESTRA_PAUSE=1` is intentionally process-wide and pauses both.

## Installed layout

```text
<project>/
|-- AGENTS.md                         managed Orchestra block; user text preserved
|-- .codex/
|   |-- ORCHESTRA.md                  version-stamped protocol copy
|   |-- config.toml                   recommended scaffold; written once
|   |-- hooks.json                    Orchestra entries merged with user hooks
|   |-- orchestra-install.json        hashed ownership, pack, and specialist receipt
|   |-- agents/
|   |   |-- scout.toml
|   |   |-- detective.toml
|   |   |-- executor.toml
|   |   |-- executor-heavy.toml
|   |   |-- executor-heavy-xhigh.toml
|   |   |-- reviewer.toml
|   |   `-- reviewer-claude.toml      with the claude pack
|   `-- hooks/
|       |-- package.json              forces CommonJS beneath ESM projects
|       |-- orchestra-guard.js
|       |-- orchestra-review.js       Claude CLI runner, with the claude pack
|       `-- orchestra-review-mcp.js   blocking review transport, with the claude pack
`-- .agents/skills/
    |-- orchestra-plan/SKILL.md
    |-- orchestra-review/SKILL.md
    `-- orchestra-status/SKILL.md
```

The installer does not touch `.claude/`. Codex and Claude can therefore have
their own independent project setup if a project intentionally uses both.

## Review routing

Review follows authorship, not a project-level opt-out switch:

- OpenAI-authored work uses `reviewer-claude` when the pack is installed.
- Anthropic-authored work uses the fresh native `reviewer` so author and
  reviewer remain in different model families.
- If the pack is absent, the native reviewer runs and the final report notes
  the expected missing cross-family lane once.
- If the pack is installed but Claude cannot run, the Director immediately
  displays the following alarm, then performs fresh-context native review:

> ⚠ CROSS-FAMILY REVIEW UNAVAILABLE — Claude did not review this campaign: `<reason>`. Falling back to fresh-context OpenAI review; work continues.

The campaign may be reported complete only after a real reviewer verdict. An
unavailable external lane is never described as approval.

For committed work, pass exact base and head refs. The runner creates a clean,
detached worktree outside the repository so the review is pinned to the commit
that will ship. An explicitly uncommitted review uses the live tree and checks
that the tree did not change during review.

The thin launcher makes one typed call to the project-scoped
`orchestra_claude_review.orchestra_review` MCP tool. That transport blocks until
the runner closes and relays a valid report byte-for-byte. Empty stdout,
abnormal exit, timeout/cancellation, or malformed output is converted to an
explicit `REVIEW_UNAVAILABLE` result. For standalone diagnosis, the underlying
runner can still be invoked directly:

```bash
node .codex/hooks/orchestra-review.js \
  --work-order <file> \
  --executor-report <file> \
  --base-ref <base-sha> \
  --head-ref <head-sha>
```

Run the non-mutating lane check with:

```bash
node .codex/hooks/orchestra-review.js --doctor
```

The runner reports `REVIEW ENGINE: NONE`, `VERDICT: REVIEW_UNAVAILABLE`, and a
`FINALITY` line when no Claude verdict was produced. One bounded retry is one
review outcome, not a hidden second approval opportunity.

## Configuration

Project policy lives in optional `.codex/orchestra.json`. Absence means the
defaults below. Unknown keys are ignored so project-owned extensions survive.

```json
{
  "verification": {
    "full": "npm test",
    "lint": "npm run lint",
    "shards": ["npm test -- unit", "npm test -- integration"],
    "protected": ["npm test -- integration"]
  },
  "directorBlockedPatterns": ["^mcp__production__"],
  "directorAllowedTools": [],
  "directorPlanPatterns": [],
  "claude": {
    "reviewModel": "opus",
    "reviewEffort": "high",
    "reviewTimeoutMs": 1800000,
    "reviewRetries": 1,
    "authProbe": true,
    "probeTimeoutMs": 90000,
    "worktreeRoot": "",
    "doNotRun": [],
    "integrityIgnore": []
  }
}
```

Review settings resolve in this order: command-line flag, environment variable,
`.codex/orchestra.json`, built-in default. Per-run flags include `--model`,
`--effort`, `--timeout-ms`, `--retries`, `--probe-timeout-ms`,
`--worktree-root`, `--claude-bin`, `--no-auth-probe`, `--no-tests`, and repeated
`--forbid` commands. The verdict header records the effective settings.

`verification` is the canonical command set for executors and reviewers. The
executor runs it first and the reviewer independently runs it again. A proven
inert change may narrow verification, but it does not skip review.

## Guard and pause behavior

`.codex/hooks.json` registers the Director guard for `SessionStart` and
`PreToolUse`. Codex asks the user to trust project hooks before they run. The
guard blocks repository reads, searches, edits, and commands in the primary
task while custom worker profiles run with hooks disabled and their own role
instructions.

The Director can directly manage goal state and Markdown plans beneath
`.codex/plans/`. Plan paths are checked for lexical containment, real-path
containment, symlink/junction escape, and hardlink aliases. Nested
`functions.exec` calls are parsed and held to the same restrictions.

To pause, the user creates `.codex/orchestra.pause` outside the agent tool loop
or sets `ORCHESTRA_PAUSE=1`. The Director cannot operate its own pause switch.
Delete the file or clear the variable to resume. Use `--uninstall` for removal.

## Packs, skills, and specialists

Packs are optional dependency bundles beneath `packs/`. A pack may contribute
TOML profiles, hook runners, and project skills. Missing pack dependencies must
produce explicit unavailable results without breaking the core harness.

The `claude` pack provides:

- `reviewer-claude`, a thin OpenAI launcher for independent Claude review;
- the blocking MCP transport plus pinned review runner and doctor;
- `planner-claude` and its planning counterpart for optional cross-vendor plan
  critique.

Core orchestration skills are installed to `.agents/skills/`:

- `orchestra-plan` writes durable, reviewable work orders;
- `orchestra-review` reviews an existing diff or commit range on demand;
- `orchestra-status` reports mode, wiring, company, pack health, and plans.

Specialists are executor variants from `agents/specialists/`, selected with
`--specialists`. Packs and specialists are recorded in the install receipt.
Managed paths are namespace-limited and content-hashed, so pruning and
uninstall preserve files changed since installation.

## Development

The project intentionally has no runtime dependencies or package manager
manifest. Run the complete local suite directly with Node:

```bash
node install.js --lint
node tests/provider-contract.test.js
node tests/install.test.js
node tests/coexistence.test.js
node tests/guard.test.js
node tests/review-lane.test.js
node tests/review-transport.test.js
```

The opt-in end-to-end probe installs both sibling harnesses into a temporary
Git repository and spends one real Codex call plus one real Claude call:

```bash
node tests/coexistence-live.test.js --live
```

CI runs the same checks on supported Node versions. The active product surface
is the root protocol, installer, profiles, skills, guard, and `packs/claude/`.
The `plans/`, `research/`, and `roster/` trees are historical design evidence,
not installed runtime.

## License

[MIT](LICENSE)
