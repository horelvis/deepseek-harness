/**
 * Append-only JSONL decision log. One line per consultation lets thresholds be
 * re-tuned against real traffic. Logging never changes approval behavior.
 *
 * @module @deepseek-ai/dsh-experimental-decision-consultant
 */

import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** Default log size cap before one-generation rotation. */
export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024

/**
 * Resolve the decision log path.
 * @param config - explicit `logPath` override.
 * @param env - environment source for `DSH_HOME`.
 * @param homedir - fallback home directory.
 * @returns the log file path.
 */
export function resolveLogPath(
  config: { readonly logPath?: string },
  env: NodeJS.ProcessEnv = process.env,
  homedir: string = os.homedir(),
): string {
  if (config.logPath !== undefined && config.logPath.length > 0) return config.logPath
  const home = env.DSH_HOME !== undefined && env.DSH_HOME.length > 0 ? env.DSH_HOME : path.join(homedir, '.dsh')
  return path.join(home, 'logs', 'decision-consultant.log')
}

/**
 * Append one decision record, rotating at the size cap.
 * @param logPath - destination file.
 * @param record - JSON-serializable decision record.
 * @param maxBytes - rotate once the file reaches this size; `0` disables rotation.
 */
export async function appendDecision(
  logPath: string,
  record: Record<string, unknown>,
  maxBytes: number = DEFAULT_MAX_BYTES,
): Promise<void> {
  await mkdir(path.dirname(logPath), { recursive: true })
  if (maxBytes > 0) {
    try {
      const info = await stat(logPath)
      if (info.size >= maxBytes) await rename(logPath, `${logPath}.1`)
    } catch {
      // No existing log, or a concurrent rotation won the rename: append below.
    }
  }
  await appendFile(logPath, `${JSON.stringify(record)}\n`, 'utf8')
}
