#!/usr/bin/env bash
# Probe OpenRouter + NVIDIA with keys from .env (prints model ids / short replies, never keys)
cd "$(dirname "$0")/.." || exit 1
echo "######## probe $(date "+%Y-%m-%d %H:%M:%S") ########"
set -a; source .env; set +a

echo "== OpenRouter 免費清單"
curl -s https://openrouter.ai/api/v1/models | grep -o '"id":"[^"]*:free"' | head -20

echo "== OpenRouter 傾偈"
curl -s https://openrouter.ai/api/v1/chat/completions \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"openrouter/free","messages":[{"role":"user","content":"用中文說你好"}],"max_tokens":100}' | cut -c1-500

echo "== NVIDIA 清單"
curl -s https://integrate.api.nvidia.com/v1/models \
  -H "Authorization: Bearer $NVIDIA_API_KEY" | grep -o '"id":"[^"]*"' | head -30

echo "== AMD 模型清單"
curl -s https://developer.amd.com.cn/radeon/api/v1/models \
  -H "Authorization: Bearer $AMD_API_KEY" | grep -o '"id":"[^"]*"' | head -20

echo "== AMD 傾偈"
curl -s https://developer.amd.com.cn/radeon/api/v1/chat/completions \
  -H "Authorization: Bearer $AMD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"用中文說你好"}],"max_tokens":100}' | cut -c1-500
echo
echo "== AMD 模型清單 (raw, first 1500 chars)"
AMD_LIST=$(curl -s https://developer.amd.com.cn/radeon/api/v1/models \
  -H "Authorization: Bearer $AMD_API_KEY")
echo "$AMD_LIST" | cut -c1-1500

# 傾偈：用 AMD_MODEL（可在 .env 或命令行指定），否則用清單第一個 id
AMD_MODEL="${AMD_MODEL:-$(echo "$AMD_LIST" | grep -o '"id": *"[^"]*"' | head -1 | sed -E 's/.*"id": *"([^"]*)"/\1/')}"
echo
echo "== AMD 傾偈 (model: ${AMD_MODEL:-<none>})"
curl -s https://developer.amd.com.cn/radeon/api/v1/chat/completions \
  -H "Authorization: Bearer $AMD_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"$AMD_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"用中文說你好\"}],\"max_tokens\":100}" | cut -c1-500
echo
