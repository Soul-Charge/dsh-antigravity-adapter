// SPDX-License-Identifier: MIT
// Comprehensive M1 (unit + fake-agy E2E), M2 (Cordis integration), and optional M3 (--real) test suite.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createStreamParser, mapRawUsage } from '../src/ndjson-parser.js'
import { buildAgyArgs, checkAgyHealth, resolveAgyBinary, sanitizeDiagnostic } from '../src/agy-runner.js'
import { createAntigravityAdapter, EXTERNAL_BACKEND_CONTRACT_VERSION } from '../src/adapter.js'
import * as pluginModule from '../src/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const FAKE_AGY_PATH = path.join(__dirname, 'fake-agy.mjs')
const RUN_REAL = process.argv.includes('--real')

let passed = 0
let failed = 0

async function runTest(name, fn) {
  const t0 = Date.now()
  try {
    await fn()
    passed++
    console.log(`  PASS ${name} (${Date.now() - t0}ms)`)
  } catch (err) {
    failed++
    console.error(`  FAIL ${name} (${Date.now() - t0}ms)`)
    console.error('      ', err && err.stack ? err.stack : String(err))
  }
}

function makeFakeConfig(overrides = {}) {
  return {
    agyPath: FAKE_AGY_PATH,
    defaultTimeoutMs: 10000,
    defaultApprovalMode: '',
    readonlyApprovalMode: '',
    defaultModel: '',
    disableSlashCommands: true,
    registerStandaloneTool: false,
    debugLog: '',
    ...overrides
  }
}

// ── M1.1: Pure logic unit tests ───────────────────────────────────────────────

console.log('\n[M1.1] Pure logic unit tests')

await runTest('mapRawUsage omits missing fields and never fabricates 0', () => {
  const mapped = mapRawUsage({
    input_tokens: 2513,
    cache_read_tokens: 17747,
    output_tokens: 151,
    thinking_tokens: 126,
    total_tokens: 2664
  })
  assert.deepEqual(mapped, {
    inputTokens: 2513,
    cacheReadTokens: 17747,
    outputTokens: 151,
    reasoningTokens: 126,
    totalTokens: 2664
  })
  assert.equal('cacheWriteTokens' in mapped, false)
  assert.equal(mapRawUsage({}), undefined)
  assert.equal(mapRawUsage(null), undefined)
})

await runTest('createStreamParser handles split chunks, CRLF, malformed lines, and throwing onProgress', () => {
  const events = []
  const parser = createStreamParser({
    onProgress(ev) {
      events.push(ev)
      if (ev.kind === 'text-delta') throw new Error('consumer bug must not crash parser')
    }
  })

  const chunk1 = '{"event":"init","conversation_id":"c-1","init":{"permission_mode":"request-review"}}\r\nnot-json-noise\r\n{"event":"step_update","step_up'
  const chunk2 = 'date":{"conversation_id":"c-1","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"Hel"}}\r\n'
  const chunk3 = '{"event":"step_update","step_update":{"conversation_id":"c-1","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"lo","usage":{"input_tokens":10,"output_tokens":5,"thinking_tokens":2,"total_tokens":15}}}\n'
  const chunk4 = '{"event":"result","result":{"conversation_id":"c-1","status":"SUCCESS","response":"Hello","num_turns":1,"usage":{"input_tokens":10,"output_tokens":5,"thinking_tokens":2,"total_tokens":15}}}'

  parser.feed(chunk1)
  parser.feed(chunk2)
  parser.feed(chunk3)
  parser.feed(chunk4)
  parser.flush()

  const summary = parser.getSummary()
  assert.equal(summary.conversationId, 'c-1')
  assert.equal(summary.text, 'Hello')
  assert.equal(summary.status, 'SUCCESS')
  assert.deepEqual(summary.usage, {
    inputTokens: 10,
    outputTokens: 5,
    reasoningTokens: 2,
    totalTokens: 15
  })
  assert.equal(summary.malformedLines.length, 1)
  assert.equal(events.some((e) => e.kind === 'status' && e.text === 'init:request-review'), true)
  assert.equal(events.some((e) => e.kind === 'text-delta' && e.text === 'Hel'), true)
  assert.equal(events.some((e) => e.kind === 'usage'), true)
})

await runTest('createStreamParser sums multi-step usage per call and ignores cumulative result.usage on resume', () => {
  const parser = createStreamParser()
  parser.feed(JSON.stringify({
    event: 'step_update',
    step_update: {
      conversation_id: 'c-2',
      step_index: 5,
      state: 'DONE',
      step_type: 'agent_response',
      usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 900, total_tokens: 120 }
    }
  }) + '\n')
  parser.feed(JSON.stringify({
    event: 'step_update',
    step_update: {
      conversation_id: 'c-2',
      step_index: 7,
      state: 'DONE',
      step_type: 'agent_response',
      text_delta: 'Done',
      usage: { input_tokens: 50, output_tokens: 10, cache_read_tokens: 1000, total_tokens: 60 }
    }
  }) + '\n')
  parser.feed(JSON.stringify({
    event: 'result',
    result: {
      conversation_id: 'c-2',
      status: 'SUCCESS',
      response: 'Done',
      num_turns: 2,
      usage: { input_tokens: 99999, output_tokens: 99999, cache_read_tokens: 99999, total_tokens: 99999 }
    }
  }) + '\n')
  parser.flush()

  const summary = parser.getSummary()
  assert.deepEqual(summary.usage, {
    inputTokens: 150,
    cacheReadTokens: 1900,
    outputTokens: 30,
    totalTokens: 180
  })
})

await runTest('buildAgyArgs enforces hard readonly settings and handles --mode plan vs --disable-slash-commands', () => {
  const roArgs = buildAgyArgs({
    readonly: true,
    disableSlashCommands: true,
    timeoutMs: 60000,
    backendOptions: { dangerouslySkipPermissions: true, mode: 'auto' }
  })
  assert.equal(roArgs.includes('--dangerously-skip-permissions'), false)
  assert.equal(roArgs.includes('--mode'), false)
  assert.equal(roArgs.includes('--disable-slash-commands'), true)
  const settingsIdx = roArgs.indexOf('--settings')
  assert.notEqual(settingsIdx, -1)
  const parsedSettings = JSON.parse(roArgs[settingsIdx + 1])
  assert.deepEqual(parsedSettings.permissions.deny, ['write_file(*)', 'command(*)'])

  const planArgs = buildAgyArgs({
    readonly: true,
    readonlyApprovalMode: 'plan',
    disableSlashCommands: true,
    timeoutMs: 60000
  })
  assert.equal(planArgs.includes('--mode'), true)
  assert.equal(planArgs[planArgs.indexOf('--mode') + 1], 'plan')
  // Probe A1: --mode plan conflicts with --disable-slash-commands, so the latter must be omitted.
  assert.equal(planArgs.includes('--disable-slash-commands'), false)
})

await runTest('sanitizeDiagnostic redacts tokens/keys/cookies and caps byte length <= 4096', () => {
  const raw = 'Authorization: Bearer abcdef1234567890\nGEMINI_API_KEY=AIzaSyTestSecretKey123456789012345\nCookie: sid=topsecret\n' + 'x'.repeat(6000)
  const clean = sanitizeDiagnostic(raw)
  assert.equal(clean.includes('abcdef1234567890'), false)
  assert.equal(clean.includes('AIzaSyTestSecretKey'), false)
  assert.equal(clean.includes('topsecret'), false)
  assert.equal(Buffer.byteLength(clean, 'utf8') <= 4096, true)
})

await runTest('resolveAgyBinary handles script paths and default binary cleanly', () => {
  const jsRes = resolveAgyBinary(FAKE_AGY_PATH)
  assert.equal(jsRes.command, process.execPath)
  assert.deepEqual(jsRes.argsPrefix, [FAKE_AGY_PATH])
})

// ── M1.2: Fake-agy subprocess E2E tests ───────────────────────────────────────

console.log('\n[M1.2] Fake-agy subprocess E2E tests')

await runTest('fake-agy run mode: streaming progress, conversationId, resumeHint, usage, readonly deny', async () => {
  const adapter = createAntigravityAdapter(() => makeFakeConfig({ defaultModel: 'gemini-4-neon-high' }))
  const progress = []
  const ac = new AbortController()

  const res = await adapter.run({
    role: 'planner',
    cwd: REPO_ROOT,
    prompt: 'Analyze module boundaries',
    readonly: true,
    reasoningEffort: 'high',
    signal: ac.signal,
    onProgress: (ev) => progress.push(ev)
  })

  assert.equal(res.stopReason, 'completed')
  assert.equal(res.externalSessionId, 'fake-conv-0001')
  assert.equal(res.resumeHint, 'agy --conversation fake-conv-0001')
  assert.equal(typeof res.durationMs, 'number')
  assert.deepEqual(res.usage, {
    inputTokens: 1500,
    cacheReadTokens: 0,
    outputTokens: 120,
    reasoningTokens: 80,
    totalTokens: 1620
  })
  assert.equal(progress.some((e) => e.kind === 'tool-call' && e.toolName === 'view_file'), true)
  assert.equal(progress.some((e) => e.kind === 'tool-result' && e.toolName === 'view_file'), true)
  assert.equal(progress.some((e) => e.kind === 'text-delta'), true)

  const echoed = JSON.parse(res.text)
  assert.equal(echoed.model, 'gemini-4-neon-high')
  assert.equal(echoed.effort, 'high')
  assert.deepEqual(echoed.settings.permissions.deny, ['write_file(*)', 'command(*)'])
  assert.equal(echoed.promptPrefix.includes('[只读约束]'), true)
})

await runTest('fake-agy --json-schema creates temp file, returns structured, and cleans up temp file', async () => {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-adapter-schema-'))
  try {
    const adapter = createAntigravityAdapter(() => makeFakeConfig())
    const res = await adapter.run({
      role: 'reviewer',
      cwd: scratchDir,
      prompt: 'Review changes',
      readonly: true,
      outputSchema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, count: { type: 'integer' } },
        required: ['ok', 'count']
      },
      signal: new AbortController().signal
    })

    assert.equal(res.stopReason, 'completed')
    assert.equal(res.structured.ok, true)
    assert.equal(typeof res.structured.count, 'number')

    const tempDir = path.join(scratchDir, 'temp')
    if (fs.existsSync(tempDir)) {
      assert.deepEqual(fs.readdirSync(tempDir), [])
    }
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true })
  }
})

await runTest('fake-agy --conversation resume returns per-turn delta usage (not cumulative)', async () => {
  const adapter = createAntigravityAdapter(() => makeFakeConfig())
  const res = await adapter.run({
    role: 'planner',
    cwd: REPO_ROOT,
    prompt: 'Follow-up turn',
    readonly: true,
    externalSessionId: 'conv-resume-99',
    signal: new AbortController().signal
  })

  assert.equal(res.stopReason, 'completed')
  assert.equal(res.externalSessionId, 'conv-resume-99')
  assert.equal(res.resumeHint, 'agy --conversation conv-resume-99')
  // Must match Turn 2 delta (250/1800/50/20/300), NOT cumulative result.usage (1750/1800/170/100/1920).
  assert.deepEqual(res.usage, {
    inputTokens: 250,
    cacheReadTokens: 1800,
    outputTokens: 50,
    reasoningTokens: 20,
    totalTokens: 300
  })
  // Local durationMs must be measured locally (< 5000ms), NOT cumulative result.duration_seconds (99.5s).
  assert.equal(res.durationMs < 5000, true)
})

await runTest('fake-agy handoff mode forces readonly even if caller passes readonly:false and adds handoff preamble', async () => {
  const adapter = createAntigravityAdapter(() => makeFakeConfig())
  const res = await adapter.run({
    role: 'handoff',
    cwd: REPO_ROOT,
    prompt: 'Handing off big refactor',
    readonly: false,
    signal: new AbortController().signal
  })

  assert.equal(res.stopReason, 'completed')
  const echoed = JSON.parse(res.text)
  assert.equal(echoed.promptPrefix.includes('[来自 DSH 的任务交接包]'), true)
  assert.deepEqual(echoed.settings.permissions.deny, ['write_file(*)', 'command(*)'])
})

await runTest('fake-agy handles >40KB prompt via stream-json stdin without Windows CLI limit', async () => {
  const adapter = createAntigravityAdapter(() => makeFakeConfig())
  const hugePrompt = 'Analyze:\n' + 'B'.repeat(42000)
  const res = await adapter.run({
    role: 'worker-low',
    cwd: REPO_ROOT,
    prompt: hugePrompt,
    readonly: false,
    signal: new AbortController().signal
  })

  assert.equal(res.stopReason, 'completed')
  const echoed = JSON.parse(res.text)
  assert.equal(echoed.promptLength, hugePrompt.length)
})

await runTest('fake-agy tolerates malformed stdout lines interleaved with NDJSON', async () => {
  const adapter = createAntigravityAdapter(() => makeFakeConfig())
  const res = await adapter.run({
    role: 'worker-low',
    cwd: REPO_ROOT,
    prompt: '[FAKE_SCENARIO:malformed-lines] test',
    readonly: false,
    signal: new AbortController().signal
  })
  assert.equal(res.stopReason, 'completed')
  assert.equal(res.text, 'TOLERATED_OK')
})

await runTest('fake-agy timeout force-kills hanging process tree and returns stopReason: timeout', async () => {
  const adapter = createAntigravityAdapter(() => makeFakeConfig(), { killGraceMs: 120 })
  const res = await adapter.run({
    role: 'worker-low',
    cwd: REPO_ROOT,
    prompt: '[FAKE_SCENARIO:hang] timeout test',
    readonly: true,
    timeoutMs: 250,
    signal: new AbortController().signal
  })

  assert.equal(res.stopReason, 'timeout')
  assert.equal(typeof res.diagnostic, 'string')
  const diag = JSON.parse(res.diagnostic)
  assert.equal(diag.error_code, 'TIMEOUT')
  assert.equal(Boolean(diag.operation && diag.target && diag.input_summary && diag.context), true)
})

await runTest('fake-agy AbortSignal cancels hanging child and pre-aborted signal exits immediately', async () => {
  const adapter = createAntigravityAdapter(() => makeFakeConfig(), { killGraceMs: 120 })

  const preAborted = new AbortController()
  preAborted.abort()
  const fastRes = await adapter.run({
    role: 'worker-low',
    cwd: REPO_ROOT,
    prompt: 'Never runs',
    readonly: true,
    signal: preAborted.signal
  })
  assert.equal(fastRes.stopReason, 'aborted')

  const liveAc = new AbortController()
  setTimeout(() => liveAc.abort(), 180)
  const liveRes = await adapter.run({
    role: 'worker-low',
    cwd: REPO_ROOT,
    prompt: '[FAKE_SCENARIO:hang] abort test',
    readonly: true,
    timeoutMs: 10000,
    signal: liveAc.signal
  })
  assert.equal(liveRes.stopReason, 'aborted')
})

await runTest('fake-agy non-zero exit normalizes to error and redacts secrets from diagnostic', async () => {
  const adapter = createAntigravityAdapter(() => makeFakeConfig())
  const res = await adapter.run({
    role: 'worker-low',
    cwd: REPO_ROOT,
    prompt: '[FAKE_SCENARIO:exit-error] trigger error',
    readonly: true,
    signal: new AbortController().signal
  })

  assert.equal(res.stopReason, 'error')
  assert.equal(res.diagnostic.includes('supersecretTOKEN123456'), false)
  assert.equal(res.diagnostic.includes('AIzaSyFakeKeyValue'), false)
  assert.equal(res.diagnostic.includes('REDACTED'), true)
})

await runTest('fake-agy agy-level ERROR status normalizes to error without throwing', async () => {
  const adapter = createAntigravityAdapter(() => makeFakeConfig())
  const res = await adapter.run({
    role: 'worker-low',
    cwd: REPO_ROOT,
    prompt: '[FAKE_SCENARIO:agy-error] trigger error',
    readonly: true,
    signal: new AbortController().signal
  })
  assert.equal(res.stopReason, 'error')
  assert.equal(res.diagnostic.includes('AGY_ERROR'), true)
})

await runTest('missing executable ENOENT normalizes to stopReason: error and healthCheck returns ok:false', async () => {
  const missingBin = path.join(REPO_ROOT, 'non-existent-agy-binary-xyz.exe')
  const adapter = createAntigravityAdapter(() => makeFakeConfig({ agyPath: missingBin }))

  const health = await adapter.healthCheck()
  assert.equal(health.ok, false)

  const res = await adapter.run({
    role: 'worker-low',
    cwd: REPO_ROOT,
    prompt: 'hello',
    readonly: true,
    signal: new AbortController().signal
  })
  assert.equal(res.stopReason, 'error')
  assert.equal(res.diagnostic.includes('ENOENT'), true)
})

await runTest('healthCheck returns ok:true with version against fake-agy', async () => {
  const health = await checkAgyHealth(FAKE_AGY_PATH)
  assert.equal(health.ok, true)
  assert.equal(health.version, '1.5.16-fake')
})

await runTest('illegal request parameters throw Error per CONTRACT.md §3.1', async () => {
  const adapter = createAntigravityAdapter(() => makeFakeConfig())
  const signal = new AbortController().signal

  await assert.rejects(() => adapter.run({ role: 'planner', cwd: REPO_ROOT, prompt: '   ', readonly: true, signal }), /prompt/)
  await assert.rejects(() => adapter.run({ role: 'planner', cwd: 'relative/path', prompt: 'hi', readonly: true, signal }), /cwd/)
  await assert.rejects(() => adapter.run({ role: 'planner', cwd: REPO_ROOT + '/..', prompt: 'hi', readonly: true, signal }), /cwd/)
  await assert.rejects(() => adapter.run({ role: 'invalid-role', cwd: REPO_ROOT, prompt: 'hi', readonly: true, signal }), /role/)
  await assert.rejects(() => adapter.run({ role: 'planner', cwd: REPO_ROOT, prompt: 'hi', readonly: 'yes', signal }), /readonly/)
  await assert.rejects(() => adapter.run({ role: 'planner', cwd: REPO_ROOT, prompt: 'hi', readonly: true, externalSessionId: '--bad-flag', signal }), /externalSessionId/)
})

// ── M2: Cordis plugin loading & contract tests ────────────────────────────────

console.log('\n[M2] Cordis plugin & ExternalBackendAdapter v1 contract tests')

await runTest('src/index.js has NO default export and exposes required named Cordis exports', () => {
  assert.equal('default' in pluginModule, false, 'export default is forbidden by DSH cordis-plugin-loader')
  assert.equal(pluginModule.name, 'antigravity-adapter')
  assert.deepEqual(pluginModule.inject, [])
  assert.equal(typeof pluginModule.Config, 'function')
  assert.equal(typeof pluginModule.apply, 'function')
})

await runTest('readConfig unwraps cosmokit volatile refs live', () => {
  let currentPath = 'agy'
  const ref = { get: () => currentPath }
  const cfg1 = pluginModule.readConfig({ agyPath: ref })
  assert.equal(cfg1.agyPath, 'agy')
  currentPath = FAKE_AGY_PATH
  const cfg2 = pluginModule.readConfig({ agyPath: ref })
  assert.equal(cfg2.agyPath, FAKE_AGY_PATH)
})

await runTest('Cordis integration: does not stall without tieredWorkflow; registers & disposes when mounted', async () => {
  const cordisEntry = 'C:/Program Files/nvm/v24.18.1/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js'
  assert.equal(fs.existsSync(cordisEntry), true, 'Host @deepseek-ai/cordis not found')
  const { Context } = await import(pathToFileURL(cordisEntry).href)

  const ctx = new Context()

  // 1. Mount plugin BEFORE tieredWorkflow exists -> must not stall or throw.
  const fork = ctx.plugin(pluginModule, { agyPath: FAKE_AGY_PATH, registerStandaloneTool: false })
  await new Promise((r) => setTimeout(r, 30))

  // 2. Dynamically provide mock tieredWorkflow service -> adapter must auto-register.
  const registered = new Map()
  let disposedCount = 0
  ctx.provide('tieredWorkflow')
  ctx.set('tieredWorkflow', {
    registerBackend(adapter) {
      registered.set(adapter.id, adapter)
      return () => {
        registered.delete(adapter.id)
        disposedCount++
      }
    }
  })

  await new Promise((r) => setTimeout(r, 30))
  assert.equal(registered.has('antigravity'), true)

  const adapter = registered.get('antigravity')
  assert.equal(adapter.contractVersion, EXTERNAL_BACKEND_CONTRACT_VERSION)
  assert.equal(adapter.id, 'antigravity')
  assert.equal(adapter.label, 'Antigravity (agy CLI)')
  assert.deepEqual(adapter.capabilities, {
    readonlyMode: true,
    structuredOutput: true,
    continuation: true,
    handoff: true,
    usageReporting: true
  })

  const health = await adapter.healthCheck()
  assert.equal(health.ok, true)

  // 3. Dispose plugin -> disposer must unregister backend cleanly.
  fork.dispose()
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(registered.has('antigravity'), false)
  assert.equal(disposedCount, 1)

  await ctx.fiber.dispose()
})

await runTest('Cordis standalone tool: registers dispatch_antigravity only when registerStandaloneTool: true', async () => {
  const cordisEntry = 'C:/Program Files/nvm/v24.18.1/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js'
  const { Context } = await import(pathToFileURL(cordisEntry).href)

  const ctx = new Context()

  const tools = new Map()
  ctx.provide('tools')
  ctx.set('tools', {
    register(def) {
      tools.set(def.name, def)
      return () => tools.delete(def.name)
    }
  })

  // Default (false) -> not registered
  const f1 = ctx.plugin(pluginModule, { agyPath: FAKE_AGY_PATH, registerStandaloneTool: false })
  await new Promise((r) => setTimeout(r, 25))
  assert.equal(tools.has('dispatch_antigravity'), false)
  f1.dispose()

  // Enabled (true) -> registered and executable
  const f2 = ctx.plugin(pluginModule, { agyPath: FAKE_AGY_PATH, registerStandaloneTool: true })
  await new Promise((r) => setTimeout(r, 25))
  assert.equal(tools.has('dispatch_antigravity'), true)

  const toolDef = tools.get('dispatch_antigravity')
  const toolRes = await toolDef.execute(
    { prompt: 'Handoff via standalone tool', mode: 'handoff', cwd: REPO_ROOT },
    { signal: new AbortController().signal }
  )
  assert.equal(toolRes.stopReason, 'completed')
  assert.equal(toolRes.externalSessionId, 'fake-conv-0001')
  assert.equal(toolRes.resumeHint, 'agy --conversation fake-conv-0001')

  f2.dispose()
  await new Promise((r) => setTimeout(r, 25))
  assert.equal(tools.has('dispatch_antigravity'), false)

  await ctx.fiber.dispose()
})

// ── M3: Real agy CLI E2E tests (opt-in via --real) ────────────────────────────

if (RUN_REAL) {
  console.log('\n[M3] Real agy CLI E2E tests')

  const realAdapter = createAntigravityAdapter(() => ({
    agyPath: 'agy',
    defaultTimeoutMs: 90000,
    defaultApprovalMode: '',
    readonlyApprovalMode: '',
    defaultModel: '',
    disableSlashCommands: true,
    registerStandaloneTool: false,
    debugLog: ''
  }))

  await runTest('real agy healthCheck returns ok:true and version', async () => {
    const health = await realAdapter.healthCheck()
    assert.equal(health.ok, true, `healthCheck failed: ${JSON.stringify(health)}`)
    assert.equal(typeof health.version, 'string')
    assert.equal(health.version.length > 0, true)
    console.log(`       version=${health.version} path=${health.detail}`)
  })

  let realConvId = ''

  await runTest('real agy run Turn 1 (readonly + --json-schema) returns structured output & usage', async () => {
    const progress = []
    const res = await realAdapter.run({
      role: 'planner',
      cwd: REPO_ROOT,
      prompt: '记住暗号 DELTA-77。按 JSON Schema 输出 token="DELTA-77" 与 value=77，不要调用任何工具。',
      readonly: true,
      outputSchema: {
        type: 'object',
        properties: {
          token: { type: 'string' },
          value: { type: 'integer' }
        },
        required: ['token', 'value'],
        additionalProperties: false
      },
      timeoutMs: 90000,
      signal: new AbortController().signal,
      onProgress: (ev) => progress.push(ev)
    })

    assert.equal(res.stopReason, 'completed', `diagnostic=${res.diagnostic}`)
    assert.equal(typeof res.externalSessionId, 'string')
    assert.equal(res.externalSessionId.length > 8, true)
    assert.equal(res.resumeHint, `agy --conversation ${res.externalSessionId}`)
    assert.deepEqual(res.structured, { token: 'DELTA-77', value: 77 })
    assert.equal(typeof res.usage?.inputTokens, 'number')
    assert.equal(typeof res.usage?.outputTokens, 'number')
    assert.equal('cacheWriteTokens' in (res.usage || {}), false)
    realConvId = res.externalSessionId
    console.log(`       convId=${realConvId} usage=${JSON.stringify(res.usage)} durationMs=${res.durationMs}`)
  })

  await runTest('real agy run Turn 2 (--conversation resume) recalls context and reports per-turn delta usage', async () => {
    assert.equal(Boolean(realConvId), true, 'Turn 1 did not produce conversationId')
    const res = await realAdapter.run({
      role: 'planner',
      cwd: REPO_ROOT,
      prompt: '上一轮让你记住的暗号是什么？按 JSON Schema 输出 token=该暗号，value=154，不要调用任何工具。',
      readonly: true,
      externalSessionId: realConvId,
      outputSchema: {
        type: 'object',
        properties: {
          token: { type: 'string' },
          value: { type: 'integer' }
        },
        required: ['token', 'value'],
        additionalProperties: false
      },
      timeoutMs: 90000,
      signal: new AbortController().signal
    })

    assert.equal(res.stopReason, 'completed', `diagnostic=${res.diagnostic}`)
    assert.equal(res.externalSessionId, realConvId)
    assert.deepEqual(res.structured, { token: 'DELTA-77', value: 154 })
    assert.equal(typeof res.usage?.cacheReadTokens, 'number')
    assert.equal(res.usage.cacheReadTokens > 0, true, 'Expected cache hit on resumed turn')
    console.log(`       turn2 usage=${JSON.stringify(res.usage)} durationMs=${res.durationMs}`)
  })

  await runTest('real agy handoff mode creates readonly persistent session and returns resumeHint', async () => {
    const res = await realAdapter.run({
      role: 'handoff',
      cwd: REPO_ROOT,
      prompt: '目标：为 dsh-antigravity-adapter 规划 v0.2 acp 升级路线。关键文件：docs/DESIGN.md。请仅用两句话确认接管即可，不要调用工具。',
      readonly: false, // Adapter must force readonly for handoff
      timeoutMs: 90000,
      signal: new AbortController().signal
    })

    assert.equal(res.stopReason, 'completed', `diagnostic=${res.diagnostic}`)
    assert.equal(typeof res.externalSessionId, 'string')
    assert.equal(res.resumeHint, `agy --conversation ${res.externalSessionId}`)
    assert.equal(res.text.trim().length > 0, true)
    console.log(`       handoff convId=${res.externalSessionId} durationMs=${res.durationMs}`)
  })
}

console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`)
if (failed > 0) process.exit(1)
