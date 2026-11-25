// SPDX-License-Identifier: MIT
// Cordis plugin entry for dsh-antigravity-adapter.
//
// IMPORTANT (DSH cordis-plugin-loader invariant):
// NEVER add `export default` here — cordis-plugin-loader evaluates
// `exports = exports.default ?? exports`, which would hide `Config` and `inject`.

import z from '@deepseek-ai/schemastery'
import { createAntigravityAdapter, EXTERNAL_BACKEND_CONTRACT_VERSION } from './adapter.js'
import { registerStandaloneTool } from './standalone-tool.js'

export const name = 'antigravity-adapter'
// Keep static inject empty so loading NEVER stalls in PENDING when tieredWorkflow or tools is absent.
export const inject = []

export const Config = z.object({
  agyPath: z.string().default('agy').volatile(),
  defaultTimeoutMs: z.number().default(300000).volatile(),
  defaultApprovalMode: z.string().default('').volatile(),
  readonlyApprovalMode: z.string().default('').volatile(),
  defaultModel: z.string().default('').volatile(),
  disableSlashCommands: z.boolean().default(true).volatile(),
  registerStandaloneTool: z.boolean().default(false).volatile(),
  debugLog: z.string().default('')
})

function isRef(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function'
}

function unwrap(value) {
  return isRef(value) ? unwrap(value.get()) : value
}

function asString(value, fallback = '') {
  const v = unwrap(value)
  return typeof v === 'string' ? v : fallback
}

function asPositiveNumber(value, fallback) {
  const v = unwrap(value)
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback
}

function asBoolean(value, fallback) {
  const v = unwrap(value)
  return typeof v === 'boolean' ? v : fallback
}

export function readConfig(config) {
  const c = config && typeof config === 'object' ? config : {}
  return {
    agyPath: asString(c.agyPath, 'agy').trim() || 'agy',
    defaultTimeoutMs: asPositiveNumber(c.defaultTimeoutMs, 300000),
    defaultApprovalMode: asString(c.defaultApprovalMode, '').trim(),
    readonlyApprovalMode: asString(c.readonlyApprovalMode, '').trim(),
    defaultModel: asString(c.defaultModel, '').trim(),
    disableSlashCommands: asBoolean(c.disableSlashCommands, true),
    registerStandaloneTool: asBoolean(c.registerStandaloneTool, false),
    debugLog: asString(c.debugLog, '').trim()
  }
}

function bindCleanup(scopeCtx, dispose) {
  if (typeof dispose !== 'function') return
  let cleaned = false
  const runOnce = () => {
    if (cleaned) return
    cleaned = true
    try {
      dispose()
    } catch {
      // Ignore disposer errors during teardown.
    }
  }
  // @deepseek-ai/cordis v4 executes teardown callbacks registered via ctx.effect().
  if (typeof scopeCtx.effect === 'function') {
    scopeCtx.effect(() => runOnce)
  } else if (typeof scopeCtx.on === 'function') {
    scopeCtx.on('dispose', runOnce)
  }
}

export function apply(ctx, config) {
  const getConfig = () => readConfig(config)
  const adapter = createAntigravityAdapter(getConfig)

  // Soft-dependency registration onto dsh-tiered-workflow (`tieredWorkflow` root service).
  ctx.inject(['tieredWorkflow'], (inner) => {
    const svc = inner.tieredWorkflow
    if (!svc || typeof svc.registerBackend !== 'function') return
    const dispose = svc.registerBackend(adapter)
    bindCleanup(inner, dispose)
  })

  // Optional standalone tool registration (`dispatch_antigravity`).
  ctx.inject(['tools'], (inner) => {
    if (!getConfig().registerStandaloneTool) return
    const dispose = registerStandaloneTool(inner, adapter, getConfig)
    bindCleanup(inner, dispose)
  })
}

export { createAntigravityAdapter, EXTERNAL_BACKEND_CONTRACT_VERSION }
