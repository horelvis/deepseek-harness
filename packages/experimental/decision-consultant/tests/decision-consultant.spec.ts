import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { apply, Config, name, inject } from '../src/index.ts'
import { installGate, MIGRATOR_WRITE_TOOLS } from '../src/gate.ts'
import { buildQuestions, DEFAULT_THRESHOLDS, evaluate } from '../src/policy.ts'
import { resolveProvider } from '../src/provider.ts'
import { buildState, redactArguments, redactValue, TRUNCATION_MARKER } from '../src/redact.ts'
import { consultSystemOne, ConsultError, parseRetryAfter } from '../src/systemone.ts'
import { appendDecision, resolveLogPath } from '../src/log.ts'
import type { AnswerMap, ConsultResult, GateState, QuestionMap } from '../src/types.ts'

const emptyEnv: NodeJS.ProcessEnv = {}

describe('provider resolution', () => {
  it('defaults to OpenCode Zen Jev free without a credential', () => {
    expect(resolveProvider({}, emptyEnv)).toEqual({
      provider: 'opencode-zen',
      baseUrl: 'https://opencode.ai/zen/v1/systemone',
      model: 'jev-1.13-free',
    })
  })

  it('attaches the credential named by the preset environment variable', () => {
    const zen = resolveProvider({}, { OPENCODE_API_KEY: 'z-key' })
    expect(zen.apiKey).toBe('z-key')
    expect(resolveProvider({ provider: 'typesafe' }, { TYPESAFE_API_KEY: 't' }).apiKey).toBe('t')
    expect(resolveProvider({ provider: 'openrouter' }, { OPENROUTER_API_KEY: 'o' }).apiKey).toBe('o')
  })

  it('ignores an empty environment value', () => {
    expect(resolveProvider({}, { OPENCODE_API_KEY: '' }).apiKey).toBeUndefined()
  })

  it('resolves Kev locally without a credential', () => {
    expect(resolveProvider({ provider: 'kev' }, emptyEnv)).toEqual({
      provider: 'kev',
      baseUrl: 'http://127.0.0.1:8009/v1/systemone',
      model: 'kev-latest',
    })
  })

  it('lets explicit overrides win over the preset', () => {
    const resolved = resolveProvider(
      { provider: 'custom', baseUrl: 'https://jev.example/v1/systemone', model: 'custom-model', keyEnv: 'MY_KEY' },
      { MY_KEY: 'k' },
    )
    expect(resolved).toEqual({
      provider: 'custom',
      baseUrl: 'https://jev.example/v1/systemone',
      model: 'custom-model',
      apiKey: 'k',
    })
  })

  it('falls back to jev-latest when custom provides no model', () => {
    expect(resolveProvider({ provider: 'custom', baseUrl: 'https://x.example' }, emptyEnv).model).toBe('jev-latest')
  })

  it('rejects a custom provider without a base URL', () => {
    expect(() => resolveProvider({ provider: 'custom' }, emptyEnv)).toThrow(/needs an explicit baseUrl/)
  })
})

describe('redaction', () => {
  it('masks secret-shaped keys and truncates long strings', () => {
    const redacted = redactValue(
      { password: 'p', nested: { api_key: 'k', token: 't', keep: 'value' }, list: [{ secret: 's' }], long: 'abcdef' },
      3,
    )
    expect(redacted).toEqual({
      password: '***',
      nested: { api_key: '***', token: '***', keep: `val${TRUNCATION_MARKER}` },
      list: [{ secret: '***' }],
      long: `abc${TRUNCATION_MARKER}`,
    })
  })

  it('passes non-container primitives through unchanged', () => {
    expect(redactValue(7, 3)).toBe(7)
    expect(redactValue(null, 3)).toBeNull()
    expect(redactValue(true, 3)).toBe(true)
  })

  it('serializes undefined arguments as null and caps the total', () => {
    expect(redactArguments(undefined, 10)).toBe('null')
    expect(redactArguments({ a: 'x'.repeat(50) }, 5, 20)).toBe(`${JSON.stringify({ a: `xxxxx${TRUNCATION_MARKER}` }).slice(0, 20)}${TRUNCATION_MARKER}`)
  })

  it('builds a bounded state with and without a policy', () => {
    expect(buildState({ name: 'migrator_run_steps', arguments: { steps: ['a'] } })).toEqual({
      tool: 'migrator_run_steps',
      arguments: '{"steps":["a"]}',
    })
    expect(buildState({ name: 't', arguments: {}, policy: '' })).toEqual({ tool: 't', arguments: '{}' })
    expect(buildState({ name: 't', arguments: {}, policy: 'x'.repeat(1200) }).policy)
      .toBe(`${'x'.repeat(1000)}${TRUNCATION_MARKER}`)
    expect(buildState({ name: 't', arguments: {}, policy: 'allow' }, { maxArgChars: 2 }).policy).toBe('allow')
  })
})

describe('policy', () => {
  it('builds the base question set and adds policy_allows only with a policy', () => {
    expect(Object.keys(buildQuestions())).toEqual([
      'verdict', 'self_advocating', 'reads_secrets', 'sends_outbound', 'exfiltration', 'destructive', 'impact',
    ])
    expect(Object.keys(buildQuestions('   '))).not.toContain('policy_allows')
    expect(buildQuestions('routine backups are allowed').policy_allows?.type).toBe('noul')
  })

  it('denies credential exfiltration and sensitive boundary crossing', () => {
    expect(evaluate({ reads_secrets: { type: 'noul', noul: 0.8 }, sends_outbound: { type: 'noul', noul: 0.75 } })?.kind).toBe('deny')
    expect(evaluate({ exfiltration: { type: 'noul', noul: 0.9 } })?.kind).toBe('deny')
  })

  it('escalates persuasion, credentials, outbound, and severe destruction', () => {
    expect(evaluate({ self_advocating: { type: 'noul', noul: 0.9 } })?.kind).toBe('ask')
    expect(evaluate({ reads_secrets: { type: 'noul', noul: 0.9 } })?.kind).toBe('ask')
    expect(evaluate({ sends_outbound: { type: 'noul', noul: 0.9 } })?.kind).toBe('ask')
    expect(evaluate({ destructive: { type: 'noul', noul: 0.95 }, impact: { type: 'score', score: 2 } })?.kind).toBe('ask')
  })

  it('keeps the host decision when no rule fires', () => {
    expect(evaluate({})).toBeUndefined()
    expect(evaluate({ reads_secrets: { type: 'noul', noul: 0.1 }, destructive: { type: 'noul', noul: 0.1 } })).toBeUndefined()
    expect(evaluate({ destructive: { type: 'noul', noul: 0.95 } })).toBeUndefined()
    expect(evaluate({ verdict: { type: 'choice', choice: 'approve' } })).toBeUndefined()
  })

  it('escalates a model verdict of deny or escalate', () => {
    expect(evaluate({ verdict: { type: 'choice', choice: 'deny' } })?.kind).toBe('ask')
    expect(evaluate({ verdict: { type: 'choice', choice: 'escalate' } })?.kind).toBe('ask')
  })

  it('ignores mistyped answers and honors custom thresholds', () => {
    expect(evaluate({ reads_secrets: { type: 'score', score: 2 }, sends_outbound: { type: 'noul', noul: 0.1 } })).toBeUndefined()
    expect(evaluate({ impact: { type: 'noul', noul: 1 } })).toBeUndefined()
    expect(evaluate({ reads_secrets: { type: 'noul', noul: 0.5 } }, { ...DEFAULT_THRESHOLDS, secrets: 0.4 })?.kind).toBe('ask')
  })
})

describe('systemone client', () => {
  const state: GateState = { tool: 't', arguments: '{}' }
  const questions: QuestionMap = buildQuestions()

  const stubFetch = (impl: (input: string, init: RequestInit) => Promise<Response>): void => {
    vi.stubGlobal('fetch', vi.fn(impl))
  }

  afterEach(() => { vi.unstubAllGlobals() })

  it('returns typed answers with latency and request id', async () => {
    let tick = 0
    stubFetch(() => Promise.resolve(new Response(JSON.stringify({ answers: { ok: { type: 'noul', noul: 0.9 } } }),
      { status: 200, headers: { 'x-typesafe-request-id': 'req-1' } })))
    const result = await consultSystemOne(state, questions, {
      baseUrl: 'https://x', model: 'm', timeoutMs: 1000, now: () => (tick += 5),
    }, new AbortController().signal)
    expect(result.answers.ok).toEqual({ type: 'noul', noul: 0.9 })
    expect(result.latencyMs).toBe(5)
    expect(result.requestId).toBe('req-1')
  })

  it('falls back to x-request-id and tolerates its absence', async () => {
    stubFetch(() => Promise.resolve(new Response(JSON.stringify({ answers: {} }), { status: 200, headers: { 'x-request-id': 'r2' } })))
    const withFallback = await consultSystemOne(state, questions, { baseUrl: 'https://x', model: 'm', timeoutMs: 1000 }, new AbortController().signal)
    expect(withFallback.requestId).toBe('r2')
    stubFetch(() => Promise.resolve(new Response(JSON.stringify({ answers: {} }), { status: 200 })))
    const absent = await consultSystemOne(state, questions, { baseUrl: 'https://x', model: 'm', timeoutMs: 1000 }, new AbortController().signal)
    expect(absent.requestId).toBeUndefined()
  })

  it('retries once on 429 when Retry-After fits the budget', async () => {
    const sleeps: number[] = []
    let call = 0
    stubFetch(() => {
      call += 1
      return Promise.resolve(call === 1
        ? new Response('', { status: 429, headers: { 'retry-after': '0.5' } })
        : new Response(JSON.stringify({ answers: {} }), { status: 200 }))
    })
    const result = await consultSystemOne(state, questions, {
      baseUrl: 'https://x', model: 'm', timeoutMs: 1000,
      sleep: (ms) => { sleeps.push(ms); return Promise.resolve() },
    }, new AbortController().signal)
    expect(sleeps).toEqual([500])
    expect(result.answers).toEqual({})
    expect(call).toBe(2)
  })

  it('retries with the default delay when no sleep seam is injected', async () => {
    let call = 0
    stubFetch(() => {
      call += 1
      return Promise.resolve(call === 1
        ? new Response('', { status: 429, headers: { 'retry-after': '0' } })
        : new Response(JSON.stringify({ answers: {} }), { status: 200 }))
    })
    const result = await consultSystemOne(state, questions, { baseUrl: 'https://x', model: 'm', timeoutMs: 1000 }, new AbortController().signal)
    expect(result.answers).toEqual({})
    expect(call).toBe(2)
  })

  it('does not retry when Retry-After is too large or unparseable', async () => {
    stubFetch(() => Promise.resolve(new Response('', { status: 529, headers: { 'retry-after': '99' } })))
    const tooLarge = await consultSystemOne(state, questions, { baseUrl: 'https://x', model: 'm', timeoutMs: 1000 }, new AbortController().signal).catch((error: unknown) => error)
    expect(tooLarge).toBeInstanceOf(ConsultError)
    expect((tooLarge as ConsultError).status).toBe(529)

    stubFetch(() => Promise.resolve(new Response('', { status: 429 })))
    const garbage = await consultSystemOne(state, questions, { baseUrl: 'https://x', model: 'm', timeoutMs: 1000 }, new AbortController().signal).catch((error: unknown) => error)
    expect(garbage).toBeInstanceOf(ConsultError)
  })

  it('sends the bearer credential when configured', async () => {
    let sawAuth: string | undefined
    stubFetch((_input, init) => {
      sawAuth = (init.headers as Record<string, string>).authorization
      return Promise.resolve(new Response(JSON.stringify({ answers: {} }), { status: 200 }))
    })
    await consultSystemOne(state, questions, { baseUrl: 'https://x', model: 'm', apiKey: 'secret', timeoutMs: 1000 }, new AbortController().signal)
    expect(sawAuth).toBe('Bearer secret')
  })

  it('rejects non-2xx and malformed bodies', async () => {
    stubFetch(() => Promise.resolve(new Response('', { status: 500 })))
    const httpError = await consultSystemOne(state, questions, { baseUrl: 'https://x', model: 'm', timeoutMs: 1000 }, new AbortController().signal).catch((error: unknown) => error)
    expect(httpError).toBeInstanceOf(ConsultError)
    expect((httpError as ConsultError).status).toBe(500)
    expect((httpError as ConsultError).message).toMatch(/responded 500/)

    stubFetch(() => Promise.resolve(new Response('not json', { status: 200 })))
    const nonJson = await consultSystemOne(state, questions, { baseUrl: 'https://x', model: 'm', timeoutMs: 1000 }, new AbortController().signal).catch((error: unknown) => error)
    expect(nonJson).toBeInstanceOf(ConsultError)

    stubFetch(() => Promise.resolve(new Response(JSON.stringify({ answers: [] }), { status: 200 })))
    const noAnswers = await consultSystemOne(state, questions, { baseUrl: 'https://x', model: 'm', timeoutMs: 1000 }, new AbortController().signal).catch((error: unknown) => error)
    expect(noAnswers).toBeInstanceOf(ConsultError)
  })

  it('propagates transport failures', async () => {
    stubFetch(() => Promise.reject(new Error('ECONNREFUSED')))
    const failure = await consultSystemOne(state, questions, { baseUrl: 'https://x', model: 'm', timeoutMs: 1000 }, new AbortController().signal).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('ECONNREFUSED')
  })

  it('parses Retry-After in seconds, dates, and garbage', () => {
    expect(parseRetryAfter(null, 0)).toBeUndefined()
    expect(parseRetryAfter('2', 0)).toBe(2000)
    expect(parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT', Date.parse('Wed, 21 Oct 2015 07:27:00 GMT'))).toBe(60000)
    expect(parseRetryAfter('garbage', 0)).toBeUndefined()
  })
})

describe('decision log', () => {
  const dirs: string[] = []
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  })

  it('resolves explicit, DSH_HOME, and homedir paths', () => {
    expect(resolveLogPath({ logPath: '/tmp/x.log' }, emptyEnv)).toBe('/tmp/x.log')
    expect(resolveLogPath({}, { DSH_HOME: '/home/dsh' })).toBe('/home/dsh/logs/decision-consultant.log')
    expect(resolveLogPath({}, emptyEnv, '/home/me')).toBe('/home/me/.dsh/logs/decision-consultant.log')
  })

  it('appends JSONL and rotates at the size cap', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'decision-log-'))
    dirs.push(dir)
    const logPath = path.join(dir, 'nested', 'decisions.log')
    await appendDecision(logPath, { a: 1 })
    expect(await readFile(logPath, 'utf8')).toBe('{"a":1}\n')
    await appendDecision(logPath, { b: 2 }, 1)
    expect(await readFile(`${logPath}.1`, 'utf8')).toBe('{"a":1}\n')
    expect(await readFile(logPath, 'utf8')).toBe('{"b":2}\n')
  })

  it('skips rotation when disabled and while under the cap', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'decision-log-'))
    dirs.push(dir)
    const logPath = path.join(dir, 'decisions.log')
    await writeFile(logPath, 'existing\n', 'utf8')
    await appendDecision(logPath, { a: 1 }, 0)
    expect(await readFile(logPath, 'utf8')).toBe('existing\n{"a":1}\n')
    await appendDecision(logPath, { b: 2 }, 1000)
    expect(await readFile(logPath, 'utf8')).toBe('existing\n{"a":1}\n{"b":2}\n')
  })
})

interface Harness {
  readonly ctx: Context
  readonly handler: () => (exec: ToolExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>
}

function harness(): Harness {
  let captured: unknown
  const ctx = { on: (_event: string, handler: unknown) => { captured = handler; return () => {} } }
  return {
    ctx: ctx as unknown as Context,
    handler: () => captured as (exec: ToolExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>,
  }
}

function exec(name: string, args: unknown = {}): ToolExecution {
  return { name, arguments: args, signal: new AbortController().signal } as unknown as ToolExecution
}

const allow = async (): Promise<PreToolDecision> => ({ kind: 'allow' })

const answers = (entries: Record<string, { noul?: number; choice?: string; score?: number }>): AnswerMap => {
  const result: Record<string, AnswerMap[string]> = {}
  for (const [id, value] of Object.entries(entries)) {
    if (value.noul !== undefined) result[id] = { type: 'noul', noul: value.noul }
    else if (value.choice !== undefined) result[id] = { type: 'choice', choice: value.choice }
    else result[id] = { type: 'score', score: value.score ?? 0 }
  }
  return result
}

const consultAnswers = (value: AnswerMap): ((state: GateState, questions: QuestionMap, signal: AbortSignal) => Promise<ConsultResult>) =>
  () => Promise.resolve({ answers: value, latencyMs: 1 })

describe('plugin surface', () => {
  it('exports its loader identity and schema', () => {
    expect(name).toBe('decision-consultant')
    expect(inject).toEqual(['tools'])
    expect(Config({})).toMatchObject({ mode: 'shadow', provider: 'opencode-zen', tools: [...MIGRATOR_WRITE_TOOLS] })
  })

  it('installs nothing when disabled', () => {
    let installed = false
    const ctx = { on: () => { installed = true; return () => {} } } as unknown as Context
    apply(ctx, { mode: 'off' })
    expect(installed).toBe(false)
  })

  it('defaults to shadow mode when omitted', () => {
    const { ctx, handler } = harness()
    apply(ctx, {})
    expect(handler()).toBeTypeOf('function')
  })
})

describe('consultation gate', () => {
  it('ignores tools outside the configured set', async () => {
    const { ctx, handler } = harness()
    const consult = vi.fn(consultAnswers(answers({ exfiltration: { noul: 0.99 } })))
    installGate(ctx, { mode: 'enforce', tools: ['migrator_run_steps'] }, { consult, log: () => Promise.resolve() })
    const result = await handler()(exec('bash'), allow)
    expect(result).toEqual({ kind: 'allow' })
    expect(consult).not.toHaveBeenCalled()
  })

  it('in shadow mode returns the host decision and logs asynchronously', async () => {
    const { ctx, handler } = harness()
    const log = vi.fn<(logPath: string, record: Record<string, unknown>) => Promise<void>>(() => Promise.resolve())
    installGate(ctx, { mode: 'shadow', provider: 'kev', logPath: '/tmp/decisions.log' },
      { consult: consultAnswers(answers({})), log })
    const result = await handler()(exec('migrator_backup'), allow)
    expect(result).toEqual({ kind: 'allow' })
    await vi.waitFor(() => { expect(log).toHaveBeenCalledTimes(1) })
    expect(log.mock.calls[0]?.[0]).toBe('/tmp/decisions.log')
    expect(log.mock.calls[0]?.[1]).toMatchObject({ tool: 'migrator_backup', mode: 'shadow', provider: 'kev' })
  })

  it('enforce keeps the host decision when no rule fires', async () => {
    const { ctx, handler } = harness()
    installGate(ctx, {
      mode: 'enforce',
      provider: 'custom',
      baseUrl: 'https://x',
      model: 'm',
      keyEnv: 'MY_KEY',
      tools: ['migrator_run_steps'],
      timeoutMs: 100,
      failMode: 'open',
      policy: 'routine steps are allowed',
      logPath: '/tmp/decisions.log',
      maxArgChars: 50,
      selfAdvocatingThreshold: 0.5,
      secretsThreshold: 0.5,
      outboundThreshold: 0.5,
      exfiltrationThreshold: 0.5,
      destructiveThreshold: 0.5,
      impactThreshold: 1,
    }, { consult: consultAnswers(answers({})), log: () => Promise.resolve() })
    expect(await handler()(exec('migrator_run_steps', { steps: ['a'] }), allow)).toEqual({ kind: 'allow' })
  })

  it('enforce applies a deny hardening and keeps a stricter host deny/cancel', async () => {
    const denying = harness()
    installGate(denying.ctx, { mode: 'enforce', tools: ['migrator_copy_content'] },
      { consult: consultAnswers(answers({ exfiltration: { noul: 0.99 } })), log: () => Promise.resolve() })
    const denied = await denying.handler()(exec('migrator_copy_content'), allow)
    expect(denied.kind).toBe('deny')
    expect((denied as { reason: string }).reason).toMatch(/Decision consultant/)

    const canceling = harness()
    installGate(canceling.ctx, { mode: 'enforce', tools: ['migrator_copy_content'] },
      { consult: consultAnswers(answers({ exfiltration: { noul: 0.99 } })), log: () => Promise.resolve() })
    expect(await canceling.handler()(exec('migrator_copy_content'), async () => ({ kind: 'cancel' }))).toEqual({ kind: 'cancel' })

    const alreadyDenied = harness()
    installGate(alreadyDenied.ctx, { mode: 'enforce', tools: ['migrator_copy_content'] },
      { consult: consultAnswers(answers({ reads_secrets: { noul: 0.9 } })), log: () => Promise.resolve() })
    expect(await alreadyDenied.handler()(exec('migrator_copy_content'), async () => ({ kind: 'deny', reason: 'host' })))
      .toEqual({ kind: 'deny', reason: 'host' })
  })

  it('enforce escalates to ask over an allow', async () => {
    const { ctx, handler } = harness()
    installGate(ctx, { mode: 'enforce', tools: ['migrator_run_steps'] },
      { consult: consultAnswers(answers({ self_advocating: { noul: 0.9 } })), log: () => Promise.resolve() })
    const result = await handler()(exec('migrator_run_steps'), allow)
    expect(result.kind).toBe('ask')
    expect((result as { details: readonly string[] }).details[0]).toMatch(/inyeccion/)
  })

  it('fails open by default and can fail closed to ask', async () => {
    const open = harness()
    installGate(open.ctx, { mode: 'enforce', tools: ['migrator_run_steps'] },
      { consult: () => Promise.reject(new Error('timeout')), log: () => Promise.resolve() })
    expect(await open.handler()(exec('migrator_run_steps'), allow)).toEqual({ kind: 'allow' })

    const closed = harness()
    installGate(closed.ctx, { mode: 'enforce', failMode: 'closed-to-ask', tools: ['migrator_run_steps'] },
      { consult: () => Promise.reject(new Error('timeout')), log: () => Promise.resolve() })
    const escalated = await closed.handler()(exec('migrator_run_steps'), allow)
    expect(escalated.kind).toBe('ask')
    expect((escalated as { reason: string }).reason).toMatch(/no disponible/)

    const closedDenied = harness()
    installGate(closedDenied.ctx, { mode: 'enforce', failMode: 'closed-to-ask', tools: ['migrator_run_steps'] },
      { consult: () => Promise.reject(new Error('boom')), log: () => Promise.resolve() })
    expect(await closedDenied.handler()(exec('migrator_run_steps'), async () => ({ kind: 'deny', reason: 'host' })))
      .toEqual({ kind: 'deny', reason: 'host' })
  })

  it('contains logging failures', async () => {
    const { ctx, handler } = harness()
    installGate(ctx, { mode: 'enforce', tools: ['migrator_run_steps'] },
      { consult: consultAnswers(answers({})), log: () => Promise.reject(new Error('disk full')) })
    expect(await handler()(exec('migrator_run_steps'), allow)).toEqual({ kind: 'allow' })
  })

  it('uses the real transport and credential when no consult seam is injected', async () => {
    const stub = vi.fn<(input: string, init: RequestInit) => Promise<Response>>(
      () => Promise.resolve(new Response(JSON.stringify({ answers: {} }), { status: 200 })),
    )
    vi.stubGlobal('fetch', stub)
    process.env.DECISION_TEST_KEY = 'k'
    try {
      const { ctx, handler } = harness()
      installGate(ctx, {
        mode: 'enforce',
        provider: 'custom',
        baseUrl: 'https://x',
        model: 'm',
        keyEnv: 'DECISION_TEST_KEY',
        tools: ['migrator_run_steps'],
      }, { log: () => Promise.resolve() })
      expect(await handler()(exec('migrator_run_steps'), allow)).toEqual({ kind: 'allow' })
      expect(stub).toHaveBeenCalledTimes(1)
      expect(stub.mock.calls[0]?.[1].headers).toMatchObject({ authorization: 'Bearer k' })
    } finally {
      vi.unstubAllGlobals()
      delete process.env.DECISION_TEST_KEY
    }
  })

  it('uses the default sink and transport when no seams are injected', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'decision-gate-'))
    const stub = vi.fn<(input: string, init: RequestInit) => Promise<Response>>(
      () => Promise.resolve(new Response(JSON.stringify({ answers: {} }), { status: 200 })),
    )
    vi.stubGlobal('fetch', stub)
    try {
      const { ctx, handler } = harness()
      installGate(ctx, { mode: 'enforce', tools: ['migrator_run_steps'], logPath: path.join(dir, 'decisions.log') })
      expect(await handler()(exec('migrator_run_steps'), allow)).toEqual({ kind: 'allow' })
      expect(stub).toHaveBeenCalledTimes(1)
      const lines = (await readFile(path.join(dir, 'decisions.log'), 'utf8')).trim().split('\n')
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0]!)).toMatchObject({ tool: 'migrator_run_steps', mode: 'enforce' })
    } finally {
      vi.unstubAllGlobals()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('normalizes non-Error provider failures', async () => {
    const { ctx, handler } = harness()
    const weird = { toString: () => 'weird-failure' } as unknown as Error
    installGate(ctx, { mode: 'enforce', tools: ['migrator_run_steps'] },
      { consult: () => Promise.reject(weird), log: () => Promise.resolve() })
    expect(await handler()(exec('migrator_run_steps'), allow)).toEqual({ kind: 'allow' })
  })
})
