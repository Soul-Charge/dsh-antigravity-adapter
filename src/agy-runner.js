// SPDX-License-Identifier: MIT
// Subprocess runner for Antigravity CLI (`agy`) in headless stream-json mode.

import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStreamParser } from './ndjson-parser.js'

const MAX_STDERR_BYTES = 16 * 1024
const MAX_DIAGNOSTIC_BYTES = 4096
const DEFAULT_KILL_GRACE_MS = 2000
const HEALTH_CHECK_TIMEOUT_MS = 5000

const ALLOWED_MODES = new Set(['accept-edits', 'auto', 'plan'])
const ALLOWED_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

const READONLY_SETTINGS = Object.freeze({
  agentMode: '',
  toolPermission: 'request-review',
  permissions: {
    deny: ['write_file(*)', 'command(*)']
  }
})

/**
 * Redact common credentials, tokens, cookies, and env secrets from diagnostics,
 * and cap the output to maxBytes UTF-8 bytes.
 *
 * @param {string} raw
 * @param {number} [maxBytes]
 * @returns {string}
 */
export function sanitizeDiagnostic(raw, maxBytes = MAX_DIAGNOSTIC_BYTES) {
  if (typeof raw !== 'string' || !raw) return ''
  let clean = raw
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/(Authorization|Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi, '$1: [REDACTED]')
    .replace(/\b(AIza[0-9A-Za-z_-]{20,}|sk-[0-9A-Za-z_-]{16,}|gh[pousr]_[0-9A-Za-z]{20,}|xox[baprs]-[0-9A-Za-z-]{16,})\b/g, '[REDACTED_SECRET]')
    .replace(/\b([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE)[A-Z0-9_]*)\s*=\s*([^\s"'`]+)/gi, '$1=[REDACTED]')

  const buf = Buffer.from(clean, 'utf8')
  if (buf.length <= maxBytes) return clean
  const suffix = ' [...truncated]'
  const limit = Math.max(0, maxBytes - Buffer.byteLength(suffix, 'utf8'))
  return buf.subarray(0, limit).toString('utf8') + suffix
}

/**
 * Format structured diagnostic containing the 5 observability fields
 * (operation, target, input_summary, error_code, context).
 *
 * @param {{ operation: string, target: string, inputSummary: string, errorCode: string, context?: Record<string, unknown> }} fields
 * @returns {string}
 */
export function formatDiagnostic(fields) {
  const payload = {
    operation: fields.operation,
    target: fields.target,
    input_summary: fields.inputSummary,
    error_code: fields.errorCode,
    context: fields.context || {}
  }
  return sanitizeDiagnostic(JSON.stringify(payload), MAX_DIAGNOSTIC_BYTES)
}

function findInPath(exeName, envPath) {
  if (!envPath) return null
  const sep = process.platform === 'win32' ? ';' : ':'
  const dirs = envPath.split(sep).map((d) => d.trim()).filter(Boolean)
  const candidates = process.platform === 'win32'
    ? (/\.(exe|cmd|bat)$/i.test(exeName) ? [exeName] : [`${exeName}.exe`, exeName])
    : [exeName]

  for (const dir of dirs) {
    for (const candidate of candidates) {
      const full = path.join(dir, candidate)
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) return full
      } catch {
        // Ignore unreadable PATH entries.
      }
    }
  }
  return null
}

/**
 * Resolve agy executable path. When configured as default 'agy' on Windows and
 * not yet present in the active process PATH, falls back to %LOCALAPPDATA%/agy/bin/agy.exe
 * if installed there.
 *
 * @param {string} configuredPath
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ command: string, argsPrefix: string[], displayTarget: string }}
 */
export function resolveAgyBinary(configuredPath, env = process.env) {
  const trimmed = typeof configuredPath === 'string' && configuredPath.trim() ? configuredPath.trim() : 'agy'

  // Support Node script stubs (.mjs/.js) cleanly without shell:true (for fake-agy tests).
  if (/\.(m?js|cjs)$/i.test(trimmed)) {
    return {
      command: process.execPath,
      argsPrefix: [trimmed],
      displayTarget: trimmed
    }
  }

  const isBareDefault = trimmed === 'agy' || trimmed === 'agy.exe'
  if (isBareDefault) {
    const onPath = findInPath(trimmed, env.PATH || env.Path || '')
    if (onPath) {
      return { command: onPath, argsPrefix: [], displayTarget: onPath }
    }
    if (process.platform === 'win32' && env.LOCALAPPDATA) {
      const fallback = path.join(env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe')
      try {
        if (fs.existsSync(fallback) && fs.statSync(fallback).isFile()) {
          return { command: fallback, argsPrefix: [], displayTarget: fallback }
        }
      } catch {
        // Fall through to bare command name.
      }
    }
  }

  return { command: trimmed, argsPrefix: [], displayTarget: trimmed }
}

function normalizeAddDirs(rawDirs) {
  if (!Array.isArray(rawDirs)) return []
  const result = []
  for (const item of rawDirs) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (!trimmed) continue
    result.push(path.resolve(trimmed))
  }
  return result
}

/**
 * Build agy CLI argument list from validated request + live plugin config.
 * Always uses `--input-format stream-json --output-format stream-json` so prompts
 * travel over stdin without hitting Windows' 32,767-char CreateProcess limit.
 *
 * @param {object} opts
 * @returns {string[]}
 */
export function buildAgyArgs(opts) {
  const argv = [
    '--input-format', 'stream-json',
    '--output-format', 'stream-json'
  ]

  const backendOptions = opts.backendOptions && typeof opts.backendOptions === 'object'
    ? opts.backendOptions
    : {}

  if (opts.externalSessionId) {
    argv.push('--conversation', opts.externalSessionId)
  }

  const effectiveModel = (typeof opts.model === 'string' && opts.model.trim())
    || (typeof opts.defaultModel === 'string' && opts.defaultModel.trim())
    || ''
  if (effectiveModel) {
    argv.push('--model', effectiveModel)
  }

  const effort = typeof opts.reasoningEffort === 'string' ? opts.reasoningEffort.trim().toLowerCase() : ''
  if (effort && ALLOWED_EFFORTS.has(effort)) {
    argv.push('--effort', effort)
  }

  let effectiveMode = ''

  if (opts.readonly) {
    // Process-level hard readonly enforcement verified in Probe A3f.
    // Never pass --dangerously-skip-permissions or write-allowing modes here.
    argv.push('--settings', JSON.stringify(READONLY_SETTINGS))

    const requestedReadonlyMode =
      (typeof backendOptions.mode === 'string' ? backendOptions.mode.trim().toLowerCase() : '') ||
      (typeof backendOptions.approvalMode === 'string' ? backendOptions.approvalMode.trim().toLowerCase() : '') ||
      (typeof opts.readonlyApprovalMode === 'string' ? opts.readonlyApprovalMode.trim().toLowerCase() : '')

    if (requestedReadonlyMode === 'plan') {
      effectiveMode = 'plan'
      argv.push('--mode', 'plan')
    }
  } else {
    const rawMode =
      (typeof backendOptions.mode === 'string' ? backendOptions.mode.trim().toLowerCase() : '') ||
      (typeof backendOptions.approvalMode === 'string' ? backendOptions.approvalMode.trim().toLowerCase() : '') ||
      (typeof opts.defaultApprovalMode === 'string' ? opts.defaultApprovalMode.trim().toLowerCase() : '')

    if (ALLOWED_MODES.has(rawMode)) {
      effectiveMode = rawMode
      argv.push('--mode', rawMode)
    } else if (rawMode === 'always-proceed' || rawMode === 'dangerously-skip-permissions') {
      argv.push('--dangerously-skip-permissions')
    }

    if (backendOptions.dangerouslySkipPermissions === true && !argv.includes('--dangerously-skip-permissions')) {
      argv.push('--dangerously-skip-permissions')
    }
    if (backendOptions.sandbox === true) {
      argv.push('--sandbox')
    }
    if (backendOptions.settings !== undefined && backendOptions.settings !== null) {
      const settingsArg = typeof backendOptions.settings === 'string'
        ? backendOptions.settings.trim()
        : JSON.stringify(backendOptions.settings)
      if (settingsArg) argv.push('--settings', settingsArg)
    }
  }

  // Probe A1 finding: `--mode plan` has no effect if `--disable-slash-commands` is also passed.
  const disableSlash = opts.disableSlashCommands !== false
  if (disableSlash && effectiveMode !== 'plan') {
    argv.push('--disable-slash-commands')
  }

  for (const dir of normalizeAddDirs(backendOptions.addDirs)) {
    argv.push('--add-dir', dir)
  }

  const timeoutSec = Math.max(1, Math.ceil((opts.timeoutMs || 300000) / 1000))
  argv.push('--print-timeout', `${timeoutSec}s`)

  if (opts.schemaFilePath) {
    argv.push('--json-schema', opts.schemaFilePath)
  }

  return argv
}

/**
 * Write JSON schema to a short-lived file under `<cwd>/temp/` (falling back to os.tmpdir()).
 *
 * @param {Record<string, unknown>} schema
 * @param {string} cwd
 * @returns {Promise<string>}
 */
async function writeTempSchemaFile(schema, cwd) {
  const filename = `agy-schema-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.json`
  const payload = JSON.stringify(schema)
  const preferredDir = path.join(cwd, 'temp')

  try {
    await fs.promises.mkdir(preferredDir, { recursive: true })
    const filePath = path.join(preferredDir, filename)
    await fs.promises.writeFile(filePath, payload, 'utf8')
    return filePath
  } catch {
    const fallbackDir = path.join(os.tmpdir(), 'dsh-antigravity-adapter')
    await fs.promises.mkdir(fallbackDir, { recursive: true })
    const filePath = path.join(fallbackDir, filename)
    await fs.promises.writeFile(filePath, payload, 'utf8')
    return filePath
  }
}

async function cleanupTempFile(filePath) {
  if (!filePath) return
  try {
    await fs.promises.unlink(filePath)
  } catch {
    // Ignore cleanup errors for already-removed ephemeral files.
  }
}

/**
 * Terminate a single spawned child process tree by exact PID (never by process name).
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} graceMs
 * @returns {() => void} cleanup function to cancel pending force-kill timer
 */
function terminateProcessTree(child, graceMs = DEFAULT_KILL_GRACE_MS) {
  if (!child || child.exitCode !== null || child.killed) return () => {}

  try {
    child.kill('SIGTERM')
  } catch {
    // Process may have already exited.
  }

  const pid = child.pid
  if (!pid) return () => {}

  const timer = setTimeout(() => {
    if (child.exitCode !== null) return
    if (process.platform === 'win32') {
      try {
        const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
          shell: false,
          windowsHide: true,
          stdio: 'ignore'
        })
        killer.on('error', () => {})
      } catch {
        // Ignore taskkill errors if process already exited.
      }
    } else {
      try {
        child.kill('SIGKILL')
      } catch {
        // Ignore if already exited.
      }
    }
  }, Math.max(50, graceMs))

  if (typeof timer.unref === 'function') timer.unref()
  return () => clearTimeout(timer)
}

/**
 * Append chunk to a bounded stderr ring buffer (keeps the latest MAX_STDERR_BYTES).
 */
function createStderrCollector(maxBytes = MAX_STDERR_BYTES) {
  let buf = Buffer.alloc(0)
  let truncated = false

  return {
    append(chunk) {
      if (!chunk) return
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
      const combined = Buffer.concat([buf, next])
      if (combined.length > maxBytes) {
        buf = combined.subarray(combined.length - maxBytes)
        truncated = true
      } else {
        buf = combined
      }
    },
    toString() {
      if (buf.length === 0) return ''
      const body = buf.toString('utf8').trim()
      return truncated ? `[...stderr truncated...] ${body}` : body
    }
  }
}

/**
 * Execute one agy headless turn via stream-json stdin/stdout.
 *
 * @param {object} opts
 * @returns {Promise<{
 *   stopReason: 'completed' | 'aborted' | 'error' | 'timeout',
 *   conversationId?: string,
 *   text: string,
 *   structured?: unknown,
 *   usage?: Record<string, number>,
 *   durationMs: number,
 *   diagnostic?: string
 * }>}
 */
export async function runAgyTurn(opts) {
  const now = typeof opts.now === 'function' ? opts.now : Date.now
  const startedAt = now()
  const signal = opts.signal
  const timeoutMs = typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
    ? opts.timeoutMs
    : 300000
  const killGraceMs = typeof opts.killGraceMs === 'number' && Number.isFinite(opts.killGraceMs) && opts.killGraceMs > 0
    ? opts.killGraceMs
    : DEFAULT_KILL_GRACE_MS

  const resolved = resolveAgyBinary(opts.agyPath, opts.env || process.env)
  const inputSummary = `role=${opts.role || 'unknown'} readonly=${Boolean(opts.readonly)} promptChars=${opts.prompt.length} resume=${Boolean(opts.externalSessionId)}`

  if (signal && signal.aborted) {
    return {
      stopReason: 'aborted',
      text: '',
      durationMs: Math.max(0, now() - startedAt),
      diagnostic: formatDiagnostic({
        operation: 'agy.run',
        target: resolved.displayTarget,
        inputSummary,
        errorCode: 'ABORTED_BEFORE_START',
        context: { reason: 'signal already aborted' }
      })
    }
  }

  let schemaFilePath = null
  if (opts.outputSchema) {
    try {
      schemaFilePath = await writeTempSchemaFile(opts.outputSchema, opts.cwd)
    } catch (err) {
      return {
        stopReason: 'error',
        text: '',
        durationMs: Math.max(0, now() - startedAt),
        diagnostic: formatDiagnostic({
          operation: 'agy.writeSchema',
          target: opts.cwd,
          inputSummary,
          errorCode: err && err.code ? String(err.code) : 'SCHEMA_WRITE_FAILED',
          context: { message: err && err.message ? err.message : String(err) }
        })
      }
    }
  }

  const argv = [
    ...resolved.argsPrefix,
    ...buildAgyArgs({
      ...opts,
      timeoutMs,
      schemaFilePath
    })
  ]

  const parser = createStreamParser({ onProgress: opts.onProgress })
  const stderrCollector = createStderrCollector(MAX_STDERR_BYTES)

  try {
    return await new Promise((resolve) => {
      let settled = false
      let terminationReason = null
      let cancelForceKill = () => {}

      const child = spawn(resolved.command, argv, {
        cwd: opts.cwd,
        shell: false,
        windowsHide: true,
        env: opts.env || process.env,
        stdio: ['pipe', 'pipe', 'pipe']
      })

      const cleanupListeners = () => {
        clearTimeout(timeoutTimer)
        cancelForceKill()
        if (signal && typeof signal.removeEventListener === 'function') {
          signal.removeEventListener('abort', onAbort)
        }
      }

      const finish = (outcome) => {
        if (settled) return
        settled = true
        cleanupListeners()
        resolve(outcome)
      }

      const triggerStop = (reason) => {
        if (terminationReason) return
        terminationReason = reason
        cancelForceKill = terminateProcessTree(child, killGraceMs)
      }

      const onAbort = () => triggerStop('aborted')
      if (signal && typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', onAbort, { once: true })
      }

      const timeoutTimer = setTimeout(() => {
        triggerStop('timeout')
      }, timeoutMs)
      if (typeof timeoutTimer.unref === 'function') timeoutTimer.unref()

      child.stdout.on('data', (chunk) => {
        parser.feed(chunk)
      })

      child.stderr.on('data', (chunk) => {
        stderrCollector.append(chunk)
      })

      child.stdin.on('error', () => {
        // Ignore EPIPE when child exits before consuming stdin.
      })

      child.on('error', (err) => {
        parser.flush()
        const summary = parser.getSummary()
        finish({
          stopReason: terminationReason || 'error',
          ...(summary.conversationId ? { conversationId: summary.conversationId } : {}),
          text: summary.text,
          ...(summary.usage ? { usage: summary.usage } : {}),
          durationMs: Math.max(0, now() - startedAt),
          diagnostic: formatDiagnostic({
            operation: 'agy.spawn',
            target: resolved.displayTarget,
            inputSummary,
            errorCode: err && err.code ? String(err.code) : 'SPAWN_ERROR',
            context: {
              message: err && err.message ? err.message : String(err),
              stderr: stderrCollector.toString()
            }
          })
        })
      })

      child.on('close', (code, exitSignal) => {
        parser.flush()
        const summary = parser.getSummary()
        const durationMs = Math.max(0, now() - startedAt)
        const stderrText = stderrCollector.toString()

        if (terminationReason === 'aborted') {
          finish({
            stopReason: 'aborted',
            ...(summary.conversationId ? { conversationId: summary.conversationId } : {}),
            text: summary.text,
            ...(summary.usage ? { usage: summary.usage } : {}),
            durationMs,
            diagnostic: formatDiagnostic({
              operation: 'agy.run',
              target: resolved.displayTarget,
              inputSummary,
              errorCode: 'ABORTED',
              context: { exitCode: code, exitSignal, stderr: stderrText }
            })
          })
          return
        }

        if (terminationReason === 'timeout') {
          finish({
            stopReason: 'timeout',
            ...(summary.conversationId ? { conversationId: summary.conversationId } : {}),
            text: summary.text,
            ...(summary.usage ? { usage: summary.usage } : {}),
            durationMs,
            diagnostic: formatDiagnostic({
              operation: 'agy.run',
              target: resolved.displayTarget,
              inputSummary,
              errorCode: 'TIMEOUT',
              context: { timeoutMs, exitCode: code, exitSignal, stderr: stderrText }
            })
          })
          return
        }

        if (summary.status === 'CANCELED' || summary.status === 'INTERRUPTED') {
          finish({
            stopReason: 'aborted',
            ...(summary.conversationId ? { conversationId: summary.conversationId } : {}),
            text: summary.text,
            ...(summary.usage ? { usage: summary.usage } : {}),
            durationMs,
            diagnostic: formatDiagnostic({
              operation: 'agy.run',
              target: resolved.displayTarget,
              inputSummary,
              errorCode: `AGY_${summary.status}`,
              context: { exitCode: code, error: summary.error, stderr: stderrText }
            })
          })
          return
        }

        const isSuccess = code === 0 && (!summary.status || summary.status === 'SUCCESS')
        if (!isSuccess) {
          finish({
            stopReason: 'error',
            ...(summary.conversationId ? { conversationId: summary.conversationId } : {}),
            text: summary.text,
            ...(summary.structured !== undefined ? { structured: summary.structured } : {}),
            ...(summary.usage ? { usage: summary.usage } : {}),
            durationMs,
            diagnostic: formatDiagnostic({
              operation: 'agy.run',
              target: resolved.displayTarget,
              inputSummary,
              errorCode: summary.status && summary.status !== 'SUCCESS'
                ? `AGY_${summary.status}`
                : `EXIT_${code ?? 'NULL'}`,
              context: {
                exitCode: code,
                exitSignal,
                agyError: summary.error,
                finishedReason: summary.finishedReason,
                stderr: stderrText,
                malformedLines: summary.malformedLines.length
              }
            })
          })
          return
        }

        finish({
          stopReason: 'completed',
          ...(summary.conversationId ? { conversationId: summary.conversationId } : {}),
          text: summary.text,
          ...(summary.structured !== undefined ? { structured: summary.structured } : {}),
          ...(summary.usage ? { usage: summary.usage } : {}),
          durationMs
        })
      })

      // Feed prompt via stream-json stdin and close stdin so agy executes exactly one turn.
      const inputEvent = JSON.stringify({
        event: 'user',
        message: { content: opts.prompt }
      }) + '\n'

      try {
        child.stdin.write(inputEvent, 'utf8')
        child.stdin.end()
      } catch {
        // Error listener on stdin / close handler will report failure cleanly.
      }
    })
  } finally {
    await cleanupTempFile(schemaFilePath)
  }
}

/**
 * Health check: verify agy binary is reachable and returns a version string.
 *
 * @param {string} configuredPath
 * @param {{ timeoutMs?: number, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<{ ok: boolean, version?: string, detail?: string }>}
 */
export async function checkAgyHealth(configuredPath, options = {}) {
  const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0
    ? options.timeoutMs
    : HEALTH_CHECK_TIMEOUT_MS
  const resolved = resolveAgyBinary(configuredPath, options.env || process.env)

  return new Promise((resolve) => {
    let settled = false
    let stdout = ''
    const stderrCollector = createStderrCollector(4096)

    const child = spawn(resolved.command, [...resolved.argsPrefix, '--version'], {
      shell: false,
      windowsHide: true,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const finish = (res) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(res)
    }

    const timer = setTimeout(() => {
      terminateProcessTree(child, 500)
      finish({
        ok: false,
        detail: sanitizeDiagnostic(`agy --version timed out after ${timeoutMs}ms (${resolved.displayTarget})`)
      })
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()

    child.stdout.on('data', (chunk) => {
      if (stdout.length < 1024) stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      stderrCollector.append(chunk)
    })

    child.on('error', (err) => {
      finish({
        ok: false,
        detail: sanitizeDiagnostic(`${err && err.code ? err.code + ': ' : ''}${err && err.message ? err.message : String(err)}`)
      })
    })

    child.on('close', (code) => {
      const version = stdout.trim().split(/\r?\n/)[0]?.trim() || ''
      if (code === 0 && version) {
        finish({
          ok: true,
          version,
          detail: resolved.displayTarget
        })
      } else {
        finish({
          ok: false,
          detail: sanitizeDiagnostic(stderrCollector.toString() || `agy --version exited with code ${code}`)
        })
      }
    })
  })
}
