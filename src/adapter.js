// SPDX-License-Identifier: MIT
// ExternalBackendAdapter v1 implementation backed by Antigravity CLI (`agy`).
// Contract specification: docs/CONTRACT.md

import fs from 'node:fs'
import path from 'node:path'
import { checkAgyHealth, runAgyTurn } from './agy-runner.js'

export const EXTERNAL_BACKEND_CONTRACT_VERSION = 1

const VALID_ROLES = new Set([
  'planner',
  'reviewer',
  'worker-low',
  'worker-medium',
  'handoff'
])

const READONLY_PREAMBLE = [
  '[只读约束] 本次调用为只读模式，禁止创建、修改、删除任何文件或执行写入型命令。',
  '请仅执行只读分析与检查，并将完整结论返回在答复中。'
].join('\n')

const HANDOFF_PREAMBLE = [
  '[来自 DSH 的任务交接包]',
  '你收到一份来自 DSH 的任务交接包。请先确认目标、读取列出的关键文件、给出简明接管确认与初步切入点，然后停下来等待用户在 Antigravity 中给出下一步指令，不要执行任何写文件或修改操作。'
].join('\n')

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function hasParentTraversal(rawPath) {
  const segments = rawPath.split(/[\\/]+/)
  return segments.includes('..')
}

function validateRequest(req) {
  if (!req || typeof req !== 'object') {
    throw new Error('antigravity-adapter: request must be a non-null object')
  }

  if (typeof req.role !== 'string' || !VALID_ROLES.has(req.role)) {
    throw new Error(`antigravity-adapter: invalid role ${JSON.stringify(req.role)}`)
  }

  if (typeof req.prompt !== 'string' || req.prompt.trim().length === 0) {
    throw new Error('antigravity-adapter: prompt must be a non-empty string')
  }

  if (typeof req.cwd !== 'string' || req.cwd.trim().length === 0) {
    throw new Error('antigravity-adapter: cwd must be a non-empty absolute path')
  }

  const trimmedCwd = req.cwd.trim()
  if (hasParentTraversal(trimmedCwd) || !path.isAbsolute(trimmedCwd)) {
    throw new Error(`antigravity-adapter: cwd must be an absolute path without ".." segments (received ${JSON.stringify(trimmedCwd)})`)
  }

  if (typeof req.readonly !== 'boolean') {
    throw new Error(`antigravity-adapter: readonly must be a boolean (received ${typeof req.readonly})`)
  }

  if (req.outputSchema !== undefined && !isPlainObject(req.outputSchema)) {
    throw new Error('antigravity-adapter: outputSchema must be a plain JSON Schema object')
  }

  let externalSessionId
  if (req.externalSessionId !== undefined && req.externalSessionId !== '') {
    if (typeof req.externalSessionId !== 'string') {
      throw new Error('antigravity-adapter: externalSessionId must be a string')
    }
    const cleaned = req.externalSessionId.trim()
    if (!cleaned || /[\s\r\n]/.test(cleaned) || cleaned.startsWith('-')) {
      throw new Error(`antigravity-adapter: invalid externalSessionId ${JSON.stringify(req.externalSessionId)}`)
    }
    externalSessionId = cleaned
  }

  if (req.signal !== undefined && (typeof req.signal !== 'object' || req.signal === null || typeof req.signal.aborted !== 'boolean')) {
    throw new Error('antigravity-adapter: signal must be an AbortSignal')
  }

  return {
    role: req.role,
    cwd: path.normalize(trimmedCwd),
    prompt: req.prompt,
    readonly: req.readonly,
    outputSchema: req.outputSchema,
    externalSessionId,
    model: typeof req.model === 'string' ? req.model.trim() : '',
    reasoningEffort: typeof req.reasoningEffort === 'string' ? req.reasoningEffort.trim() : '',
    timeoutMs: typeof req.timeoutMs === 'number' && Number.isFinite(req.timeoutMs) && req.timeoutMs > 0
      ? req.timeoutMs
      : undefined,
    backendOptions: isPlainObject(req.backendOptions) ? req.backendOptions : {},
    signal: req.signal || new AbortController().signal,
    onProgress: typeof req.onProgress === 'function' ? req.onProgress : undefined
  }
}

function buildEffectivePrompt(role, effectiveReadonly, prompt, isResume) {
  if (role === 'handoff') {
    if (isResume) return prompt
    return `${HANDOFF_PREAMBLE}\n\n${prompt}`
  }
  if (effectiveReadonly && !isResume) {
    return `${READONLY_PREAMBLE}\n\n${prompt}`
  }
  return prompt
}

function buildResumeHint(conversationId) {
  if (!conversationId) return undefined
  // Probe A4 verified agy CLI stores sessions under ~/.gemini/antigravity-cli separately
  // from Antigravity 2.0 desktop app, so resumeHint points honestly to the CLI command.
  return `agy --conversation ${conversationId}`
}

function tryParseStructuredFallback(text) {
  if (typeof text !== 'string') return undefined
  const trimmed = text.trim()
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

function appendDebugLog(logPath, record) {
  if (typeof logPath !== 'string' || !logPath.trim()) return
  try {
    const resolved = path.resolve(logPath.trim())
    fs.mkdirSync(path.dirname(resolved), { recursive: true })
    fs.appendFileSync(resolved, JSON.stringify(record) + '\n', 'utf8')
  } catch {
    // Debug log failures must never break adapter execution.
  }
}

/**
 * Create an ExternalBackendAdapter v1 instance.
 *
 * @param {() => {
 *   agyPath: string,
 *   defaultTimeoutMs: number,
 *   defaultApprovalMode: string,
 *   readonlyApprovalMode: string,
 *   defaultModel: string,
 *   disableSlashCommands: boolean,
 *   debugLog: string
 * }} getConfig
 * @param {{
 *   runTurn?: typeof runAgyTurn,
 *   checkHealth?: typeof checkAgyHealth,
 *   now?: () => number,
 *   killGraceMs?: number,
 *   env?: NodeJS.ProcessEnv
 * }} [deps]
 */
export function createAntigravityAdapter(getConfig, deps = {}) {
  const runTurn = deps.runTurn || runAgyTurn
  const checkHealth = deps.checkHealth || checkAgyHealth
  const now = typeof deps.now === 'function' ? deps.now : Date.now

  const capabilities = Object.freeze({
    readonlyMode: true,
    structuredOutput: true,
    continuation: true,
    handoff: true,
    usageReporting: true
  })

  return Object.freeze({
    contractVersion: EXTERNAL_BACKEND_CONTRACT_VERSION,
    id: 'antigravity',
    label: 'Antigravity (agy CLI)',
    capabilities,

    async healthCheck() {
      const cfg = getConfig()
      return checkHealth(cfg.agyPath, { env: deps.env })
    },

    async run(rawReq) {
      // Illegal call parameters throw synchronously/rejected per CONTRACT.md §3.1.
      const req = validateRequest(rawReq)
      const cfg = getConfig()

      // Handoff always enforces readonly so Antigravity prepares the session and waits for the user.
      const effectiveReadonly = req.role === 'handoff' ? true : req.readonly
      const effectivePrompt = buildEffectivePrompt(
        req.role,
        effectiveReadonly,
        req.prompt,
        Boolean(req.externalSessionId)
      )
      const effectiveTimeoutMs = req.timeoutMs ?? cfg.defaultTimeoutMs

      const outcome = await runTurn({
        agyPath: cfg.agyPath,
        cwd: req.cwd,
        role: req.role,
        prompt: effectivePrompt,
        readonly: effectiveReadonly,
        outputSchema: req.outputSchema,
        externalSessionId: req.externalSessionId,
        model: req.model,
        defaultModel: cfg.defaultModel,
        reasoningEffort: req.reasoningEffort,
        defaultApprovalMode: cfg.defaultApprovalMode,
        readonlyApprovalMode: cfg.readonlyApprovalMode,
        disableSlashCommands: cfg.disableSlashCommands,
        backendOptions: req.backendOptions,
        timeoutMs: effectiveTimeoutMs,
        signal: req.signal,
        onProgress: req.onProgress,
        now,
        killGraceMs: deps.killGraceMs,
        env: deps.env
      })

      const externalSessionId = outcome.conversationId || req.externalSessionId
      const resumeHint = buildResumeHint(externalSessionId)

      let structured = outcome.structured
      if (req.outputSchema && structured === undefined && outcome.stopReason === 'completed') {
        structured = tryParseStructuredFallback(outcome.text)
      }

      const result = {
        stopReason: outcome.stopReason,
        ...(externalSessionId ? { externalSessionId } : {}),
        ...(resumeHint ? { resumeHint } : {}),
        text: typeof outcome.text === 'string' ? outcome.text : '',
        ...(structured !== undefined ? { structured } : {}),
        ...(outcome.usage ? { usage: outcome.usage } : {}),
        durationMs: outcome.durationMs,
        ...(outcome.diagnostic ? { diagnostic: outcome.diagnostic } : {})
      }

      appendDebugLog(cfg.debugLog, {
        ts: new Date(now()).toISOString(),
        role: req.role,
        readonly: effectiveReadonly,
        resume: Boolean(req.externalSessionId),
        promptChars: req.prompt.length,
        stopReason: result.stopReason,
        externalSessionId: result.externalSessionId || '',
        hasStructured: result.structured !== undefined,
        usage: result.usage || null,
        durationMs: result.durationMs
      })

      return result
    }
  })
}
