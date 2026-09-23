/**
 * System One provider presets: OpenCode Zen (Jev), Kev local, TypeSafe direct,
 * OpenRouter, or any custom Jev-compatible endpoint. The request contract is
 * identical across providers, so only the route and credential change.
 *
 * @module @deepseek-ai/dsh-experimental-decision-consultant
 */

/** Provider kinds understood by the preset table; `custom` requires a base URL. */
export type ProviderName = 'opencode-zen' | 'kev' | 'typesafe' | 'openrouter' | 'custom'

/** Resolved endpoint, model, and optional bearer credential. */
export interface ProviderConfig {
  readonly provider: ProviderName
  readonly baseUrl: string
  readonly model: string
  readonly apiKey?: string
}

interface Preset {
  readonly baseUrl: string
  readonly model: string
  readonly keyEnv?: string
}

/** Provider preset selected by default when the config omits one. */
export const DEFAULT_PROVIDER: ProviderName = 'opencode-zen'

const PRESETS: Readonly<Record<Exclude<ProviderName, 'custom'>, Preset>> = {
  'opencode-zen': {
    baseUrl: 'https://opencode.ai/zen/v1/systemone',
    model: 'jev-1.13-free',
    keyEnv: 'OPENCODE_API_KEY',
  },
  kev: { baseUrl: 'http://127.0.0.1:8009/v1/systemone', model: 'kev-latest' },
  typesafe: {
    baseUrl: 'https://api.typesafe.ai/v1/systemone',
    model: 'jev-latest',
    keyEnv: 'TYPESAFE_API_KEY',
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/alpha/decisions',
    model: 'typesafe/jev-1.13',
    keyEnv: 'OPENROUTER_API_KEY',
  },
}

/** Non-empty environment value, or `undefined`. */
function envValue(env: NodeJS.ProcessEnv, name: string | undefined): string | undefined {
  if (name === undefined) return undefined
  const value = env[name]
  return value !== undefined && value.length > 0 ? value : undefined
}

/**
 * Resolve the effective route from config overrides and environment credentials.
 * @param config - provider selector plus optional base URL, model, and key env name.
 * @param env - environment to read the credential from.
 * @returns the resolved endpoint and model.
 */
export function resolveProvider(
  config: {
    readonly provider?: ProviderName
    readonly baseUrl?: string
    readonly model?: string
    readonly keyEnv?: string
  },
  env: NodeJS.ProcessEnv = process.env,
): ProviderConfig {
  const provider = config.provider ?? DEFAULT_PROVIDER
  const preset = provider === 'custom' ? undefined : PRESETS[provider]
  const baseUrl = config.baseUrl ?? preset?.baseUrl
  if (baseUrl === undefined) {
    throw new Error(`decision-consultant: provider "${provider}" needs an explicit baseUrl`)
  }
  const keyEnv = config.keyEnv ?? preset?.keyEnv
  const apiKey = envValue(env, keyEnv)
  return {
    provider,
    baseUrl,
    model: config.model ?? preset?.model ?? 'jev-latest',
    ...(apiKey === undefined ? {} : { apiKey }),
  }
}
