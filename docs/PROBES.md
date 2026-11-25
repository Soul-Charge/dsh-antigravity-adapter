# A1–A4 实机探针记录（`agy` CLI v1.5.16）

> 实测日期：2026-11-25 · 环境：Windows 11 / Node `v24.18.1` / `agy.exe` `v1.5.16`
> 二进制路径：`C:\Users\NaE\AppData\Local\agy\bin\agy.exe`（已在 User PATH 中；官方安装脚本 URL 为 `https://antigravity.google/cli/install.ps1`，注意 `DESIGN.md` 原文漏写了 `/cli/`）
> 鉴权状态：安装后直接复用本机 Antigravity 凭据，无需重复登录。

---

## A1 · 精确 CLI Flag 与执行模式核查

来源：`agy --version`（`1.5.16`）、`agy --help`、`agy models` 与官方 `headless.md` / `permissions.md`：

| 能力 | 精确 Flag / 参数 | 实测结论与注意事项 |
|---|---|---|
| 非交互单轮执行 | `-p` / `--print` / `--prompt <text>` | `-p` 必须显式跟值，否则会把后续 flag 吞作 prompt（退出码 `2`）；空字符串 `""` 报错 `empty prompt` |
| 流式标准输入（绕过 Windows 32 KB 命令行上限） | `--input-format stream-json --output-format stream-json` | **最佳传参方案**：向 `stdin` 写入一行 `{"event":"user","message":{"content":"..."}}` 后关闭 `stdin`；实测 >12 KB 中文+填充 prompt 与 `--conversation` + `--json-schema` 组合全部一次通过（exit 0） |
| 结构化流输出 | `--output-format stream-json` | NDJSON，每行一个 JSON 对象（`init` / `step_update` / `result`） |
| JSON Schema 约束 | `--json-schema <string-or-file>` | 支持文件路径；在 `stream-json` 下应用于终态 `result` 事件，直接返回已解析对象 `result.structured_output` |
| 持久化续聊 | `--conversation <id>`（别名 `-r` / `--resume`） | 传入上轮 `conversation_id` 即可恢复上下文 |
| 多目录上下文 | `--add-dir <path>` | 可重复传入 |
| 模型与推理强度 | `--model <slug>`、`--effort <low\|medium\|high\|xhigh\|max>` | 可用 slug 由 `agy models` 列出（如 `gemini-4-neon-high`、`claude-sonnet-5-5-high` 等） |
| 超时控制 | `--print-timeout <duration>` | Go duration 格式（如 `300s`、`5m`）；适配器内部仍保留外层超时 + 进程树强杀双保险 |
| 禁止斜杠命令展开 | `--disable-slash-commands` | **实测冲突坑**：与 `--mode plan` 同时传入时 `stderr` 告警 `warning: --mode plan has no effect while slash command expansion is disabled.`，且 `plan` 不生效。仅在未指定 `--mode plan` 时传入 |
| 执行模式 | `--mode <accept-edits\|auto\|plan>` | `plan` 只是前置 `/plan` 系统指令（`init.expanded_commands: [{"name":"plan","type":"system"}]`），`permission_mode` 仍为 `request-review`，**本身不构成硬只读** |
| 全量跳过审批 | `--dangerously-skip-permissions` | `init.permission_mode` 变为 `always-proceed`；`readonly: true` 时**严禁传入** |
| 会话级临时权限配置 | `--settings <json-or-file>` | **实测进程级硬只读方案**：传入 `{"agentMode":"","toolPermission":"request-review","permissions":{"deny":["write_file(*)","command(*)"]}}`（Deny > Ask > Allow，覆盖任何模式与全局 allow 规则） |

---

## A2 · `stream-json` 真实 NDJSON 结构取样

### 1. 纯文本单轮样本

```json
{"event":"init","conversation_id":"24f55d64-937a-4859-a635-6fff61d86b14","init":{"cwd":"F:\\AiHarness","tools":["..."],"permission_mode":"request-review"}}
{"event":"step_update","step_update":{"conversation_id":"24f55d64-937a-4859-a635-6fff61d86b14","step_index":0,"state":"DONE","step_type":"user_input"}}
{"event":"step_update","step_update":{"conversation_id":"24f55d64-937a-4859-a635-6fff61d86b14","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"OK"}}
{"event":"step_update","step_update":{"conversation_id":"24f55d64-937a-4859-a635-6fff61d86b14","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"\n","duration_seconds":3.8119548,"usage":{"input_tokens":17656,"output_tokens":41,"thinking_tokens":39,"cache_read_tokens":0,"total_tokens":17697}}}
{"event":"result","result":{"conversation_id":"24f55d64-937a-4859-a635-6fff61d86b14","status":"SUCCESS","response":"OK\n","duration_seconds":3.8585526,"num_turns":1,"usage":{"input_tokens":17656,"output_tokens":41,"thinking_tokens":39,"cache_read_tokens":0,"total_tokens":17697}}}
```

### 2. 工具调用样本（`step_type: "tool"`）

```json
{"event":"step_update","step_update":{"conversation_id":"9e318465-8e27-4c85-848a-019fc15697f3","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"..."}}}}
{"event":"step_update","step_update":{"conversation_id":"9e318465-8e27-4c85-848a-019fc15697f3","step_index":2,"state":"DONE","step_type":"tool","tool_name":"run_command","duration_seconds":1.7591034,"tool_info":{"name":"run_command","parameters":{"CommandLine":"..."},"output":"..."}}}
```

工具失败时 `state` 为 `"ERROR"`，`tool_info.error` 含 `{ "type": "TOOL_ERROR", "message": "..." }`。

### 3. Token 统计口径关键发现（防止续聊双倍计费）

1. **互斥口径**：`agy` 的 `input_tokens` **本身就是未缓存输入**，与 `cache_read_tokens` 互斥（Turn 2 实测：`input_tokens: 2513`, `cache_read_tokens: 17747`, `output_tokens: 151`, `thinking_tokens: 126`, `total_tokens: 2664 = 2513 + 151`）。`agy` 不产出 `cache_write_tokens`，因此映射后省略该字段，不伪造 `0`。
2. **`result.usage` 与 `result.duration_seconds` 是跨轮次累计值**：
   - Turn 1（`step_index: 1`）：`input_tokens=17746, output_tokens=2193, thinking_tokens=2168, cache_read_tokens=0, total_tokens=19939`
   - Turn 2（`--conversation` 续聊，本次仅执行 `step_index: 5`）：`step_update.usage` 为 `input_tokens=2513, cache_read_tokens=17747, output_tokens=151`，而 `result.usage` 为 `input_tokens=20259 (=17746+2513)`、`duration_seconds=34.82`（含轮间等待）。
   - 多步工具调用单轮（Probe 4，`step_index: 1` + `step_index: 3`）：两步 `step_update.usage` 之和与单轮 `result.usage` 逐字段精确相等。
   - **因此适配器实现采用**：按本次进程内观测到的 `step_update`（按 `step_index` 去重取最后一次 `usage`）求和作为本轮 `ExternalUsage`，仅当本次流无任何 `step_update.usage` 且 `num_turns <= 1` 时回退 `result.usage`；`durationMs` 由适配器本地计时，不采用累计的 `result.duration_seconds`。

---

## A3 · 结构化输出、续聊、超长输入与只读硬约束实测

1. **`--json-schema` + `--conversation` 连续三轮实测**（会话 `1055be33-f7b8-4447-acef-fb4054d1e145`）：
   - Turn 1：记住暗号 `FOX-42`，返回 `structured_output: {"code":"FOX-42","sum":42}`（exit 0）。
   - Turn 2（`--conversation`）：正确回忆暗号，返回 `structured_output: {"code":"FOX-42","sum":84}`（exit 0）。
   - Turn 3（`--conversation` + `--input-format stream-json` + `--json-schema`）：返回 `structured_output: {"code":"FOX-42","sum":99}`（exit 0）。
2. **>12 KB 超长 Prompt（`--input-format stream-json`）**：
   - 经 `stdin` 传入 12 KB+ JSON 消息 `{"event":"user","message":{"content":"..."}}`，正常返回 `STREAM_IN_OK`（exit 0，耗时 4.28s），彻底规避 Windows 32,767 字符命令行上限，也无需把 prompt 落临时文件。
3. **进程级硬只读实测（`--settings` + `permissions.deny`）**：
   - 传入 `--settings`（内容：`{"agentMode":"","toolPermission":"request-review","permissions":{"deny":["write_file(*)","command(*)"]}}`），要求同时执行 `write_file`（写 `should-not-exist.txt`）与 `read_file`（读 `.gitignore` 第 1 行）。
   - 结果：`write_file` 被权限引擎硬拦截（`Permission denied for write_file(...). Matches user-configured deny rule.`，`should-not-exist.txt` 未创建）；`read_file` 正常成功返回 `node_modules/`。
   - **能力结论**：`capabilities.readonlyMode` 可诚实声明为 **`true`**（由 `--settings` 进程级 `deny` 规则 + 只读前置指令双层保障，且 `readonly: true` 时强制禁止 `--dangerously-skip-permissions` 与写入型 `--mode`）。

---

## A4 · Antigravity 2.0 桌面 App 会话可见性核查

* 实测发现存储目录分离：
  * Antigravity 2.0 桌面端：`%USERPROFILE%\.gemini\antigravity\{brain,conversations}`
  * Antigravity CLI（`agy`）：`%USERPROFILE%\.gemini\antigravity-cli\{brain,conversations}`
* 由 `agy` 创建的会话（如 `24f55d64-937a-4859-a635-6fff61d86b14`）存储在 `antigravity-cli` 下，**不会自动出现在 Antigravity 2.0 桌面端左侧会话列表**。
* **落地策略**：`resumeHint` 诚实生成终端接管命令 `agy --conversation <externalSessionId>`（不附加“桌面端可见”的虚假提示）。
