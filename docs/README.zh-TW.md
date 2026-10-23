# my-ai-free-model

一個本機端點、一個模型名稱 —— `free-model` —— 在背後替你的程式開發 Agent 於多個免費 LLM 服務之間自動路由，某個服務被限流時自動換下一個。

[English](../README.md) | 繁體中文（台灣） | [繁體中文（香港／廣東話）](./README.zh-HK.md) | [简体中文](./README.zh-CN.md)

> **狀態：🚧 開發中。** 各服務的存取已驗證（步驟 1），路由器與伺服器尚未完成。標示 *（規劃中）* 的內容是設計，不是已完成的功能。

## 為什麼做這個

免費 LLM 額度看起來很棒，實際用起來很煩：

- **限流會讓你做到一半中斷。** 每個服務在不同時間回 429，每日上限也各不相同。
- **免費清單一直在變。** 模型會出現、過期（部分免費模型有 `expiration_date`）或改名。
- **每個服務都有各自的 base URL、金鑰與模型 ID。** 你的 Agent 不應該需要關心這些。

把相容 OpenAI 或 Anthropic 格式的用戶端（OpenCode、Cline、Cursor、Claude Code……）指向 `localhost`，要求 `free-model` 即可。代理會挑選目前可用的免費模型，某個服務失敗就換下一個。

## 運作方式 *（規劃中）*

```
你的用戶端（model: free-model）
        │
        ▼
 server.js  (127.0.0.1:4570)
   ├─ POST /v1/chat/completions   OpenAI 格式，支援串流與 tool calling
   ├─ POST /v1/messages           Anthropic 格式（自動轉換）
   ├─ GET  /v1/models             只列出 "free-model"
   └─ GET  /status                各路線延遲與冷卻狀態
        │
        ▼
 router.js  → 優先最快的可用路線，失敗即冷卻
        │
        ▼
 providers/  kilo · openrouter · nvidia · amd · opencode-cli
```

## 服務一覽

| 服務 | 金鑰 | 如何挑選免費模型 | 已知限制 | 驗證結果（2026-10-23） |
| --- | --- | --- | --- | --- |
| Kilo | 不需要 | `isFree` 標記 ＋ 支援 tools ＋ 未過期 | 上游可能記錄 prompt（Kilo 模型卡有註明） | ✅ 清單、對話 |
| OpenRouter | `OPENROUTER_API_KEY` | 支援 tools 的 `:free` 模型 | 免費模型每日 50 次，儲值 $10 以上為 1000 次（依 omfm 文件，未重測） | ✅ 清單、對話 |
| NVIDIA | `NVIDIA_API_KEY` | 手動白名單（清單沒有免費標記） | 每個模型各有速率限制 | ✅ 清單 · ⏳ 對話 |
| AMD | `AMD_API_KEY` | 手動白名單（DeepSeek / MiMo / GLM / Qwen3.8） | 每日 1.0 pt（點數是用量，不是費用），每分鐘 20 次 | ✅ 清單、對話 |
| OpenCode CLI | 不需要 | 已安裝的 `opencode` CLI 所提供的模型 | 最後備援，僅純文字 | ⏳ |

**關於 OpenCode：** 其閘道會拒絕直接以 HTTP 呼叫免費額度（`FreeTierError: can only be used from within OpenCode`）。本專案不會偽裝成 OpenCode 用戶端，唯一的 OpenCode 路線是呼叫真正的 CLI 作為備援。

## 路由規則 *（規劃中）*

- **順序：** 延遲最低者優先。尚無量測資料時：Kilo → OpenRouter → NVIDIA → AMD → OpenCode CLI。
- **同一模型出現在多個閘道** 只算一條路線，避免連續打到同一個後端。
- **Context 檢查：** context 視窗小於 prompt 的路線會被略過。
- **只在輸出第一個位元組之前換路線。** 串流途中失敗會直接回報，不會默默重試（避免內容重複）。

| 事件 | 處理 |
| --- | --- |
| 429 / 402 | 冷卻 10 分鐘，重複發生則加倍，上限 2 小時；偵測到每日額度用盡則冷卻到重置時間 |
| 5xx / 逾時 | 冷卻 2 分鐘，改試下一條路線 |
| 401 / 403 | 停用該服務（金鑰有問題）並在日誌提示 |
| 404 model | 將該模型移出池 |
| 全部失敗 | 回傳 503，並列出每條路線的失敗原因 |

## 安裝設定

需要 Node.js 18 以上。零相依套件，不需建置。

```bash
git clone https://github.com/<your-user>/my-ai-free-model.git
cd my-ai-free-model
cp .env.example .env      # 然後填入你的金鑰
```

`.env`：

```dotenv
PORT=4570
OPENROUTER_API_KEY=
NVIDIA_API_KEY=
AMD_API_KEY=
```

取得金鑰：[openrouter.ai](https://openrouter.ai) → Keys · [build.nvidia.com](https://build.nvidia.com) → Get API Key · [developer.amd.com.cn/radeon/profile](https://developer.amd.com.cn/radeon/profile)。Kilo 不需要金鑰。沒有填金鑰的服務會被直接略過。

檢查金鑰是否可用（已可使用）：

```bash
./scripts/probe-providers.sh >> data/probe-result.txt
tail -40 data/probe-result.txt
```

### 使用方式 *（規劃中，步驟 3 起）*

```bash
node server.js

curl http://localhost:4570/v1/models
curl -X POST http://localhost:4570/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"free-model","messages":[{"role":"user","content":"用中文說你好"}]}'
```

用戶端：base URL 設為 `http://localhost:4570/v1`，模型設為 `free-model`。Claude Code *（規劃中，步驟 4）*：`ANTHROPIC_BASE_URL=http://localhost:4570`。

## 開發進度

- [x] 0. 專案骨架
- [x] 1. 驗證 Kilo、OpenRouter、NVIDIA、AMD 的存取
- [ ] 2. 各服務模型探索與過濾
- [ ] 3. 路由器（延遲、冷卻、去重）與相容 OpenAI 的伺服器
- [ ] 4. 相容 Anthropic 的 `/v1/messages`
- [ ] 5. OpenCode CLI 備援

## 隱私與合理使用

- 你的 prompt 會送往實際處理請求的免費服務。**免費池可能記錄 prompt**（Kilo 在模型卡上有說明），請勿傳送機密或敏感程式碼。
- 金鑰只存在本機 `.env`（已被 git 忽略），不會寫入日誌。伺服器只綁定 `127.0.0.1`。
- 你需遵守各服務的條款。免費額度隨時可能調整或取消。

## 致謝

構想參考自 [oh-my-free-models](https://github.com/hakilee/oh-my-free-models)（延遲路由、10 分鐘冷卻，MIT）與 [opencode-bridge](https://github.com/328336690/opencode-bridge)（將 OpenCode CLI 包成相容 OpenAI 的 API）。本專案未複製其程式碼；若日後引用，會保留原授權聲明。

## 授權

MIT，詳見 [LICENSE](../LICENSE)。
