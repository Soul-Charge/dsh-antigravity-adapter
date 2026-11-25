// SPDX-License-Identifier: MIT
// NDJSON stream parser for `agy --output-format stream-json`.
// Verified against agy CLI v1.5.16 (docs/PROBES.md A2/A3).

const MAX_MALFORMED_LINES = 20
const MAX_MALFORMED_CHARS = 256

function isValidCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/**
 * Map agy raw usage object into ExternalUsage (6-dimension disjoint contract).
 * Missing/non-numeric dimensions are omitted rather than fabricated as 0.
 *
 * @param {Record<string, unknown> | null | undefined} raw
 * @returns {Record<string, number> | undefined}
 */
export function mapRawUsage(raw) {
  if (!raw || typeof raw !== 'object') return undefined
  const mapped = {}
  let hasAny = false

  if (isValidCount(raw.input_tokens)) {
    mapped.inputTokens = raw.input_tokens
    hasAny = true
  }
  if (isValidCount(raw.cache_read_tokens)) {
    mapped.cacheReadTokens = raw.cache_read_tokens
    hasAny = true
  }
  if (isValidCount(raw.cache_write_tokens)) {
    mapped.cacheWriteTokens = raw.cache_write_tokens
    hasAny = true
  }
  if (isValidCount(raw.output_tokens)) {
    mapped.outputTokens = raw.output_tokens
    hasAny = true
  }
  if (isValidCount(raw.thinking_tokens)) {
    mapped.reasoningTokens = raw.thinking_tokens
    hasAny = true
  }
  if (isValidCount(raw.total_tokens)) {
    mapped.totalTokens = raw.total_tokens
    hasAny = true
  }

  return hasAny ? mapped : undefined
}

/**
 * Sum per-step ExternalUsage records observed during a single agy invocation.
 * Prevents double-counting when resuming conversations (--conversation), where
 * agy's terminal result.usage is cumulative across all historical turns.
 *
 * @param {Map<number, Record<string, number>>} stepUsageByIndex
 * @returns {Record<string, number> | undefined}
 */
export function aggregateStepUsage(stepUsageByIndex) {
  if (!stepUsageByIndex || stepUsageByIndex.size === 0) return undefined
  const keys = [
    'inputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'outputTokens',
    'reasoningTokens',
    'totalTokens'
  ]
  const total = {}
  let hasAny = false

  for (const usage of stepUsageByIndex.values()) {
    for (const key of keys) {
      if (isValidCount(usage[key])) {
        total[key] = (total[key] || 0) + usage[key]
        hasAny = true
      }
    }
  }

  return hasAny ? total : undefined
}

/**
 * Create a stateful incremental NDJSON line parser for `agy --output-format stream-json`.
 *
 * @param {{ onProgress?: (event: Record<string, unknown>) => void }} [options]
 */
export function createStreamParser(options = {}) {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null
  let buffer = ''
  let conversationId = ''
  let initPayload = null
  let resultPayload = null
  const textChunks = []
  const stepUsageByIndex = new Map()
  let syntheticStepKey = -1
  const malformedLines = []

  function emitProgress(event) {
    if (!onProgress) return
    try {
      onProgress(event)
    } catch {
      // Contract: onProgress must never throw into or abort the main execution flow.
    }
  }

  function handleParsedLine(obj) {
    if (!obj || typeof obj !== 'object') return

    if (typeof obj.conversation_id === 'string' && obj.conversation_id.trim()) {
      conversationId = obj.conversation_id.trim()
    }

    const eventType = obj.event

    if (eventType === 'init' && obj.init && typeof obj.init === 'object') {
      initPayload = obj.init
      const perm = typeof obj.init.permission_mode === 'string' ? obj.init.permission_mode : ''
      emitProgress({
        kind: 'status',
        text: perm ? `init:${perm}` : 'init'
      })
      return
    }

    if (eventType === 'step_update' && obj.step_update && typeof obj.step_update === 'object') {
      const su = obj.step_update
      if (typeof su.conversation_id === 'string' && su.conversation_id.trim()) {
        conversationId = su.conversation_id.trim()
      }

      if (su.step_type === 'agent_response' && typeof su.text_delta === 'string' && su.text_delta.length > 0) {
        textChunks.push(su.text_delta)
        emitProgress({ kind: 'text-delta', text: su.text_delta })
      } else if (su.step_type === 'tool') {
        const toolName = typeof su.tool_name === 'string' && su.tool_name
          ? su.tool_name
          : (su.tool_info && typeof su.tool_info.name === 'string' ? su.tool_info.name : 'tool')

        if (su.state === 'ACTIVE') {
          emitProgress({ kind: 'tool-call', toolName })
        } else if (su.state === 'DONE' || su.state === 'ERROR') {
          const errMsg = su.tool_info && su.tool_info.error && typeof su.tool_info.error.message === 'string'
            ? su.tool_info.error.message
            : undefined
          emitProgress({
            kind: 'tool-result',
            toolName,
            ...(errMsg ? { text: errMsg } : {})
          })
        }
      }

      const stepUsage = mapRawUsage(su.usage)
      if (stepUsage) {
        const key = typeof su.step_index === 'number' && Number.isFinite(su.step_index)
          ? su.step_index
          : syntheticStepKey--
        stepUsageByIndex.set(key, stepUsage)
        emitProgress({ kind: 'usage', usage: stepUsage })
      }
      return
    }

    if (eventType === 'result' && obj.result && typeof obj.result === 'object') {
      const res = obj.result
      resultPayload = res
      if (typeof res.conversation_id === 'string' && res.conversation_id.trim()) {
        conversationId = res.conversation_id.trim()
      }
      if (typeof res.status === 'string' && res.status && res.status !== 'SUCCESS') {
        emitProgress({ kind: 'status', text: `result:${res.status}` })
      }
    }
  }

  function processLine(rawLine) {
    const trimmed = rawLine.trim()
    if (!trimmed) return
    let parsed
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      if (malformedLines.length < MAX_MALFORMED_LINES) {
        malformedLines.push(trimmed.slice(0, MAX_MALFORMED_CHARS))
      }
      return
    }
    handleParsedLine(parsed)
  }

  function feed(chunk) {
    if (chunk === null || chunk === undefined) return
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    let idx = buffer.indexOf('\n')
    while (idx !== -1) {
      const line = buffer.slice(0, idx).replace(/\r$/, '')
      buffer = buffer.slice(idx + 1)
      processLine(line)
      idx = buffer.indexOf('\n')
    }
  }

  function flush() {
    if (buffer.length > 0) {
      const trailing = buffer.replace(/\r$/, '')
      buffer = ''
      processLine(trailing)
    }
  }

  function getSummary() {
    const finalConversationId =
      (resultPayload && typeof resultPayload.conversation_id === 'string' && resultPayload.conversation_id.trim()) ||
      conversationId ||
      undefined

    const text = resultPayload && typeof resultPayload.response === 'string'
      ? resultPayload.response
      : textChunks.join('')

    const hasStructured = Boolean(
      resultPayload &&
      Object.prototype.hasOwnProperty.call(resultPayload, 'structured_output') &&
      resultPayload.structured_output !== undefined
    )

    let usage = aggregateStepUsage(stepUsageByIndex)
    if (!usage && resultPayload && resultPayload.usage) {
      const numTurns = resultPayload.num_turns
      if (typeof numTurns !== 'number' || numTurns <= 1) {
        usage = mapRawUsage(resultPayload.usage)
      }
    }

    return {
      conversationId: finalConversationId,
      status: resultPayload && typeof resultPayload.status === 'string' ? resultPayload.status : null,
      error: resultPayload && typeof resultPayload.error === 'string' ? resultPayload.error : null,
      finishedReason: resultPayload && typeof resultPayload.finished_reason === 'string' ? resultPayload.finished_reason : null,
      numTurns: resultPayload && typeof resultPayload.num_turns === 'number' ? resultPayload.num_turns : null,
      text,
      structured: hasStructured ? resultPayload.structured_output : undefined,
      usage,
      init: initPayload,
      result: resultPayload,
      malformedLines: [...malformedLines]
    }
  }

  return {
    feed,
    flush,
    getSummary
  }
}
