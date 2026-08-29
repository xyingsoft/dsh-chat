# 第三方组件声明 / Third-Party Notices

本仓库在 `vendor/` 目录中直接分发了以下第三方软件的构建产物（tarball）。
This repository redistributes build artifacts (tarballs) of the following third-party software under `vendor/`.

它们不是从 npm 安装的 —— 上游自 `0.1.2-alpha.1` 起将 DSH 运行时改为 vendored tarball 分发，该版本未发布到 npm。
They are not installed from npm: upstream moved the DSH runtime to vendored tarball distribution as of `0.1.2-alpha.1`, and that version is not published to npm.

---

## DeepSeek Harness 运行时 / DeepSeek Harness runtime

- **来源仓库 / Source repository**：<https://github.com/deepseek-ai/deepseek-harness>
- **来源 commit / Source commit**：`cd5ef8148158c3a752a658978873241fdf8e2bbc`
- **版本 / Version**：`0.1.2-alpha.1`
- **许可 / License**：MIT，Copyright © 2026 DeepSeek
- **位置 / Location**：`vendor/dsh-runtime/0.1.2-alpha.1/`
- **完整性 / Integrity**：逐包 sha256 记录于同目录 `manifest.json`，并由 `scripts/verify-vendored-runtime.mjs` 在每次 `yarn check` 时校验

收录的包 / Packages included:

| 包 / Package | 版本 / Version |
|---|---|
| `@deepseek-ai/dsh-host-webserver` | `0.1.2-alpha.1` |
| `@deepseek-ai/dsh-invariants` | `0.1.2-alpha.1` |

每个 tarball 内均包含其自身的 `LICENSE` 文件。上游完整发行集合为 241 个包；此处只收录本项目实际依赖的闭包。
Each tarball ships its own `LICENSE` file. The complete upstream release comprises 241 packages; only the closure this project actually depends on is vendored here.

---

## 其他依赖 / Other dependencies

其余依赖均通过 npm 常规安装，其许可信息见各自的包元数据与 `yarn.lock`。
All other dependencies are installed from npm in the usual way; their license information is in the respective package metadata and `yarn.lock`.

## 更新本文件 / Updating this file

升级 DSH 运行时版本时，须同步更新本文件的 commit、版本与包列表，并重新对照上游 `manifest.json` 核对 sha256。
When upgrading the DSH runtime, update the commit, version, and package list here, and re-verify the sha256 values against the upstream `manifest.json`.
