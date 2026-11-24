# dsh-antigravity-adapter

DSH 插件：通过 **Antigravity CLI（`agy` Headless，方案 A）** 将 DSH 的任务请求派发至 Google Antigravity 开启持久化会话（支持结构化执行拿回结果，以及向 Antigravity 交棒供人工接管），并作为可热插拔外部后端接入 [dsh-tiered-workflow](https://github.com/Soul-Charge/dsh-tiered-workflow)。

> 当前状态：**设计定稿期（仅文档，尚未编码）** · 技术路线：**方案 A（`agy` CLI Headless）**

## 文档索引

* [docs/DESIGN.md](docs/DESIGN.md) — 完整架构设计、方案 A（`agy` CLI）封装协议、Windows 避坑、A1–A4 开工前实测探针与分阶段验收标准
* [docs/CONTRACT.md](docs/CONTRACT.md) — 与主框架 `dsh-tiered-workflow` 对齐的 `ExternalBackendAdapter`（v1）接口契约（双仓同步标准）

## 定位与职责边界

* **本插件负责**：封装 `agy` CLI 子进程调用（`-p` / `--output-format stream-json` / `--json-schema` / `--conversation <id>`）、解析 NDJSON 实时流与 token 消耗、生命周期取消与超时回收、健康检查、以及向 DSH / `dsh-tiered-workflow` 注册 `antigravity` 执行后端。
* **本插件不负责**：工作流三轨分诊、状态机、规划/熔断/复审门禁、预设基座（这些归主插件 `dsh-tiered-workflow` 统一管理）。

## 开工第一步（给接手开发的会话）

1. 先阅读 [docs/DESIGN.md](docs/DESIGN.md) 与 [docs/CONTRACT.md](docs/CONTRACT.md)；
2. 确认本机已安装并登录官方 `agy` CLI（详见 `docs/DESIGN.md` 第 4 节）；
3. 跑完 **A1–A4 微探针**，将真实 `agy` flag 与 `stream-json` NDJSON 结构核实固化后再开始编码。

## 提交规范

沿用 `<x.x.n>-<type>: <title>` 格式；非功能性改动只在补丁位 `n` 累加（如 `0.1.0-docs:`、`0.1.1-docs:`），功能性里程碑再进次版本位。

## License

MIT
