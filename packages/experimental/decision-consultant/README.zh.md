---
description: "在受配置的工具调用之前加入实验性 Jev/Kev（System One）第二意见闸门；默认影子模式，永不放行审批。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-decision-consultant

[English](README.md) | 中文

## 概述

在受配置的工具调用之前加入实验性 System One 第二意见闸门。宿主先做决定；顾问向 Jev 或 Kev 询问一组有界、已脱敏的问题，并且只能把该决定收紧为拒绝或询问，永不放行审批。默认使用 OpenCode Zen 的免费 Jev、影子模式和 migrator 写工具；提供方失败永不授予权限。dsh 安装包默认关闭该层。它是实验性的：模型判断可能出错，而且即使是影子模式，每次受闸调用也会产生一次提供方请求。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发者备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

### 安装到 profile

从源码检出目录，通过现有 CLI 安装：

```sh
pnpm dsh plugin --profile web add ./packages/experimental/decision-consultant
```

安装后处于关闭状态。将 `mode` 设为 `shadow` 可只记录判断而不改变执行，设为 `enforce` 则应用判断。通过同一 CLI 移除：

```sh
pnpm dsh plugin --profile web remove @deepseek-ai/dsh-experimental-decision-consultant
```

### 配置

插件读取一个经过校验的配置对象，所有字段都有安全默认值：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `mode` | `shadow` | `off` 不安装，`shadow` 仅记录，`enforce` 应用收紧 |
| `provider` | `opencode-zen` | `opencode-zen`、`kev`、`typesafe`、`openrouter` 或 `custom` |
| `baseUrl` / `model` | 提供方预设 | `custom` 必填；否则使用预设路由 |
| `keyEnv` | 提供方预设 | 存放 bearer 凭据的环境变量 |
| `tools` | migrator 写工具 | 要纳入闸门的工具名 |
| `failMode` | `open` | `open` 保留宿主决定，`closed-to-ask` 在失败时升级 |
| `policy` | 无 | 可选的运维策略文本，转发给模型 |
| `logPath` | `$DSH_HOME/logs/decision-consultant.log` | JSONL 决策日志 |
| `timeoutMs` | `3000` | 单次请求超时 |

### 你会得到什么

闸门前置到 `tools/pre-execute`。宿主先决定；当受闸工具名匹配时，顾问询问一批类型化问题：`destructive`、`reads_secrets`、`sends_outbound`、`exfiltration`、`self_advocating` 和 `impact` 评分，另加 `verdict`。[`src/policy.ts`](src/policy.ts) 中的确定性策略把这些概率转换为至多 `deny` 或 `ask`。只有凭据或敏感数据外泄才会拒绝；其他风险一律升级给人类。提供方失败永不授予权限。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

[`cordis.patch.yml`](cordis.patch.yml) 将本包插入为 `decision-consultant` 行。[`src/index.ts`](src/index.ts) 只依赖 tools 服务并安装前置监听器。[`src/provider.ts`](src/provider.ts) 从预设或显式覆盖中解析端点、模型和 bearer 凭据。[`src/redact.ts`](src/redact.ts) 掩码密钥形状的键并截断参数。[`src/systemone.ts`](src/systemone.ts) 是一个最小 System One 客户端，带超时、一次有界的 429/529 重试，且不会隐式成功。[`src/policy.ts`](src/policy.ts) 拥有全部阈值和规则；模型从不决定结果。[`src/log.ts`](src/log.ts) 每次决策追加一条 JSONL 记录并轮转。

在 `enforce` 下，闸门等待一次咨询后应用 [`harden`](src/gate.ts)；在 `shadow` 下，它异步咨询并原样返回宿主决定。宿主自身的拒绝或取消始终优先，顾问永不返回 `allow`。

未发布运行时 invariant 伴随文件：该单一 effect 拥有咨询、收紧与日志，没有会与其不一致的独立观测。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [实验性包](../README.zh.md) —— 发布策略与依赖隔离。
- [Tools](../../core/tools/README.zh.md) —— `tools/pre-execute` 瀑布与 `PreToolDecision`。
- [OpenCode Zen 上的 Jev](https://opencode.ai/docs/zen/) —— 默认 System One 端点。
- [Kev](https://github.com/jaredpalmer/kev) —— 本地 System One 兼容决策模型。

-----

<a id="model-experience"></a>
## 模型体验

### 咨询

#### 模型看到什么

顾问向配置的 System One 端点发送一个有界 `state`（工具名与脱敏参数）以及类型化问题集。它从不发送会话历史、文件、工具输出或主模型上下文。端点返回的类型化答案与概率不会进入主对话。

#### Token 影响

每次受闸调用在 System One 端点产生一次额外请求。默认提供方是免费 Jev 档位；不消耗主模型 token，也不会把答案文本加入主上下文。影子模式同样会产生该请求。

#### KV Cache 影响

顾问不触碰主 agent 的请求或其 KV cache。其自身状态按受闸调用变化，与会话不共享前缀。

### 收紧

#### 模型看到什么

顾问的拒绝走普通工具拒绝路径，理由带有 `Decision consultant:` 前缀。升级变成普通 `ask`，经现有审批服务与人工呈现流程。原始答案与概率仅留在 JSONL 决策日志中。

#### Token 影响

被收紧的调用只贡献宿主本就会产生的普通 `ask` 或拒绝；主模型看不到额外上下文。

#### KV Cache 影响

收紧在既有管线中追加一个普通决定；它不会重写既有上下文，也不会隐藏模型可见信息。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- 顾问是实验性的且默认关闭；必须安装并设为 `shadow` 或 `enforce`。
- 模型判断可能出错，概率在新来源上未校准。确定性规则能降低但无法消除该风险。
- 只有凭据或敏感数据外泄才会拒绝。其他风险一律升级给人类，因此 `enforce` 无法自动放行。
- 闸门在宿主决定之后咨询；它不能修正参数，只能收紧结果。
- 每次受闸调用都会产生一次提供方请求，影子模式亦然。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
