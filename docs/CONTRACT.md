# ExternalBackendAdapter 契约规范（v1）

> 契约版本：**`v1`** · 同步基准仓：[Soul-Charge/dsh-tiered-workflow](https://github.com/Soul-Charge/dsh-tiered-workflow)（`docs/WORKFLOW-ARCHITECTURE.md` §3.7）
> 目的：让 `dsh-tiered-workflow`（主框架）与 `dsh-antigravity-adapter`（独立适配器）可由不同会话并行开发，零耦合、零字段漂移地热插拔对接。

---

## 1. Cordis 服务发现与注册方式

* 主框架 `dsh-tiered-workflow` 在 Cordis 根上下文注册服务名称：**`tieredWorkflow`**。
* 外部适配器插件**禁止**把 `tieredWorkflow` 写进静态必选 `export const inject = [...]`（否则在未安装主框架时会卡在 PENDING 无法加载）。
* 正确注册方式为 **Cordis 可选软依赖注入**：

```js
export const name = 'antigravity-adapter'
export const inject = [] // 保持为空或仅列必选核心服务

export function apply(ctx, config) {
  // 当主框架存在（或后续热挂载）时自动注册后端；卸载时 Cordis 自动回收 disposer
  ctx.inject(['tieredWorkflow'], (inner) => {
    const dispose = inner.tieredWorkflow.registerBackend(adapter)
    inner.on('dispose', () => dispose?.())
  })
}
```

* `tieredWorkflow.registerBackend(adapter)` 契约：
  * 参数：符合下文 `ExternalBackendAdapter` 的对象（`adapter.id` 唯一，重复注册抛错或覆盖由主框架明确记日志处理）。
  * 返回值：`() => void` 精确反注册 disposer。
  * 注册成功后，主框架的路由分发器与设置页后端列表立即可见该 `adapter.id`，无需硬编码名称。

---

## 2. TypeScript 语义接口定义（v1）

```ts
export const EXTERNAL_BACKEND_CONTRACT_VERSION = 1

export type ExternalRole =
  | 'planner'
  | 'reviewer'
  | 'worker-low'
  | 'worker-medium'
  | 'handoff'

export interface ExternalBackendCapabilities {
  /** 能否对本次运行施加只读约束（如 agy plan 模式或只读规则） */
  readonly readonlyMode: boolean
  /** 能否原生按 JSON Schema 输出结构化结果（如 agy --json-schema） */
  readonly structuredOutput: boolean
  /** 能否通过 externalSessionId 在同一外部会话上下文中续聊 */
  readonly continuation: boolean
  /** 是否支持 handoff 模式（开好持久化外部会话并返回人工接管指引） */
  readonly handoff: boolean
  /** 能否从执行流中提取并上报 token 消耗 */
  readonly usageReporting: boolean
}

export interface ExternalUsage {
  /** 与 DSH dsh-llm TokenUsage 保持一致：未缓存输入 token */
  inputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  totalTokens?: number
}

export interface ExternalProgressEvent {
  kind: 'status' | 'text-delta' | 'tool-call' | 'tool-result' | 'usage'
  text?: string
  toolName?: string
  usage?: ExternalUsage
}

export interface ExternalRunRequest {
  /** 本次调用承担的工作流角色 */
  role: ExternalRole
  /** 工作目录（Windows 绝对路径，正斜杠或反斜杠均可，适配器内部做规范化） */
  cwd: string
  /** 完整提示词（对于首轮，主框架负责拼入必要上下文；续聊时仅传增量反馈与证据） */
  prompt: string
  /** 主框架要求本次执行是否为只读；若后端 capabilities.readonlyMode 为 false，主框架会前置警告或拒绝用于只读角色 */
  readonly: boolean
  /** 可选对象根 JSON Schema；若后端不支持 structuredOutput，主框架会在返回后走 JSON 代码块解析降级 */
  outputSchema?: Record<string, unknown>
  /** 续聊时传入上次返回的 externalSessionId（如 Antigravity conversation_id） */
  externalSessionId?: string
  /** 可选：来自主框架 ModelProfile 的模型标识，适配器透传或按需映射 */
  model?: string
  /** 可选：来自主框架 ModelProfile 的推理强度标识 */
  reasoningEffort?: string
  /** 单次执行超时上限（毫秒）；未传则使用适配器自身默认超时 */
  timeoutMs?: number
  /** 后端专属透传配置（来自 ModelProfile.backendOptions，例如 { approvalMode: 'plan', addDirs: [...] }） */
  backendOptions?: Record<string, unknown>
  /** 宿主取消信号：abort 时适配器必须尽快终止外部子进程并返回 stopReason: 'aborted' */
  signal: AbortSignal
  /** 可选实时进度回调（绝不抛异常影响主流程） */
  onProgress?: (event: ExternalProgressEvent) => void
}

export interface ExternalRunResult {
  stopReason: 'completed' | 'aborted' | 'error' | 'timeout'
  /** 外部持久会话 ID（如 Antigravity conversation_id），供续聊与人工接管 */
  externalSessionId?: string
  /** 给人看的接管命令或指引，例如 "agy --conversation <id>" */
  resumeHint?: string
  /** 最终可见答复文本 */
  text: string
  /** 当传入 outputSchema 且成功解析校验后的结构化对象 */
  structured?: unknown
  /** 6 维互斥 token 统计（按实际拿到的字段填充，拿不到的字段省略，严禁伪造） */
  usage?: ExternalUsage
  /** 耗时（毫秒） */
  durationMs: number
  /** 失败/异常时的诊断摘要（禁止包含密钥或环境变量值，建议 ≤ 4096 字节） */
  diagnostic?: string
}

export interface ExternalBackendHealth {
  ok: boolean
  version?: string
  detail?: string
}

export interface ExternalBackendAdapter {
  readonly contractVersion: 1
  /** 全局唯一后端 ID，例如 "antigravity" */
  readonly id: string
  /** 设置页与日志展示名，例如 "Antigravity (agy CLI)" */
  readonly label: string
  readonly capabilities: ExternalBackendCapabilities
  /** 健康检查（如探测 agy 是否安装及版本），供设置页状态展示与前置校验 */
  healthCheck?(): Promise<ExternalBackendHealth>
  /** 发起一轮执行或续聊；常规执行失败应通过 stopReason: 'error' | 'timeout' | 'aborted' 返回，而非未捕获异常 */
  run(req: ExternalRunRequest): Promise<ExternalRunResult>
}
```

---

## 3. 错误与降级约定

1. **常规失败不抛裸异常**：超时、子进程非零退出、JSON 解析失败、信号取消等均应归一为 `ExternalRunResult`（`stopReason: 'timeout' | 'error' | 'aborted'` + 脱敏 `diagnostic`），只有非法调用参数（如空 `prompt` / 非法 `cwd`）可直接抛 `Error`。
2. **结构化输出兜底**：若 `req.outputSchema` 存在且适配器未能直接产出 `structured`（或后端不支持），适配器把原始 `text` 返回即可，主框架自动尝试提取 `json` 代码块并校验。
3. **只读诚实声明**：若某外部后端无法从进程层硬禁止写文件，必须如实填写 `readonlyMode` 语义并在 `DESIGN.md` 说明边界，禁止静默忽略 `req.readonly`。
4. **敏感信息红线**：`diagnostic` 与任何日志不得输出凭据、token、Cookie 或完整环境变量。
