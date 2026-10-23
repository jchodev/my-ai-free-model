# my-ai-free-model

一个本机端点、一个模型名称 —— `free-model` —— 在后台替你的编程 Agent 在多个免费 LLM 服务之间自动路由，某个服务被限流时自动切换到下一个。

[English](../README.md) | [繁體中文（台灣）](./README.zh-TW.md) | [繁體中文（香港／廣東話）](./README.zh-HK.md) | 简体中文

> **状态：✅ 可使用。** 步骤 0–4 已完成：服务发现、带故障切换与冷却的路由器、兼容 OpenAI 的 `/v1/chat/completions`，以及兼容 Anthropic 的 `/v1/messages`（已用 curl 和 Claude Code 测试）。步骤 5（OpenCode CLI 后备）暂时跳过。

## 为什么做这个

免费 LLM 额度看起来很美，实际用起来很烦：

- **限流会让你做到一半中断。** 每个服务在不同时间返回 429，每日上限也各不相同。
- **免费列表一直在变。** 模型会出现、过期（部分免费模型带有 `expiration_date`）或改名。
- **每个服务都有各自的 base URL、密钥和模型 ID。** 你的 Agent 不应该关心这些。

把兼容 OpenAI 或 Anthropic 格式的客户端（OpenCode、Cline、Cursor、Claude Code……）指向 `localhost`，请求 `free-model` 即可。代理会挑选当前可用的免费模型，某个服务失败就换下一个。

## 工作方式

```
你的客户端（model: free-model）
        │
        ▼
 server.js  (127.0.0.1:4570)
   ├─ POST /v1/chat/completions   OpenAI 格式，支持流式与 tool calling
   ├─ POST /v1/messages           Anthropic 格式（自动转换）
   ├─ GET  /v1/models             列出 "free-model" 及各分组
   └─ GET  /status                各路线延迟与冷却状态
        │
        ▼
 router.js  → 优先最快的可用路线，失败即冷却
        │
        ▼
 providers/  kilo · openrouter · nvidia · amd · opencode-cli
```

## 服务一览

| 服务 | 密钥 | 如何挑选免费模型 | 已知限制 | 验证结果（2026-10-23） |
| --- | --- | --- | --- | --- |
| Kilo | 不需要 | `isFree` 标记 ＋ 支持 tools ＋ 未过期 | 上游可能记录 prompt（Kilo 模型卡有注明） | ✅ 列表、对话 |
| OpenRouter | `OPENROUTER_API_KEY` | 支持 tools 的 `:free` 模型 | 免费模型每日 50 次，充值 $10 以上为 1000 次（来自 omfm 文档，未重测） | ✅ 列表、对话 |
| NVIDIA | `NVIDIA_API_KEY` | 手动白名单（列表没有免费标记） | 每个模型各有速率限制 | ✅ 列表 · ⏳ 对话 |
| AMD | `AMD_API_KEY` | 手动白名单（DeepSeek / MiMo / GLM / Qwen3.8） | 每日 1.0 pt（点数是用量，不是费用），每分钟 20 次 | ✅ 列表、对话 |
| OpenCode CLI | 不需要 | 已安装的 `opencode` CLI 提供的模型 | 最后备援，仅纯文本 | ⏭ |

**关于 OpenCode：** 其网关会拒绝直接以 HTTP 调用免费额度（`FreeTierError: can only be used from within OpenCode`）。本项目不会伪装成 OpenCode 客户端，唯一的 OpenCode 路线是调用真正的 CLI 作为备援。

## 路由规则

- **顺序：** 延迟最低者优先。尚无测量数据时：Kilo → OpenRouter → NVIDIA → AMD → OpenCode CLI。
- **同一模型出现在多个网关** 只算一条路线，避免连续打到同一个后端。
- **Context 检查：** context 窗口小于 prompt 的路线会被跳过。
- **只在输出第一个字节之前切换路线。** 流式途中失败会直接报错，不会悄悄重试（避免内容重复）。

| 事件 | 处理 |
| --- | --- |
| 429 / 402 | 冷却 10 分钟，重复发生则加倍，上限 2 小时；检测到每日额度用尽则冷却到重置时间 |
| 5xx / 超时 | 冷却 2 分钟，改试下一条路线 |
| 401 / 403 | 停用该服务（密钥有问题）并在日志中提示 |
| 404 model | 将该模型移出池 |
| 全部失败 | 返回 503，并列出每条路线的失败原因 |

## 安装配置

需要 Node.js 18 以上。零依赖，无需构建。

```bash
git clone https://github.com/<your-user>/my-ai-free-model.git
cd my-ai-free-model
cp .env.example .env      # 然后填入你的密钥
```

`.env`：

```dotenv
PORT=4570
OPENROUTER_API_KEY=
NVIDIA_API_KEY=
AMD_API_KEY=
```

获取密钥：[openrouter.ai](https://openrouter.ai) → Keys · [build.nvidia.com](https://build.nvidia.com) → Get API Key · [developer.amd.com.cn/radeon/profile](https://developer.amd.com.cn/radeon/profile)。Kilo 不需要密钥。没有填密钥的服务会被直接跳过。

检查密钥是否可用（已可使用）：

```bash
./scripts/probe-providers.sh >> data/probe-result.txt
tail -40 data/probe-result.txt
```

### 使用方式

```bash
node server.js

curl http://localhost:4570/v1/models
curl -X POST http://localhost:4570/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"free-model","messages":[{"role":"user","content":"用中文说你好"}]}'
```

客户端：base URL 设为 `http://localhost:4570/v1`，模型设为 `free-model`。Claude Code：`ANTHROPIC_BASE_URL=http://localhost:4570`。

## 模型分组

用模型名称指定分组，路由器就只会在该组内选择路线和切换路线。空的分组会退回整个池，所以配置写错也不会让服务停摆。

| 模型名称 | 适合用途 | 对应工作流角色 |
| --- | --- | --- |
| `free-model` | 任何用途，或不确定时 | — |
| `free-model-thinking` | 规划、需求、设计、代码评审、编写测试计划 | **PM**、架构师、**QA**（测试设计与评审） |
| `free-model-coder` | 写代码、改代码、大量使用工具的 Agent 循环 | **Developer（开发）** |
| `free-model-fast` | 短而快的任务：摘要、commit 信息、简单修改、QA 冒烟检查 | 辅助 Agent、**QA**（快速检查） |

分组成员写在 `pool.config.json` 的 `groups`（按标准化模型名称做子串匹配）。默认列表依据实测延迟、reasoning 标记和模型名称建立，**没有做过质量评测**。运行 `npm run pool` 可以看到各组有哪些路线，欢迎自行调整。

### 示例

Claude Code，一个工具使用三个档位：

```bash
export ANTHROPIC_BASE_URL=http://localhost:4570
export ANTHROPIC_AUTH_TOKEN=free-model-local   # 任意非空字符串；服务器只监听 localhost
export ANTHROPIC_API_KEY=
export ANTHROPIC_DEFAULT_OPUS_MODEL=free-model-thinking
export ANTHROPIC_DEFAULT_SONNET_MODEL=free-model-coder
export ANTHROPIC_DEFAULT_HAIKU_MODEL=free-model-fast
claude
```

任何兼容 OpenAI 的客户端（OpenCode、Cline、Cursor…）：base URL 填 `http://localhost:4570/v1`，API 密钥填任意非空字符串，模型填 `free-model-coder`（或表中其他名称）。

```bash
curl http://localhost:4570/v1/chat/completions -H "Content-Type: application/json" \
  -d '{"model":"free-model-thinking","messages":[{"role":"user","content":"帮登录表单写一份测试计划"}]}'
```

### 不支持的项目

- **不支持视频输入和音频输入。** 部分免费模型虽然接受，但本代理不会转发。
- **图片输入** 只会发往标记为 `vision` 的路线，其余路线仅支持文本。
- 各模型的 context 窗口不同（65K 到 1M tokens），小于 prompt 的路线会被跳过。

## 开发进度

- [x] 0. 项目骨架
- [x] 1. 验证 Kilo、OpenRouter、NVIDIA、AMD 的访问
- [x] 2. 各服务模型发现与过滤
- [x] 3. 路由器（延迟、冷却、去重）与兼容 OpenAI 的服务器
- [x] 4. 兼容 Anthropic 的 `/v1/messages`
- [ ] 5. OpenCode CLI 备援 （暂时跳过，可选）

## 隐私与合理使用

- 你的 prompt 会发往实际处理请求的免费服务。**免费池可能记录 prompt**（Kilo 在模型卡上有说明），请勿发送机密或敏感代码。
- 密钥只存在本机 `.env`（已被 git 忽略），不会写入日志。服务器只绑定 `127.0.0.1`。
- 你需要遵守各服务的条款。免费额度随时可能调整或取消。

## 致谢

思路参考自 [oh-my-free-models](https://github.com/hakilee/oh-my-free-models)（延迟路由、10 分钟冷却，MIT）和 [opencode-bridge](https://github.com/328336690/opencode-bridge)（将 OpenCode CLI 包装成兼容 OpenAI 的 API）。本项目未复制其代码；若日后引用，会保留原许可声明。

## 许可证

MIT，详见 [LICENSE](../LICENSE)。
