# dsh-chat

> A DSH Web collaboration platform for self-hosted teams, managed teams, and enterprise organizations.

[简体中文](./README.md) · [Design Wiki](./docs/README.md) · [Contributing](./CONTRIBUTING.en.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

---

## What this is

dsh-chat is a set of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugins that bring organization-scoped team collaboration to DSH Web: identity and devices, organizations and permissions, direct text messaging, work items and reviews, a notification inbox, and audit.

It follows DSH's "everything is a plugin" model — **there is no privileged chat kernel**. Apart from the pure-type package `@dsh-chat/contract`, every capability is a Cordis plugin that can be loaded and unloaded independently.

## Status

**Not released.** `P0-a`'s skeleton steps and acceptance checklist are fully covered, and the plugin now **loads and renders in DSH Desktop v2.0.4** ([screenshot](./docs/_meta/dsh-integration-evidence.md)).

| Stage | Scope | Status |
|---|---|---|
| `P0-a` | Write protocol, delivery semantics, same-transaction audit | §43 skeleton steps and the §44.1.2 checklist are fully covered |
| `P0-b` | Second factor, recovery, presence visibility, local search, full protocol-negotiation acceptance | Not started (the negotiation codec is implemented) |
| `P1`–`P4` | Groups and resources, collaboration sessions and bots, governance and analytics, enterprise and E2EE | Not started |

**Per-stage progress, completed items, and gaps are tracked in [TODO.md](./TODO.md).** See the [iteration plan](./docs/04-roadmap/03-iteration-plan.md) for stage boundaries and acceptance criteria.

### What works today

The following run **over real HTTP**, backed by 506 tests:

- **Direct messaging** — send, lease-based pull, acknowledge, edit, revoke
- **Organizations** — create organization/workspace/project, invite members, accept invitations
- **Work items** — create, assign with notification, add dependencies (with cycle detection), review gate
- **Notifications** — cursor-based inbox catch-up, 5-minute aggregation window, SSE event stream

Every write endpoint has cross-origin protection, injected authentication, and same-transaction
audit. The identity side additionally has device registration and Ed25519 request signing
(nonce deduplication, clock-skew tolerance window).

Integration acceptance runs **three real OS processes**: one relay plus two hosts, each with
its own local database.

### Known gaps

| Gap | Impact |
|---|---|
| Data source for the conversation list | Components and presentation rules are ready and tested, but the host lacks a per-conversation aggregation endpoint |
| Relay client abstraction | The host calls relay HTTP directly in the three-process acceptance. **The plugin still calls local domain code and does not go through the relay yet** |

Second factor, recovery, presence, groups, and attachments belong to later gates; their entry
points are **explicitly absent rather than pretending to work**.

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
| DSH runtime | `0.1.2-alpha.1`, matching DSH Desktop `v2.0.4` |
| Language | TypeScript, ESM-only |
| Node | `^22.19.0 \|\| >=24.0.0` |
| Client | React 18 + CSS Modules |
| Config validation | [`@deepseek-ai/schemastery`](https://www.npmjs.com/package/@deepseek-ai/schemastery) |
| Persistence | `P0` SQLite (L1); `P1` onward PostgreSQL + Redis + object storage (L2) |

> The DSH runtime is **not installed from npm.** Upstream moved to vendored tarball distribution as of `0.1.2-alpha.1`, and the `latest` tag on npm points at a version far older than the current one.
> Exact versions, the source commit, verification, and the upgrade process are recorded in the [implementation log](https://github.com/xyingsoft/dsh-chat/blob/main/docs/_meta/implementation-log.md); this table is only an overview.

## License

[MIT](./LICENSE)
