# dsh-antigravity-adapter · 方案 A（`agy` CLI Headless）详细设计

> 编写日期：2026-11-25 · 适用平台：Windows 11 / Node v24+ / DSH `>= 0.2.1-rc.2`
> 协作主仓：[Soul-Charge/dsh-tiered-workflow](https://github.com/Soul-Charge/dsh-tiered-workflow)
> 接口标准：[docs/CONTRACT.md](CONTRACT.md)（`ExternalBackendAdapter` v1）

---

## 1. 目标与边界

本插件解决的核心问题：**当你在 DSH 和 Google Antigravity 之间双线高频工作时，让 DSH 能直接把任务派发到 Antigravity 开启持久化会话**，支持两种场景：

1. **作为执行后端（`run` 模式）**：无缝挂入 `dsh-tiered-workflow` 的角色池（例如将 `Planner-Deep`、`Reviewer` 或重型 `Worker` 路由到 `backend: 'antigravity'`），在 Antigravity 里跑完并返回结构化结果、`usage` 与 `conversation_id`，共享同一套 `plan.json`、门禁与 `workflow-metrics.jsonl`。
2. **作为人工交棒入口（`handoff` 模式）**：当 DSH 发现任务超出低预算单主力承载范围（例如适合切去 Antigravity 开 `/teamwork` 或 `/swarm`），一键在 Antigravity 创建带完整上下文的持久化会话，返回 `conversation_id` 与接管指令，由你在 Antigravity 里无缝接管。

### 明确不做（Scope 边界）
* ❌ 不探测或逆向 Antigravity 2.0 桌面 Electron App 的未公开本地端口/内部 RPC；100% 走官方公开 CLI 通道。
* ❌ 不内置工作流状态机、规划门禁、复审门禁或预设基座（归 `dsh-tiered-workflow`）。
* ❌ 不在 v0.1 引入 Python SDK 子进程栈或 `agy acp` 协议（`agy acp` 保留为 v0.2 内部升级路线，对外契约不变）。

---

## 2. 技术路线：方案 A（`agy` CLI Headless）

### 2.1 为什么选方案 A
1. **零额外语言栈**：DSH 运行于 Node.js，直接用 `node:child_process` 的 `spawn` 拉起 `agy`，无需维护 Python venv 或 sidecar 守护进程。
2. **官方原生齐备我们需要的全部能力**（来源：`https://antigravity.google/docs/cli/reference.md`）：
   * 非交互打印执行：`-p` / `--print` / `--prompt`
   * 结构化流式输出：`--output-format stream-json`（NDJSON，含进度、工具调用、token 消耗）与 `json`
   * 原生 Schema 约束：`--json-schema <string-or-file>`
   * 持久化会话续聊：`--conversation <id>`（以及 `-c` / `--continue`）
   * 多目录上下文：`--add-dir <path>`（可重复）
   * 超时与安全控制：`--print-timeout <duration>`、`--disable-slash-commands`
3. **未来升级无痛**：后续若升级为 `agy acp`（JSON-RPC over stdio，DSH 已内置 `@agentclientprotocol/sdk`），只需替换本插件内部 runner 模块，主插件 `dsh-tiered-workflow` 零改动。

### 2.2 模块划分（预期源码拓扑）

```text
dsh-antigravity-adapter/
├── package.json              # DSH 插件清单（type: module，声明 dsh.bundle.patch）
├── cordis.patch.yml          # 包内 bundle 注册行（- insert: [{ id: antigravity-adapter, name: dsh-antigravity-adapter }]）
├── src/
│   ├── index.js              # Cordis 插件入口（仅命名导出 name/inject/Config/apply，严禁 export default）
│   ├── adapter.js            # 实现 ExternalBackendAdapter v1，组装请求与模式分发（run / handoff）
│   ├── agy-runner.js         # 子进程生命周期管理（spawn、参数构造、超时、AbortSignal 杀进程树）
│   ├── ndjson-parser.js      # stream-json NDJSON 逐行解析器（提取 conversation_id / text / structured / 6 维 usage）
│   └── standalone-tool.js    # （可选）当未安装主框架时暴露独立工具 dispatch_antigravity，降级仍可用
└── test/
    └── run-tests.mjs         # 纯逻辑单测 + fake agy CLI 进程端到端冒烟测试
```

### 2.3 命令行参数组装与执行协议

> ⚠️ 以下部分 flag 的精确拼写（特别是模型选择、推理强度、审批模式与长 prompt 传参方式）**必须以第 4 节 A1–A3 本机实测结果为准**，禁止靠猜测硬编码。

1. **进程启动铁律（Windows 安全）**：
   * 一律使用 `spawn(agyBin, argv, { cwd, shell: false, windowsHide: true, env })`，**严禁 `shell: true` 拼接命令行字符串**（杜绝引号注入与 PowerShell/cmd 中文转义错乱）。
   * **大 Prompt 避坑**：Windows `CreateProcess` 命令行上限 32,767 字符。A3 探针需实测 `agy -p` 是否支持从 `stdin` 读取 prompt（如 `-p -` 或不带参数读 stdin）；若不支持，长 prompt 落临时文件至工作区 `temp/YYYYMMDD-agy-prompt-<id>.md` 并以短 prompt 指示 `agy` 读取，任务结束后清理或归档（遵守工作区 `%TEMP%` 铁律与删除降级链）。
   * **Schema 传参**：当 `req.outputSchema` 存在时，将 JSON Schema 序列化写入工作区 `temp/` 下的短生命周期 `.json` 文件，再通过 `--json-schema <path>` 传入，避免命令行转义问题。
2. **输出流解析（`ndjson-parser.js`）**：
   * `stdout` 按行切分（处理跨 chunk 拆行与 `\r\n`），逐行 `JSON.parse`；解析失败的非 JSON 行记入调试缓冲但不炸主流程。
   * `stderr` 单独收集（限最大字节数如 16 KB 环形截断），作为出错时的 `diagnostic`。
   * 从流事件中提取并映射：
     * `externalSessionId` ← Antigravity 返回的 `conversation_id`（精确字段名由 A2 实测确认）
     * `text` ← 最终助手文本输出（或增量拼接）
     * `structured` ← 当传入 `--json-schema` 时，解析并校验结构化 JSON 输出
     * `usage` ← 映射为 `ExternalUsage` 6 维互斥口径（拿不到的字段省略，不伪造 `0`）
     * 实时触发 `req.onProgress?.(...)`（包 `try/catch` 防回调抛错）
3. **取消与超时回收（Windows 进程树）**：
   * 监听 `req.signal` 与 `timeoutMs` 定时器；触发时标记 `aborted` / `timeout`。
   * Windows 下单纯 `child.kill()` 可能遗留孙进程，需按 `child.pid` 精确优雅终止（先 `SIGTERM`，宽限 2 秒后用 `taskkill /PID <pid> /T /F` 仅清理该子进程树，绝不按进程名批量杀）。
4. **`run` vs `handoff` 模式差异**：
   * **`run` 模式（`role: planner | reviewer | worker-low | worker-medium`）**：
     * 正常执行完整任务并等待进程退出，返回 `{ stopReason, externalSessionId, resumeHint, text, structured, usage, durationMs }`。
     * `resumeHint` 固定生成：`agy --conversation <externalSessionId>`（若 A4 确认桌面 App 侧栏可见，则追加提示“也可在 Antigravity 2.0 桌面端直接打开”）。
   * **`handoff` 模式（`role: 'handoff'`）**：
     * 目的不是让 Antigravity 一口气把巨型工程全改完，而是**建好带完整背景的持久化会话并交棒给用户**。
     * 提示词自动附加交棒前置说明：「你收到一份来自 DSH 的任务交接包。请先确认目标、读取列出的关键文件、给出简明接管确认与初步切入点，然后**停下来等待用户在 Antigravity 中给出下一步指令，不要执行任何写文件或修改操作**。」
     * 跑完首轮即拿到持久化 `externalSessionId` 与确认摘要，回传给 DSH 展示给用户，用户立即切换过去接手继续聊（如触发 `/teamwork` 或 `/swarm`）。

### 2.4 只读约束与权限边界（诚实声明）

* Antigravity CLI 是独立外部进程，DSH 的 `ctx.tools.guard` **无法拦截 `agy` 进程内部的写操作**。
* 因此当 `req.readonly === true` 时，本插件按以下三层保障处理：
  1. **首选**：通过 `agy` 官方的只读/规划模式 flag（由 A1 实测确认精确参数，如 `plan` 模式或只读权限配置）启动；
  2. **次选**：在 prompt 前置明确只读约束，同时对 `handoff`/`planner`/`reviewer` 角色默认传 `--disable-slash-commands` 防意外宏展开；
  3. **能力诚实声明**：若 A1 实测发现 `agy` Headless 模式没有进程级硬只读 flag，则 `capabilities.readonlyMode` 必须如实声明为 `false`（让主框架决定是降级放行 + 事后 `git status` 检查，还是仅把 Antigravity 用于非强只读角色）。

### 2.5 双重注册（主框架模式 + 独立可用模式）

1. **接入 `dsh-tiered-workflow`（主模式）**：通过 `ctx.inject(['tieredWorkflow'], ...)` 注册 `ExternalBackendAdapter`（`id: 'antigravity'`）。
2. **可选独立工具**：配置项 `registerStandaloneTool: boolean`（默认 `false`；若未装 `dsh-tiered-workflow` 或用户手动开启，则直接注册工具 `dispatch_antigravity({ prompt, mode: 'run' | 'handoff', conversationId?, readonly? })`），使本插件即使单独安装也能发挥价值。

---

## 3. 配置 Schema（schemastery `Config`）

配置落点位于 profile `cordis.patch.yml` 的 `- id: antigravity-adapter` 行（`.volatile()` 叶子支持热更新）：

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `agyPath` | `string` | `'agy'` | `agy` 可执行文件路径（不在 PATH 时可填 `%LOCALAPPDATA%/agy/bin/agy.exe` 绝对路径） |
| `defaultTimeoutMs` | `number` | `300000` | 单次执行超时上限（5 分钟） |
| `defaultApprovalMode` | `string` | `''` | 默认审批/执行模式（具体枚举值按 A1 实测锁定） |
| `readonlyApprovalMode` | `string` | `''` | `req.readonly === true` 时使用的模式（按 A1 实测锁定） |
| `defaultModel` | `string` | `''` | 未由主框架指定 `model` 时的兜底模型（空表示用 `agy` 自身默认） |
| `disableSlashCommands` | `boolean` | `true` | Headless 模式下默认关闭斜杠命令展开防误触发 |
| `registerStandaloneTool` | `boolean` | `false` | 是否额外注册独立工具 `dispatch_antigravity` |
| `debugLog` | `string` | `''` | 调试日志路径（不记密钥、不记大段 prompt 正文） |

---

## 4. 开工前必跑的实机微探针（A1–A4）

> **当前环境状态（2026-11-25 实测）**：本机尚未安装 `agy` CLI（`Get-Command agy` 与 `$env:LOCALAPPDATA\agy\bin\agy.exe` 均为空）。

接手开发的新会话**开工写代码前**必须按顺序完成以下 4 项探针，并把结果记录到本仓库 `docs/PROBES.md`：

1. **安装与鉴权确认**：
   * 提示用户在终端安装官方 CLI：`irm https://antigravity.google/install.ps1 | iex`（必要时将 `$env:LOCALAPPDATA\agy\bin` 加入用户 PATH），然后运行 `agy` 完成 Google 账号登录。
2. **A1 · 精确 CLI Flag 核查**：
   * 运行 `agy --version` 与 `agy --help`；
   * 核实并固化精确参数名：非交互打印、输出格式、JSON Schema、续聊 ID、模型选择、推理强度、审批/只读模式、是否支持从 `stdin` 读长 prompt。
3. **A2 · `stream-json` 真实 NDJSON 结构取样**：
   * 运行最小无害调用：`agy -p "只回复 OK，不要调用工具" --output-format stream-json`；
   * 记录真实 NDJSON 行样本，确认 `conversation_id`、文本块、结束状态、以及 `usage`（含缓存字段）的确切键名。
4. **A3 · `--json-schema` + `--conversation <id>` 续聊实测**：
   * 第 1 轮带 `--json-schema` 输出结构化 JSON 并拿到 `conversation_id`；
   * 第 2 轮带 `--conversation <id>` 追问上一轮内容，确认上下文连续性与 schema 约束是否同时生效；
   * 测一次 >10 KB prompt 验证传参上限与 stdin 方案。
5. **A4 · Antigravity 2.0 桌面 App 会话同步可见性**：
   * 核实由 `agy -p` 创建的持久化会话是否自动出现在 Antigravity 2.0 桌面端左侧会话列表，据此确定 `resumeHint` 文案与 `handoff` 体验。

---

## 5. DSH 插件开发硬坑备忘（务必遵守）

1. **严禁 `export default` 顶掉 `Config`**：DSH 的 `cordis-plugin-loader` 会做 `exports = exports.default ?? exports`；`src/index.js` 只使用命名导出（`export const name`, `export const inject`, `export const Config`, `export function apply`）。
2. **`@deepseek-ai/schemastery` 目录联接**：新仓库不提交 `node_modules/`，本地验证与部署前需建立目录联接指向宿主 `schemastery`：
   ```powershell
   New-Item -ItemType Directory -Force 'F:/AiHarness/projects/dsh-antigravity-adapter/node_modules/@deepseek-ai'
   New-Item -ItemType Junction `
     -Path 'F:/AiHarness/projects/dsh-antigravity-adapter/node_modules/@deepseek-ai/schemastery' `
     -Target 'C:/Program Files/nvm/v24.18.1/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/schemastery'
   ```
3. **Format v4 消息源红线**：若向 DSH 会话注入任何消息，**严禁 `source.kind === "plugin"`**（Format v4 会抛 `SessionFormatError`），必须使用专属 `source.kind`（如 `'dsh-antigravity-adapter-notice'`）。
4. **安装与登记纪律**：装进 `F:/AiHarness/.dsh/profiles/web` 前必须遵守 `F:/AiHarness/AGENTS.md` §5/§6——装前记 11 个已补丁包 md5 基线、`link:` 用 Windows 绝对路径、装后逐包复核无补丁丢失、更新 `F:/AiHarness/dsh/plugins/` 档案、由用户批准重启 `dsh web`。
5. **版本提交规范**：`<x.x.n>-<type>: <title>`，非功能性修改只在 `n` 位累加。

---

## 6. 分阶段落地与验收标准

* **M1（探针 + 核心 Runner + 纯逻辑单测）**：跑通 A1–A4 并记录 `docs/PROBES.md`；实现 `ndjson-parser.js` 与 `agy-runner.js`；编写 fake-agy 模拟脚本覆盖正常返回、JSON Schema 校验、续聊、超时强杀进程树、`AbortSignal` 取消、非零退出与非法 JSON 容错，全部单测绿灯。
* **M2（适配器契约 + 独立模式）**：实现 `adapter.js` 与 `src/index.js`；用最小 Cordis 测试验证：未安装 `tieredWorkflow` 时不卡 PENDING、挂载 mock `tieredWorkflow` 时正常注册与反注册、返回结构严格符合 `docs/CONTRACT.md` v1。
* **M3（真机联调与安装）**：在真实 `agy` 下完成 `run`（单轮 + 续聊）与 `handoff` 端到端实测（含真实 token 统计核对）；按 §5/§6 规范装入 DSH `web` profile 并与 `dsh-tiered-workflow` 联调验收。
