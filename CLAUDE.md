# memloom

Local-first memory engine for AI agents.

## Example values in docs and config

The repo is public and GitHub secret scanning reads every commit. Example values for env
variables, keys, tokens, passwords and ids must be obvious placeholders, never strings shaped
like the real thing.

- Write `MEMLOOM_EXTENSION_IDS=your-firefox-internal-uuid` or `ANTHROPIC_API_KEY=your-anthropic-key`,
  not a made-up UUID or `sk-ant-...` string. A fake UUID was flagged as an OpenVSX token.
- This covers docs/, README, config.env.example, code comments and PR descriptions.
- Tests that need a real-looking shape (redaction tests, for example) build the value at runtime,
  such as `` `sk-or-v1-${"0123456789abcdef".repeat(4)}` ``, so no full literal sits in the source.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

When shipping (any /ship run), verify docs freshness before committing: if the diff
changes CLI commands, routes, supported formats, env vars, or user-facing workflows,
the pages under docs/ that describe them must be updated in the same PR.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Writing any PR description (including inside /ship) → invoke /pr-description first
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec
