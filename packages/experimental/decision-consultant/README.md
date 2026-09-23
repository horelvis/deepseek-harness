---
description: "Add an experimental Jev/Kev (System One) second-opinion gate before configured tool calls; shadow by default and never grants approval."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-decision-consultant

English | [中文](README.zh.md)

## Summary

Add an experimental System One second-opinion gate before configured tool calls. The host decides first; the consultant asks Jev or Kev one bounded, redacted question set and may only harden that decision to deny or ask, never grant approval. It defaults to OpenCode Zen's free Jev, shadow mode, and the migrator write tools; provider failures never grant permission. The dsh installation ships this layer switched off. It is experimental: model judgments can be wrong, and even shadow mode spends one provider request per gated call.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Install into a profile

From this source checkout, install the package into a profile through the existing CLI:

```sh
pnpm dsh plugin --profile web add ./packages/experimental/decision-consultant
```

The installation ships switched off. Set `mode` to `shadow` to log judgments without changing execution, or `enforce` to apply them. Remove the layer through the same CLI:

```sh
pnpm dsh plugin --profile web remove @deepseek-ai/dsh-experimental-decision-consultant
```

### Configuration

The plugin reads a validated configuration object. Every field has a safe default:

| Field | Default | Meaning |
|---|---|---|
| `mode` | `shadow` | `off` installs nothing, `shadow` logs only, `enforce` applies the hardening |
| `provider` | `opencode-zen` | `opencode-zen`, `kev`, `typesafe`, `openrouter`, or `custom` |
| `baseUrl` / `model` | provider preset | required for `custom`; otherwise the preset route |
| `keyEnv` | provider preset | environment variable holding the bearer credential |
| `tools` | migrator write tools | tool names to gate |
| `failMode` | `open` | `open` keeps the host decision, `closed-to-ask` escalates on failure |
| `policy` | none | optional operator policy forwarded to the model |
| `logPath` | `$DSH_HOME/logs/decision-consultant.log` | JSONL decision log |
| `timeoutMs` | `3000` | per-attempt request timeout |

### What you get

The gate prepends `tools/pre-execute`. The host decides first; when the gated tool's name matches, the consultant asks one batch of typed questions: `destructive`, `reads_secrets`, `sends_outbound`, `exfiltration`, `self_advocating`, and an `impact` rubric, plus a `verdict`. The deterministic policy in [`src/policy.ts`](src/policy.ts) turns those probabilities into at most a `deny` or `ask`. Only credential or sensitive-data exfiltration can deny; every other risk escalates to the human. A provider failure never grants permission.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`cordis.patch.yml`](cordis.patch.yml) inserts the package as the `decision-consultant` row. [`src/index.ts`](src/index.ts) requires only the tools service and installs the prepended listener. [`src/provider.ts`](src/provider.ts) resolves the endpoint, model, and bearer credential from a preset or explicit overrides. [`src/redact.ts`](src/redact.ts) masks secret-shaped keys and truncates arguments. [`src/systemone.ts`](src/systemone.ts) is a minimal System One client with a timeout, one bounded 429/529 retry, and no implicit success. [`src/policy.ts`](src/policy.ts) owns every threshold and rule; the model never chooses the outcome. [`src/log.ts`](src/log.ts) appends one JSONL record per decision with rotation.

The gate listens in `enforce` by awaiting one consultation, then applies [`harden`](src/gate.ts); in `shadow` it consults asynchronously and returns the host decision unchanged. The host's own denial or cancellation always wins, and the consultant never returns `allow`.

No runtime invariant companion is published: this single effect owns the consultation, hardening, and logging, and has no independent observation that can diverge from those owned operations.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Experimental packages](../README.md) — publication policy and dependency isolation.
- [Tools](../../core/tools/README.md) — the `tools/pre-execute` waterfall and `PreToolDecision`.
- [Jev on OpenCode Zen](https://opencode.ai/docs/zen/) — the default System One endpoint.
- [Kev](https://github.com/jaredpalmer/kev) — the local System One-compatible decision model.

-----

<a id="model-experience"></a>
## Model Experience

### Consultation

#### What the model sees

The consultant sends one bounded `state` (the tool name and redacted arguments) plus the typed question set to the configured System One endpoint. It never sends conversation history, files, tool output, or the main model's context. The endpoint returns typed answers and probabilities that never enter the main conversation.

#### Token effect

One additional provider request per gated call, at the System One endpoint. The default provider is the free Jev tier; no main-model tokens are consumed and no answer text is added to the main context. Shadow mode still makes the request.

#### KV Cache effect

The consultant does not touch the main agent's request or its KV cache. Its own state varies per gated call and shares no prefix with the conversation.

### Hardening

#### What the model sees

A denial from the consultant uses the ordinary tool-denial path with a `Decision consultant:` reason. An escalation becomes an ordinary `ask`, which flows through the existing approval service and its human presentation. The raw answers and probabilities stay in the JSONL decision log.

#### Token effect

A hardened call contributes only the ordinary `ask` or denial the host would already produce; the main model sees no extra context.

#### KV Cache effect

Hardening appends an ordinary decision to the existing pipeline; it does not rewrite earlier context or hide model-visible information.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The consultant is experimental and switched off by default; it must be installed and set to `shadow` or `enforce`.
- Model judgments can be wrong, and probabilities are not calibrated on new sources. The deterministic rules reduce but do not remove that risk.
- Only credential or sensitive-data exfiltration can deny. Every other risk escalates to the human, so `enforce` cannot auto-approve.
- The gate consults after the host decision; it cannot repair arguments, only harden the outcome.
- One provider request is made per gated call, including in `shadow` mode.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
