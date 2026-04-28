# Model Proxy

OpenAI 兼容的模型代理服务，位于 OpenClaw 和各模型 provider 之间，统一管理 fallback、重试、并行请求。

## 功能

- **主模型重试**：主模型失败后自动重试，默认 2 次
- **并行 fallback**：主模型全部失败后，同时向所有 fallback provider 发请求，谁先回来用谁
- **超时控制**：单次请求默认 45 秒超时
- **SSE 流式输出**：支持 `stream: true`
- **格式自动转换**：自动处理 OpenAI ↔ Anthropic API 格式转换
- **健康检查**：`GET /health`

## 快速开始

```bash
cd projects/model-proxy
npm install
cp config.yaml.example config.yaml
# 编辑 config.yaml，填入你的 API Key
node src/server.js
```

## 配置

复制 `config.yaml.example` 为 `config.yaml`，然后编辑填入你的 provider 配置：

```yaml
port: 3000
logLevel: info
timeout: 45000
maxRetries: 2
parallelTimeout: 45000
activeModel: xiaomi-direct/mimo-v2.5-pro
fallbackModels:
  - minimax/MiniMax-M2.7-highspeed
  - xiaomi token plan/mimo-v2.5-pro

providers:
  - name: xiaomi-direct
    baseUrl: https://api.xiaomimimo.com/v1
    apiKey: YOUR_API_KEY
    apiType: openai-completions
    models:
      - id: mimo-v2.5-pro
        label: MiMo v2.5 Pro
```

环境变量覆盖：
- `MODEL_PROXY_PORT` — 端口
- `MODEL_PROXY_LOG_LEVEL` — 日志级别

## 与 OpenClaw 集成

在 `openclaw.json` 中添加一个 provider 指向本代理：

```json
{
  "models": {
    "providers": {
      "model-proxy": {
        "baseUrl": "http://127.0.0.1:3000/v1",
        "apiKey": "not-needed",
        "api": "openai-completions",
        "models": [{ "id": "proxy", "name": "Model Proxy" }]
      }
    }
  }
}
```

然后将 `model-proxy/proxy` 设为 primary。OpenClaw 主入口固定走 `model-proxy/proxy`，代理内部再按 `config.yaml` 的 `activeModel` 和 `fallbackModels` 路由。

## 架构

```
POST /v1/chat/completions
  → server.js (HTTP 入口)
    → orchestrator.js (重试 + 并行 fallback 逻辑)
      → provider.js (OpenAI ↔ Anthropic 格式转换)
        → stream.js (SSE 流式处理)
          → utils.js (fetch + 日志)
```

## systemd 部署

```bash
cp systemd/model-proxy.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now model-proxy
```
