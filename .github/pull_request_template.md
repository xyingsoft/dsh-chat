<!--
本项目强制文档先行。提交前请对照 docs/_meta/documentation-workflow.md 第 2 节的变更分类表。
This project mandates documentation-first development. Check section 2 of docs/_meta/documentation-workflow.md before submitting.
-->

## 改动内容 / What changed

<!-- 简述这个 PR 做了什么 -->

## 动机 / Why

<!-- 为什么需要这个改动。若关联 Issue，写 Closes #123 -->

## 验证方式 / How this was verified

<!-- 跑了哪些测试、如何手工验证、覆盖了哪些失败路径 -->

---

## 检查清单 / Checklist

**流程 / Process**

- [ ] 本 PR 是**文档变更**或**纯实现重构（不改语义）**，或者对应的文档变更已先行合入
- [ ] 文档变更与代码变更**分开提交**
- [ ] 提交信息使用 conventional commits 风格并带 scope（`feat(messaging): ...`）
- [ ] 成对的双语文档已同步（`*.md` / `*.en.md`）

**文档一致性 / Documentation consistency**（改动涉及需求、架构、契约时）

- [ ] 变更从最上层受影响的文档开始修改，未出现下层突破上层约束
- [ ] 强约束词（必须／不得／绝不）未被无声弱化
- [ ] 新增的状态、错误码、术语已登记到[契约与规范附录](../docs/03-details/06-contracts-and-conventions.md)
- [ ] 新增能力已在[迭代计划](../docs/04-roadmap/03-iteration-plan.md)中定级
- [ ] 无「等实现完再补」的占位内容

**实现 / Implementation**（含代码改动时）

- [ ] 实现严格对齐已合入的文档，无未记录的行为差异
- [ ] 部署可变值（限流、配额、保留期、心跳阈值、权重）从配置读取，**未硬编码为常量**
- [ ] 所有 Cordis 注册通过 `ctx.effect()` / `ctx.on()` 完成并返回 disposer，卸载后无残留路由、任务或监听
- [ ] 未跨越仓库边界：`client` 不碰 relay 凭证与数据库，消费者不导入提供者内部实现，未自定义私有错误码

**测试 / Tests**

- [ ] 每个新增或修改的状态转换都有聚焦单元测试
- [ ] **触及授权、内容授权、出站或执行路径的改动已补充拒绝用例，且断言了具体错误码**
- [ ] 测试数据不含真实凭证、真实组织数据或可用密钥
- [ ] `yarn check` 全绿
