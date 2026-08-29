# dsh-chat

> A DSH Web collaboration platform for self-hosted teams, managed teams, and enterprise organizations.

[简体中文](./README.md) · [Design Wiki](./docs/README.md) · [Contributing](./CONTRIBUTING.en.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

---

## What this is

dsh-chat is a set of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugins that bring organization-scoped team collaboration to DSH Web: identity and devices, organizations and permissions, direct text messaging, work items and reviews, a notification inbox, and audit.

It follows DSH's "everything is a plugin" model — **there is no privileged chat kernel**. Apart from the pure-type package `@dsh-chat/contract`, every capability is a Cordis plugin that can be loaded and unloaded independently.

## Status

**Not released. Currently implementing `P0-a`.**

| Stage | Scope | Status |
|---|---|---|
| `P0-a` | Write protocol, delivery semantics, same-transaction audit | In progress |
| `P0-b` | Second factor, recovery, presence visibility, local search, protocol negotiation | Not started |
| `P1`–`P4` | Groups and resources, collaboration sessions and bots, governance and analytics, enterprise and E2EE | Not started |

See the [iteration plan](./docs/04-roadmap/03-iteration-plan.md) for stage boundaries and acceptance criteria.

## Documentation

**[`docs/`](./docs/README.md) in this repository is the single source of truth for implementation, review, and acceptance.**

Documents are organized in four layers — requirements → architecture → details → roadmap — and constraints only propagate downward:

| Layer | Directory | Answers |
|---|---|---|
| Requirements | [`01-requirements/`](./docs/01-requirements/) | What we build, for whom, and what we explicitly will not build |
| Architecture | [`02-architecture/`](./docs/02-architecture/) | What structure we use and how components are split |
| Technical details | [`03-details/`](./docs/03-details/) | How each mechanism actually works |
| Roadmap | [`04-roadmap/`](./docs/04-roadmap/) | When it ships and how it is accepted |

> **This project mandates documentation-first development.** Any change that touches requirements or architecture must update the documents before any code is written. See the [documentation workflow](./docs/_meta/documentation-workflow.md).

The root `DESIGN.md` is the pre-refactor single-file original, kept as a historical archive only. **It is no longer the basis for implementation.**

## Tech stack

| | |
|---|---|
| Plugin framework | [`@deepseek-ai/cordis`](https://www.npmjs.com/package/@deepseek-ai/cordis) 4.0.1 |
| DSH runtime | `@deepseek-ai/dsh-*` 0.1.1-rc.1 |
| Language | TypeScript, ESM-only |
| Node | `^22.19.0 \|\| >=24.0.0` |
| Client | React 18 + CSS Modules |
| Config validation | [`@deepseek-ai/schemastery`](https://www.npmjs.com/package/@deepseek-ai/schemastery) |
| Persistence | `P0` SQLite (L1); `P1` onward PostgreSQL + Redis + object storage (L2) |

## License

[MIT](./LICENSE)
