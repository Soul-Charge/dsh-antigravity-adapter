// SPDX-License-Identifier: MIT
// Optional standalone DSH tool `dispatch_antigravity` for environments without
// dsh-tiered-workflow (or when explicitly enabled via config.registerStandaloneTool).

import path from 'node:path'

function resolveWorkingDir(args, exec) {
  const candidates = [
    args && typeof args.cwd === 'string' ? args.cwd.trim() : '',
    exec && typeof exec.cwd === 'string' ? exec.cwd.trim() : '',
    exec && exec.agent && typeof exec.agent.cwd === 'string' ? exec.agent.cwd.trim() : '',
    process.cwd()
  ]
  for (const candidate of candidates) {
    if (candidate && path.isAbsolute(candidate)) return candidate
  }
  return process.cwd()
}

/**
 * Register the standalone `dispatch_antigravity` tool on `ctx.tools`.
 *
 * @param {object} ctx
 * @param {import('./adapter.js').createAntigravityAdapter extends (...args: any[]) => infer R ? R : any} adapter
 * @param {() => { defaultTimeoutMs: number }} getConfig
 * @returns {(() => void) | undefined}
 */
export function registerStandaloneTool(ctx, adapter, getConfig) {
  if (!ctx || !ctx.tools || typeof ctx.tools.register !== 'function') return undefined

  return ctx.tools.register({
    name: 'dispatch_antigravity',
    description: [
      '将任务派发到本机 Google Antigravity CLI（agy Headless）开启持久化会话。',
      'mode="run"：在 Antigravity 中执行并返回答复与会话 ID（可用 conversationId 续聊）；',
      'mode="handoff"：以只读模式把任务交接包写入新会话并返回 agy --conversation <id> 供用户接管。'
    ].join(''),
    parameters: {
      type: 'object',
      required: ['prompt'],
      properties: {
        prompt: {
          type: 'string',
          title: 'prompt',
          description: '要发送给 Antigravity 的完整提示词或任务交接说明。'
        },
        mode: {
          type: 'string',
          enum: ['run', 'handoff'],
          title: 'mode',
          description: '执行模式：run（默认，拿回结果）或 handoff（只读建会话交棒给用户）。'
        },
        conversationId: {
          type: 'string',
          title: 'conversationId',
          description: '可选：传入上次返回的 externalSessionId 在同一会话中续聊。'
        },
        readonly: {
          type: 'boolean',
          title: 'readonly',
          description: '可选：是否启用进程级只读约束（handoff 模式固定为 true；run 模式默认 true）。'
        },
        cwd: {
          type: 'string',
          title: 'cwd',
          description: '可选：工作目录绝对路径（默认沿用当前工作区目录）。'
        },
        model: {
          type: 'string',
          title: 'model',
          description: '可选：覆盖本次调用的 Antigravity 模型 slug（如 gemini-4-neon-high）。'
        },
        reasoningEffort: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'xhigh', 'max'],
          title: 'reasoningEffort',
          description: '可选：推理强度。'
        }
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['stopReason', 'text', 'durationMs'],
        properties: {
          stopReason: { type: 'string' },
          externalSessionId: { type: 'string' },
          resumeHint: { type: 'string' },
          text: { type: 'string' },
          durationMs: { type: 'number' },
          diagnostic: { type: 'string' }
        }
      },
      render: (_args, value) => {
        const lines = []
        lines.push(`[antigravity:${value.stopReason}] (${value.durationMs}ms)`)
        if (value.resumeHint) lines.push(`接管命令：${value.resumeHint}`)
        if (value.text) lines.push(value.text)
        if (value.diagnostic) lines.push(`诊断：${value.diagnostic}`)
        return [{ type: 'text', text: lines.join('\n') }]
      }
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = args && typeof args === 'object' ? args : {}
      const prompt = typeof input.prompt === 'string' ? input.prompt : ''
      if (!prompt.trim()) {
        throw new Error('dispatch_antigravity 拒绝执行：prompt 不能为空')
      }

      const mode = input.mode === 'handoff' ? 'handoff' : 'run'
      const readonly = mode === 'handoff'
        ? true
        : (typeof input.readonly === 'boolean' ? input.readonly : true)

      const cfg = getConfig()
      const signal = exec && exec.signal ? exec.signal : new AbortController().signal

      const res = await adapter.run({
        role: mode === 'handoff' ? 'handoff' : 'worker-medium',
        cwd: resolveWorkingDir(input, exec),
        prompt,
        readonly,
        ...(typeof input.conversationId === 'string' && input.conversationId.trim()
          ? { externalSessionId: input.conversationId.trim() }
          : {}),
        ...(typeof input.model === 'string' && input.model.trim()
          ? { model: input.model.trim() }
          : {}),
        ...(typeof input.reasoningEffort === 'string' && input.reasoningEffort.trim()
          ? { reasoningEffort: input.reasoningEffort.trim() }
          : {}),
        timeoutMs: cfg.defaultTimeoutMs,
        signal
      })

      return {
        stopReason: res.stopReason,
        ...(res.externalSessionId ? { externalSessionId: res.externalSessionId } : {}),
        ...(res.resumeHint ? { resumeHint: res.resumeHint } : {}),
        text: res.text,
        durationMs: res.durationMs,
        ...(res.diagnostic ? { diagnostic: res.diagnostic } : {})
      }
    }
  })
}
