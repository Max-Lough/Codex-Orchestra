# Pack template

Copy this directory to `packs/<your-pack>/` and edit `pack.json`. Directories
whose names begin with `_` are intentionally ignored by the installer.

The installer discovers these optional surfaces recursively:

```text
packs/<your-pack>/
├── pack.json                required; `name` matches the directory
├── agents/*.toml            → <project>/.codex/agents/
├── hooks/*.js               → <project>/.codex/hooks/
└── skills/<skill>/          → <project>/.agents/skills/<skill>/
    └── SKILL.md
```

Install a pack with:

```bash
node install.js /path/to/project --packs <your-pack>
```

Pack dependencies must be optional. A missing binary, credential, or service
returns an explicit `*_UNAVAILABLE` result; it must never make the core Codex
harness unusable.
