# 安全策略 / Security Policy

## 报告漏洞 / Reporting a vulnerability

**请不要通过公开 Issue 报告安全漏洞。**
**Please do not report security vulnerabilities through public Issues.**

请使用 GitHub 的私密漏洞报告通道：
Use GitHub's private vulnerability reporting instead:

**[Report a vulnerability](https://github.com/xyingsoft/dsh-chat/security/advisories/new)**

报告请尽量包含：受影响的组件与版本、复现步骤、影响范围评估，以及你认为合适的修复方向。
Please include, where you can: the affected component and version, reproduction steps, an assessment of the impact, and any fix direction you would suggest.

我们会在收到报告后确认收悉，并在修复发布前与你同步进展。在修复发布前请勿公开披露。
We will acknowledge receipt and keep you updated until a fix ships. Please hold public disclosure until then.

## 支持范围 / Supported versions

本项目**尚未发布**，当前处于 `P0-a` 实现阶段，没有已发布版本可供支持。
This project is **unreleased** and currently implementing `P0-a`. There are no released versions to support yet.

在此期间，安全报告仍然欢迎 —— 尤其是针对[安全与合规文档](./docs/03-details/04-security-compliance.md)中所声明约束的设计层面问题。
Security reports are still welcome in the meantime — especially design-level issues against the constraints declared in the [security and compliance document](./docs/03-details/04-security-compliance.md).

## 安全设计基线 / Security design baseline

本项目的安全约束写在文档里并作为验收条件，不是事后补充：
This project's security constraints live in the documents and act as acceptance criteria, not as an afterthought:

- [安全与合规 / Security and compliance](./docs/03-details/04-security-compliance.md) —— 租户隔离、授权链、SSRF 防护、加密与密钥、审计模型、安全规范清单
- [测试与验收策略 / Test and acceptance strategy](./docs/04-roadmap/04-test-strategy.md) —— **安全回归用例库是交付物而不是一次性验证**

触及授权、内容授权、出站或执行路径的改动，必须同时补充对应的拒绝用例才能合入。
A change that touches authorization, content grants, egress, or execution paths must add the matching rejection cases before it can land.
