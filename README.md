# my-ai-free-model

One local endpoint, one model name — `free-model` — that quietly routes your coding agent across free LLM providers and fails over when one of them is rate-limited.

English | [繁體中文（台灣）](./docs/README.zh-TW.md) | [繁體中文（香港／廣東話）](./docs/README.zh-HK.md) | [简体中文](./docs/README.zh-CN.md)

> **Status: 🚧 work in progress.** Provider access has been verified (step 1). The router and server are not built yet. Anything marked *(planned)* describes the design, not shipped behavior.

## Why this exists

Free LLM tiers are great on paper and annoying in practice:

- **Rate limits stop you mid-task.** Each provider returns 429 at a different moment, with different daily caps.
- **The free catalog churns.** Models appear, expire (some free models have an `expiration_date`) or get renamed.
- **Every provider has its own base URL, key and model IDs.** Your agent should not care.

You point OpenAI- or Anthropic-compatible clients (OpenCode, Cline, Cursor, Claude Code…) at `localhost` and ask for `free-model`. The proxy picks a live free model, and moves on to the next one when a provider fails.

## How it works *(planned)*

```
Your client (model: free-model)
        │
        ▼
 server.js  (127.0.0.1:4570)
   ├─ POST /v1/chat/completions   OpenAI format, streaming + tool calling
   ├─ POST /v1/messages           Anthropic format (translated)
   ├─ GET  /v1/models             lists "free-model" and its groups
   └─ GET  /status                per-route latency and cooldown
        │
        ▼
 router.js  → fastest live route first, cooldown on failure
        │
        ▼
 providers/  kilo · openrouter · nvidia · amd · opencode-cli
```

## Providers

| Provider | Key | How free models are chosen | Known limits | Verified (2026-10-23) |
| --- | --- | --- | --- | --- |
| Kilo | none | `isFree` flag + supports tools + not expired | Upstream may log prompts (stated on Kilo's model cards) | ✅ list, chat |
| OpenRouter | `OPENROUTER_API_KEY` | `:free` IDs that support tools | Free models: 50 requests/day, 1000/day with ≥ $10 credits (per the omfm docs, not re-tested) | ✅ list, chat |
| NVIDIA | `NVIDIA_API_KEY` | Manual allowlist (the model list has no free flag) | Per-model rate limits | ✅ list · ⏳ chat |
| AMD | `AMD_API_KEY` | Manual allowlist (DeepSeek / MiMo / GLM / Qwen3.8) | 1.0 pt/day (points are usage, not charges), 20 requests/min | ✅ list, chat |
| OpenCode CLI | none | Models offered by the installed `opencode` CLI | Last-resort fallback, plain text only | ⏳ |

**About OpenCode:** its gateway rejects direct HTTP calls to the free tier (`FreeTierError: can only be used from within OpenCode`). This project does not imitate OpenCode's client. The only OpenCode route is the real CLI, as a fallback.

## Routing rules *(planned)*

- **Order:** lowest measured latency first. Before any measurement exists: Kilo → OpenRouter → NVIDIA → AMD → OpenCode CLI.
- **Same model on several gateways** counts as one route, so one backend is not tried three times in a row.
- **Context check:** routes whose context window is smaller than the prompt are skipped.
- **Failover only before the first byte** is streamed. A failure mid-stream is reported, never silently retried (to avoid duplicated output).

| Event | Action |
| --- | --- |
| 429 / 402 | Cooldown 10 min, doubling on repeats up to 2 h. Daily-quota errors cool down until the reset time |
| 5xx / timeout | Cooldown 2 min, try the next route |
| 401 / 403 | Disable that provider (bad key) and say so in the log |
| 404 model | Remove that model from the pool |
| Everything failed | 503 with the reason for each route |

## Setup

Requires Node.js 18+. No dependencies, no build step.

```bash
git clone https://github.com/<your-user>/my-ai-free-model.git
cd my-ai-free-model
cp .env.example .env      # then fill in your keys
```

`.env`:

```dotenv
PORT=4570
OPENROUTER_API_KEY=
NVIDIA_API_KEY=
AMD_API_KEY=
```

Get keys: [openrouter.ai](https://openrouter.ai) → Keys · [build.nvidia.com](https://build.nvidia.com) → Get API Key · [developer.amd.com.cn/radeon/profile](https://developer.amd.com.cn/radeon/profile). Kilo needs none. A provider without a key is simply skipped.

Check that your keys work (already available):

```bash
./scripts/probe-providers.sh >> data/probe-result.txt
tail -40 data/probe-result.txt
```

### Usage *(planned, from step 3)*

```bash
node server.js

curl http://localhost:4570/v1/models
curl -X POST http://localhost:4570/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"free-model","messages":[{"role":"user","content":"Say hello in Chinese"}]}'
```

Clients: set the base URL to `http://localhost:4570/v1` and the model to `free-model`. For Claude Code *(planned, step 4)*: `ANTHROPIC_BASE_URL=http://localhost:4570`.

## Model groups *(planned, from step 3)*

Ask for a group by model name. The router then only routes (and fails over) inside that group. An empty group falls back to the whole pool, so a config mistake never takes the service down.

| Model name | Best for | Role in your workflow |
| --- | --- | --- |
| `free-model` | Anything, or when unsure | — |
| `free-model-thinking` | Planning, requirements, design, code review, writing test plans | **PM**, architect, **QA** (test design and review) |
| `free-model-coder` | Writing and editing code, tool-heavy agent loops | **Developer** |
| `free-model-fast` | Short quick jobs: summaries, commit messages, simple edits, QA smoke checks | helper agents, **QA** (quick checks) |

Group membership lives in `pool.config.json` → `groups` (substring match on the canonical model name). The starter lists are built from measured latency, reasoning flags and model names. They are **not benchmarked for quality**. Run `npm run pool` to see who is in each group, and edit freely.

### Examples

Claude Code, one tool with three tiers *(needs step 4)*:

```bash
export ANTHROPIC_BASE_URL=http://localhost:4570
export ANTHROPIC_AUTH_TOKEN=free-model-local   # any non-empty string; the server only listens on localhost
export ANTHROPIC_API_KEY=
export ANTHROPIC_DEFAULT_OPUS_MODEL=free-model-thinking
export ANTHROPIC_DEFAULT_SONNET_MODEL=free-model-coder
export ANTHROPIC_DEFAULT_HAIKU_MODEL=free-model-fast
claude
```

Any OpenAI-compatible client (OpenCode, Cline, Cursor…): base URL `http://localhost:4570/v1`, any non-empty API key, model `free-model-coder` (or another name from the table).

```bash
curl http://localhost:4570/v1/chat/completions -H "Content-Type: application/json" \
  -d '{"model":"free-model-thinking","messages":[{"role":"user","content":"Write a test plan for a login form"}]}'
```

### Not supported

- **No video input and no audio input.** Some free models accept them, but this proxy does not route them.
- **Image input** only goes to routes marked `vision`; other routes are text-only.
- Context windows differ (65K to 1M tokens). Routes too small for the prompt are skipped.

## Roadmap

- [x] 0. Project scaffold
- [x] 1. Verify access to Kilo, OpenRouter, NVIDIA, AMD
- [x] 2. Provider model discovery and filtering
- [x] 3. Router (latency, cooldown, dedupe) and OpenAI-compatible server
- [ ] 4. Anthropic-compatible `/v1/messages`
- [ ] 5. OpenCode CLI fallback

## Privacy and fair use

- Your prompts go to whichever free provider handles the request. **Free pools can log prompts** (Kilo says so on its model cards). Do not send secrets or sensitive code.
- Keys stay in your local `.env` (git-ignored) and are never logged. The server binds to `127.0.0.1` only.
- You are bound by each provider's terms. Free tiers can change or disappear at any time.

## Acknowledgements

Ideas from [oh-my-free-models](https://github.com/hakilee/oh-my-free-models) (latency routing, 10-minute cooldown, MIT) and [opencode-bridge](https://github.com/328336690/opencode-bridge) (wrapping the OpenCode CLI as an OpenAI-compatible API). No code is copied; if that changes, the original license notices will be kept.

## License

MIT, see [LICENSE](./LICENSE).
