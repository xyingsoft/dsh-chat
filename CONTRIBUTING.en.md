# Contributing

[简体中文](./CONTRIBUTING.md)

Thanks for considering a contribution to dsh-chat. This document explains how different roles can take part, and the process you must follow before submitting code.

---

## The one rule that matters most: documentation first

> **Any change that touches requirements or architecture must update the relevant documents before any code is written.**

This is not a suggestion — it is a mandatory process in this repository. [`docs/`](./docs/README.md) is the **single source of truth** for implementation, review, and acceptance. When code and documentation disagree, the answer is never "the code wins, document it later"; decide which side is correct and fix that side.

**"Write the code now, document it later" is treated as a process defect, on par with skipping tests.**

The full workflow, the change-classification table, and the review checklist live in the [documentation workflow](./docs/_meta/documentation-workflow.md). Before opening a PR, check your change against the table in section 2 of that document to confirm which documents you needed to update.

---

## Users: feedback and word of mouth

- Use [Issues](https://github.com/xyingsoft/dsh-chat/issues) to report defects or request capabilities. Please use the matching template; for defects include reproduction steps, expected behaviour, and actual behaviour.
- **Do not** open an Issue for security problems — see [SECURITY.md](./SECURITY.md).
- The project is unreleased, so usage questions are out of scope for now. Implementation progress is in the [status table in the README](./README.en.md#status).

## Plugin authors: extending the ecosystem

dsh-chat is itself a set of DSH plugins. If you are writing a plugin that works alongside it:

- Depend only on the types, commands, events, and error codes exposed by `@dsh-chat/contract`. **Do not** import a service provider's internal implementation or database models.
- Consume capabilities through service interfaces (`ChatIdentity`, `ChatOrganization`, `ChatMessaging`, and so on). The capability matrix is in the [plugin architecture](./docs/02-architecture/02-plugin-model.md).
- Organization-public plugins always run within a capability lease and the member's ACL. They **cannot** replace the identity, authorization, audit, egress, or key-management plugins.

## Developers: contributing code

### Development environment

| Requirement | Version |
|---|---|
| Node | `^22.19.0 \|\| >=24.0.0` |
| Package manager | Yarn (enabled via corepack) |

```bash
corepack enable
yarn install --immutable
yarn check
```

### Repository boundaries (read before you start)

These boundaries come from the architecture documents. Violating them is a defect, and review will send the change back:

- **`@dsh-chat/contract` is the only shared protocol package**, and it carries no database driver, HTTP framework, or business side effects. The error-code catalogue, the `AuditEvent` structure, `ProtocolVersion`, and the glossary are defined only here. Plugins **must not** redefine these concepts or introduce private error codes.
- **`client` never touches relay credentials or the database**, and never recomputes permissions in the browser. The actions the UI offers come from the capability description returned by the host.
- **`host` is the browser's only entry point to the organization and the relay.** The browser never talks to the relay directly.
- **`kernel` / `team` / `enterprise` are bundles only.** They arrange plugins, supply default configuration, and select providers — they **do not** hold business singletons.
- **Deployment-variable values must be read from configuration.** Rate limits, quotas, retention periods, heartbeat thresholds, and ranking weights are schema-validated organization configuration and **must not** be written as code constants.
- **Every Cordis registration goes through `ctx.effect()` or `ctx.on()` and returns its disposer.** After a plugin unloads, no route, background task, or event listener may remain.

### Commits and pull requests

- Branch from `main`, named `feat/...`, `fix/...`, `docs/...`, or `chore/...`.
- **Direct pushes to `main` are forbidden.** Everything lands through a PR.
- Use [conventional commits](https://www.conventionalcommits.org/) with a scope, for example `feat(messaging): ...`, `fix(identity): ...`, `docs: ...`.
- Keep documentation changes **synchronized across languages** (paired files such as `CONTRIBUTING.md` / `CONTRIBUTING.en.md`).
- Run `yarn check` before committing and make sure it is green.
- **Commit documentation changes separately from code changes** so history stays traceable.
- Describe what changed, why, and how you verified it. Merge only after CI passes.

### Testing requirements

- Every state transition needs a focused unit test. Use `assertNever` to keep closed unions exhaustive.
- **A change that touches authorization, content grants, egress, or execution paths must add the matching rejection cases before it can land.** Security cases assert the rejection behaviour and the error code, not merely "it did not crash".
- Test data **must not** contain real credentials, real organization data, or usable keys.

The layered testing strategy is in the [test and acceptance strategy](./docs/04-roadmap/04-test-strategy.md).

---

## Code of conduct

By taking part in this project you agree to abide by the [Code of Conduct](./CODE_OF_CONDUCT.en.md).
