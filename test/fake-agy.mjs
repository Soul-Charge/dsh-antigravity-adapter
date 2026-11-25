// SPDX-License-Identifier: MIT
// Deterministic fake `agy` CLI process for M1/M2 automated tests.

import fs from 'node:fs'

const argv = process.argv.slice(2)

if (argv.includes('--version')) {
  process.stdout.write('1.5.16-fake\n')
  process.exit(0)
}

function getFlagValue(flag) {
  const idx = argv.indexOf(flag)
  return idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : null
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'))
  }
  return Buffer.concat(chunks).toString('utf8')
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

async function main() {
  const rawStdin = await readStdin()
  const lines = rawStdin.split(/\r?\n/).filter((l) => l.trim().length > 0)
  let prompt = ''
  if (lines.length > 0) {
    const parsed = JSON.parse(lines[0])
    if (parsed.event !== 'user' || !parsed.message) {
      process.stderr.write('error: invalid stream input message\n')
      process.exit(1)
    }
    prompt = typeof parsed.message.content === 'string' ? parsed.message.content : ''
  }

  const conversationId = getFlagValue('--conversation') || 'fake-conv-0001'
  const schemaArg = getFlagValue('--json-schema')
  const settingsArg = getFlagValue('--settings')
  const modeArg = getFlagValue('--mode')
  const modelArg = getFlagValue('--model')
  const effortArg = getFlagValue('--effort')
  const isResume = Boolean(getFlagValue('--conversation'))

  let scenario = process.env.FAKE_AGY_SCENARIO || ''
  const directiveMatch = prompt.match(/\[FAKE_SCENARIO:([a-z0-9-]+)\]/i)
  if (directiveMatch) scenario = directiveMatch[1].toLowerCase()

  emit({
    event: 'init',
    conversation_id: conversationId,
    init: {
      cwd: process.cwd(),
      tools: ['view_file', 'write_file', 'run_command'],
      permission_mode: argv.includes('--dangerously-skip-permissions') ? 'always-proceed' : 'request-review',
      ...(modelArg ? { model: modelArg } : {})
    }
  })

  if (scenario === 'hang') {
    // Ignore SIGTERM to exercise the Windows taskkill /PID /T /F fallback path.
    process.on('SIGTERM', () => {})
    setInterval(() => {}, 1000)
    return
  }

  if (scenario === 'exit-error') {
    process.stderr.write('fatal: request failed with Authorization: Bearer supersecretTOKEN123456 and GEMINI_API_KEY=AIzaSyFakeKeyValue123456789012345\n')
    process.exit(2)
  }

  if (scenario === 'agy-error') {
    emit({
      event: 'result',
      result: {
        conversation_id: conversationId,
        status: 'ERROR',
        response: '',
        error: 'simulated model failure',
        duration_seconds: 0.1,
        num_turns: 1,
        usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
        finished_reason: 'error'
      }
    })
    process.exit(1)
  }

  if (scenario === 'malformed-lines') {
    process.stdout.write('WARNING: non-json noise line before events\r\n')
    // Split a valid JSON line across two writes with CRLF.
    const stepLine = JSON.stringify({
      event: 'step_update',
      step_update: {
        conversation_id: conversationId,
        step_index: 1,
        state: 'DONE',
        step_type: 'agent_response',
        text_delta: 'TOLERATED_OK',
        usage: { input_tokens: 100, output_tokens: 10, thinking_tokens: 4, cache_read_tokens: 20, total_tokens: 110 }
      }
    }) + '\r\n'
    process.stdout.write(stepLine.slice(0, 40))
    await new Promise((r) => setTimeout(r, 15))
    process.stdout.write(stepLine.slice(40))
    process.stdout.write('{broken json line\n')
    emit({
      event: 'result',
      result: {
        conversation_id: conversationId,
        status: 'SUCCESS',
        response: 'TOLERATED_OK',
        duration_seconds: 0.2,
        num_turns: 1,
        usage: { input_tokens: 100, output_tokens: 10, thinking_tokens: 4, cache_read_tokens: 20, total_tokens: 110 }
      }
    })
    process.exit(0)
  }

  // Emit a tool call step to verify progress events.
  emit({
    event: 'step_update',
    step_update: {
      conversation_id: conversationId,
      step_index: 1,
      state: 'ACTIVE',
      step_type: 'tool',
      tool_name: 'view_file',
      tool_info: { name: 'view_file', parameters: { Path: 'README.md' } }
    }
  })
  emit({
    event: 'step_update',
    step_update: {
      conversation_id: conversationId,
      step_index: 1,
      state: 'DONE',
      step_type: 'tool',
      tool_name: 'view_file',
      duration_seconds: 0.05,
      tool_info: { name: 'view_file', output: 'ok' }
    }
  })

  let schemaObj = null
  if (schemaArg) {
    const raw = fs.existsSync(schemaArg) ? fs.readFileSync(schemaArg, 'utf8') : schemaArg
    schemaObj = JSON.parse(raw)
  }

  const echoPayload = {
    argv,
    mode: modeArg,
    model: modelArg,
    effort: effortArg,
    settings: settingsArg ? JSON.parse(settingsArg) : null,
    promptLength: prompt.length,
    promptPrefix: prompt.slice(0, 80),
    isResume,
    schemaPresent: Boolean(schemaObj)
  }

  const responseText = schemaObj
    ? JSON.stringify({ ok: true, count: echoPayload.promptLength })
    : JSON.stringify(echoPayload)

  const mid = Math.max(1, Math.floor(responseText.length / 2))
  emit({
    event: 'step_update',
    step_update: {
      conversation_id: conversationId,
      step_index: isResume ? 5 : 2,
      state: 'ACTIVE',
      step_type: 'agent_response',
      text_delta: responseText.slice(0, mid)
    }
  })

  const turnUsage = isResume
    ? { input_tokens: 250, output_tokens: 50, thinking_tokens: 20, cache_read_tokens: 1800, total_tokens: 300 }
    : { input_tokens: 1500, output_tokens: 120, thinking_tokens: 80, cache_read_tokens: 0, total_tokens: 1620 }

  emit({
    event: 'step_update',
    step_update: {
      conversation_id: conversationId,
      step_index: isResume ? 5 : 2,
      state: 'DONE',
      step_type: 'agent_response',
      text_delta: responseText.slice(mid),
      duration_seconds: 0.1,
      usage: turnUsage
    }
  })

  // On resumed turn, simulate agy's real cumulative result.usage (Turn 1 + Turn 2).
  const resultUsage = isResume
    ? { input_tokens: 1750, output_tokens: 170, thinking_tokens: 100, cache_read_tokens: 1800, total_tokens: 1920 }
    : turnUsage

  emit({
    event: 'result',
    result: {
      conversation_id: conversationId,
      status: 'SUCCESS',
      response: responseText,
      duration_seconds: isResume ? 99.5 : 0.15,
      num_turns: isResume ? 2 : 1,
      ...(schemaObj ? { structured_output: { ok: true, count: echoPayload.promptLength }, json_schema: schemaObj } : {}),
      usage: resultUsage
    }
  })
}

main().catch((err) => {
  process.stderr.write(String(err) + '\n')
  process.exit(1)
})
