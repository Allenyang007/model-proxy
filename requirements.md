# Model Proxy V2 - 需求定义

## 1. 目标

Model Proxy 是独立的模型中转服务，统一管理多个 AI 模型 Provider 的路由、fallback、重试。当前只服务 OpenClaw 一个客户端，但服务本身与 OpenClaw 解耦（独立配置、独立管理界面）。

## 2. 架构

```
OpenClaw → Model Proxy (本服务, port 3000) → 各模型 Provider
                                              ├── xiaomi-openrouter (多个模型)
                                              ├── fucheers (多个模型)
                                              ├── moonshot
                                              └── ...
```

- OpenClaw 只配一个 provider 指向本代理
- 代理内部管理所有真实 provider 的路由、fallback、重试
- 管理界面独立于 OpenClaw，通过 Web Dashboard 操作

## 3. V2 核心变更

### 3.1 数据模型：Provider → Models 嵌套

**旧结构**（V1）：每个 provider = 1 个 model
```yaml
providers:
  - name: xiaomi
    baseUrl: https://openrouter.ai/api/v1
    apiKey: sk-xxx
    model: xiaomi/mimo-v2-pro      # ← 只有一个
    apiType: openai-completions
```

**新结构**（V2）：每个 provider = N 个 models
```yaml
activeModel: "xiaomi-openrouter/xiaomi/mimo-v2-pro"

providers:
  - name: xiaomi-openrouter
    baseUrl: https://openrouter.ai/api/v1
    apiKey: sk-xxx
    apiType: openai-completions
    models:
      - id: xiaomi/mimo-v2-pro
        label: MiMo v2 Pro
      - id: xiaomi/mimo-v2-omni
        label: MiMo v2 Omni
```

### 3.2 ActiveModel 概念

- `activeModel`：全局首选模型，格式 `providerName/modelId`
- 独立于 provider 顺序——切换首选模型不需要移动 provider 位置
- 通过 API 或 Dashboard 切换，改 config.yaml，零重启

### 3.3 新的 Fallback 链路

```
收到请求
  │
  ▼
ActiveModel（#1）
  │
  ├─ 成功 → 返回
  │
  └─ 失败 → 重试（最多 5 次，每次 100 秒超时）
      │
      ├─ 某次重试成功 → 返回
      │
      └─ 5 次全失败 → 并行 fallback (#2 ~ #N)
          │
          ├─ 某个先返回成功 → 取消其他，返回该结果
          │
          └─ 全部失败 → 返回错误
```

**Fallback 链路构建规则**：
```
1. ActiveModel
2. 同 Provider 的其他 Models（按 models 列表顺序）
3. 其他 Provider 的 Models（按 providers 列表顺序，逐个展开）
```

**示例**：
```yaml
activeModel: "xiaomi-openrouter/xiaomi/mimo-v2-pro"
providers:
  - name: xiaomi-openrouter
    models: [mimo-v2-pro, mimo-v2-omni, mimo-v2-flash]
  - name: fucheers
    models: [claude-opus-4-6, claude-sonnet-4-6]
  - name: moonshot
    models: [kimi-k2.5]
```
→ Fallback 链路：
```
#1  xiaomi-openrouter/xiaomi/mimo-v2-pro     ← activeModel
#2  xiaomi-openrouter/xiaomi/mimo-v2-omni    ← 同 provider
#3  xiaomi-openrouter/xiaomi/mimo-v2-flash   ← 同 provider
#4  fucheers/claude-opus-4-6                 ← 下一个 provider
#5  fucheers/claude-sonnet-4-6               ← 同 provider
#6  moonshot/kimi-k2.5                       ← 最后一个 provider
```

### 3.4 Fallback 触发条件（不变）

| 情况 | 处理 |
|------|------|
| 连接超时（100 秒无响应） | fallback |
| 408/429/403/500/502/503/504 | fallback |
| 连接断开/网络错误 | fallback |
| 400 请求格式错误 | **直接报错，不 fallback** |
| 401 认证失败 | **直接报错，不 fallback** |

## 4. API 设计

### 4.1 核心 API（不变）

| 端点 | 方法 | 说明 |
|------|------|------|
| `POST /v1/chat/completions` | POST | OpenAI 兼容聊天接口（含 SSE streaming） |
| `GET /health` | GET | 健康检查 |

### 4.2 Active Model API

| 端点 | 方法 | 说明 |
|------|------|------|
| `GET /api/active-model` | GET | 获取当前 activeModel |
| `PUT /api/active-model` | PUT | 设置 activeModel `{modelKey:"provider/model"}` |

### 4.3 Provider API

| 端点 | 方法 | 说明 |
|------|------|------|
| `GET /api/providers` | GET | 列出所有 provider（含嵌套 models，API key 脱敏） |
| `POST /api/providers` | POST | 添加 provider |
| `PUT /api/providers/:name` | PUT | 更新 provider |
| `DELETE /api/providers/:name` | DELETE | 删除 provider |
| `POST /api/providers/reorder` | POST | 重排 provider 顺序 `{order:["name1","name2"]}` |

### 4.4 Model API（Provider 内）

| 端点 | 方法 | 说明 |
|------|------|------|
| `POST /api/providers/:name/models` | POST | 给 provider 添加 model `{id,label}` |
| `DELETE /api/providers/:name/models/:id` | DELETE | 删除 model |
| `PUT /api/providers/:name/models/:id` | PUT | 更新 model `{id,label}` |

### 4.5 监控 API

| 端点 | 方法 | 说明 |
|------|------|------|
| `GET /api/stats` | GET | 运行统计（请求数、成功率、延迟、token） |
| `GET /api/logs?limit=N` | GET | 请求日志 |
| `GET /api/hourly?hours=N` | GET | 按小时统计（支持 7 天 = 168h） |
| `GET /api/health-check` | GET | 实时健康检测所有 models |
| `GET /api/codex/status` | GET | Codex OAuth 状态（保留，耦合 OpenClaw） |

## 5. 日志与数据保留

- 请求日志：保留最近 **7 天**，上限 5000 条
- Token 消耗统计：保留最近 **7 天**的按小时统计
- Provider 级别统计：累计（进程生命周期内）

## 6. Dashboard UI 设计

### 6.1 整体布局

```
┌─────────────────────────────────────────────┐
│ 🦀 Model Proxy       ● 运行中    [activeModel] │ ← 顶部状态栏
├─────────────────────────────────────────────┤
│ 运行时间 │ 总请求 │ 成功率 │ Token 消耗      │ ← 统计卡片
├─────────────────────────────────────────────┤
│ Fallback 链路可视化                          │ ← 链路展示
│ #1 ⭐ xiaomi-openrouter/mimo-v2-pro (active) │
│ #2    xiaomi-openrouter/mimo-v2-omni        │
│ #3    xiaomi-direct/mimo-v2-omni            │
│ ...                                         │
├─────────────────────────────────────────────┤
│ Provider 卡片列表                            │ ← CC Switch 风格
│ ┌─────────────────────┐ ┌─────────────────┐ │
│ │ xiaomi-openrouter   │ │ fucheers        │ │
│ │ openrouter.ai/v1    │ │ fucheers.top/v1 │ │
│ │ ─────────────────── │ │ ─────────────── │ │
│ │ ⭐ xiaomi/mimo-v2-pro│ │ ⭐ claude-opus  │ │
│ │    xiaomi/mimo-v2-om│ │    claude-sonnet│ │
│ │    xiaomi/mimo-v2-fl│ │                 │ │
│ │ [+添加模型] [⬆️⬇️]   │ │ [+添加] [⬆️⬇️] │ │
│ └─────────────────────┘ └─────────────────┘ │
├─────────────────────────────────────────────┤
│ Token 消耗趋势 (7天)                         │ ← 图表
├─────────────────────────────────────────────┤
│ 请求日志                                     │ ← 两层日志
│ ┌─ 汇总视图（时间/Provider/状态/延迟/Token） │
│ └─ 详情（点击展开：请求体/响应/错误信息）     │
├─────────────────────────────────────────────┤
│ 健康检测  [🔍 检测所有]                       │ ← 每个 model 的状态
├─────────────────────────────────────────────┤
│ 测试聊天                                      │
├─────────────────────────────────────────────┤
│ OpenAI Codex OAuth                           │
└─────────────────────────────────────────────┘
```

### 6.2 交互要求

- **设为首选**：点击 model 行的 ⭐ 按钮，立即切换 activeModel（调 PUT /api/active-model）
- **Provider 排序**：点击 ⬆️⬇️ 按钮调整 provider 顺序（调 POST /api/providers/reorder）
- **添加 Model**：Provider 卡片内点"+添加模型"，弹窗填写 id + label
- **添加 Provider**：顶部"+添加 Provider"按钮，弹窗填写 name/baseUrl/apiKey/apiType + models
- **编辑/删除**：hover 显示编辑/删除按钮
- **日志展开**：点击日志行展开详情
- **实时刷新**：统计、日志每 10 秒自动刷新

## 7. 超时配置

| 项 | 值 |
|------|------|
| 单次请求超时 | 100 秒 |
| 主模型重试次数 | 5 次 |
| 并行 fallback 超时 | 100 秒 |

## 8. 与 OpenClaw 的关系

- OpenClaw 只配一个 provider 指向 `http://127.0.0.1:3000`
- OpenClaw 不管理 fallback 链路，由代理内部处理
- 切换模型：通过 Dashboard 或代理 API，不改 OpenClaw 配置
- Codex OAuth：保留现状，依赖 OpenClaw 的 auth-profiles.json

## 9. 部署

- 端口：3000（不变）
- systemd 托管（不变）
- config.yaml 在项目目录下，独立于 OpenClaw

## 10. 测试清单

### 10.1 配置加载
- [ ] 新格式 config.yaml 正确加载
- [ ] 旧格式自动迁移为新格式
- [ ] activeModel 解析正确
- [ ] activeModel 不存在时 fallback 到第一个 model

### 10.2 API 测试
- [ ] GET /health 返回 activeModel 和 model 数量
- [ ] GET /api/providers 返回嵌套结构，key 脱敏
- [ ] POST /api/providers 添加 provider
- [ ] PUT /api/providers/:name 更新 provider
- [ ] DELETE /api/providers/:name 删除 provider
- [ ] POST /api/providers/reorder 重排顺序
- [ ] POST /api/providers/:name/models 添加 model
- [ ] DELETE /api/providers/:name/models/:id 删除 model
- [ ] GET /api/active-model 获取当前值
- [ ] PUT /api/active-model 切换模型
- [ ] POST /v1/chat/completions 正常转发
- [ ] POST /v1/chat/completions?stream=true SSE streaming 正常

### 10.3 Fallback 测试
- [ ] activeModel 正常时直接返回，不触发 fallback
- [ ] activeModel 失败时按链路 fallback
- [ ] 同 provider 的其他 models 优先 fallback
- [ ] 并行 fallback 正确取消其他请求
- [ ] 400/401 不触发 fallback

### 10.4 Dashboard 测试
- [ ] 登录认证正常
- [ ] Provider 卡片显示嵌套 models
- [ ] ⭐ 切换 activeModel 即时生效
- [ ] ⬆️⬇️ 排序即时生效
- [ ] 添加/删除 Provider 正常
- [ ] 添加/删除 Model 正常
- [ ] Token 图表显示 7 天数据
- [ ] 日志两层展示正常
- [ ] 健康检测正常
- [ ] 测试聊天正常
- [ ] 实时刷新不闪烁

### 10.5 回归测试
- [ ] OpenClaw 正常使用代理（重启 openclaw 后测试对话）
- [ ] 流式响应正常
- [ ] Fallback 日志在 Dashboard 中正确记录
- [ ] systemd 重启后配置不丢失

## 11. 不做的事

- 不做请求缓存
- 不做 token 计费/限额
- 不做模型质量评估/自动选择
- 不做请求队列/排队
- 不做多租户
- 不做多客户端通用中转（当前只服务 OpenClaw）
