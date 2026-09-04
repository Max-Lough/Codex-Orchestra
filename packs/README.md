# Packs - optional Codex Orchestra modules

A pack is an opt-in group of agent profiles and hook runners that shares an
external dependency. The OpenAI Director, scouts, detectives, executors, native
fallback reviewer, guard, and core skills work without a pack.

```bash
node install.js /path/to/project --packs claude
```

## Available packs

| Pack | What it adds | Dependency |
|---|---|---|
| `claude` | Default cross-family review of OpenAI-authored campaigns and an optional Anthropic planning counterpart | Authenticated Claude CLI or `ANTHROPIC_API_KEY` |

Without the pack, campaigns use the fresh-context native OpenAI reviewer and
must be reported as lacking cross-family review. If the pack is installed but
the Claude lane fails, that is a visible fallback condition, not approval.

## Layout contract

```text
packs/<name>/
|-- pack.json
|-- config.toml                 optional project-scoped config block
|-- agents/*.toml
|-- hooks/*.js
|-- skills/<skill>/
`-- README.md
```

The installer discovers files from these directories. It wraps `config.toml`
in pack-specific markers inside the target `.codex/config.toml`; other project
settings remain user-owned. Pack filenames and config tables must not collide
with core harness files, another selected pack, or foreign project config.

Every external runner must degrade explicitly: a missing dependency, timeout,
transport error, or malformed response returns a named `*_UNAVAILABLE` result.
Pack transports and launchers relay the external result; they do not replace it
with their own judgment.

To create a pack, copy `_TEMPLATE/`, set `pack.json.name` to the directory name,
and add uniquely named profiles, hooks, and orchestration-class skills.
