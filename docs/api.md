# HTTP 接口

[返回 README](../README.md)

默认本地地址 `http://127.0.0.1:3000`。接口目前没有身份认证，仅适合本地使用。POST 请求使用 `Content-Type: application/json`。

`scope` 为必填的 1–80 字符字符串，可包含文字、数字、下划线和连字符；两个 GET 接口未传时默认为 `default`。POST 同源检查会拒绝带有其他 Host 的 Origin，但不是用户鉴权。

## `POST /api/chat`

```json
{
  "scope": "default",
  "question": "请记住，我希望回答简洁一些。",
  "strategy": "expand",
  "history": [],
  "stream": true
}
```

| 字段 | 规则 |
| --- | --- |
| `question` | 去首尾空白后 1–4000 字符 |
| `strategy` | `expand` 或 `sources`，默认 `expand` |
| `history` | 默认空数组，最多 6 条；每条包含 `role: user / assistant` 与最多 10,000 字符的 `content` |
| `stream` | 默认 `false`；页面使用 `true` |

### 流式响应

`stream: true` 返回 `text/event-stream`。每个事件使用 `data: <JSON>` 和空行分隔，由 JSON 的 `type` 区分：

| `type` | 内容 | 时机 |
| --- | --- | --- |
| `status` | `message` | 检索、生成、整理阶段提示 |
| `evidence` | `evidence` | 检索完成 |
| `delta` | `text` | 收到模型新增文本，可直接追加显示 |
| `answer` | `answer` | 回答完整结束，返回完整文本 |
| `done` | `memory`、`elapsedMs`、`mode` | 记忆整理结束，整轮完成 |
| `error` | `message`、`answerComplete` | 流内失败，随后关闭连接 |

```text
data: {"type":"status","message":"正在生成回答…"}

data: {"type":"delta","text":"已记住"}

data: {"type":"delta","text":"你的偏好。"}

data: {"type":"answer","answer":"已记住你的偏好。"}

```

示意省略了 evidence 和后续整理事件。`answer` 不代表记忆已经整理好，必须等到 `done` 才能确认整轮结果。demo 会将规则回答整体作为 delta 返回；不会模拟真实 token 流。

输入校验或模型配置不全时，尚未建立流，仍返回普通 JSON 错误。SSE 建立后即使内部失败，HTTP 状态也可能是 200，客户端需要读取 `error`。连接无 `done` 就结束，也不能视为整轮成功。未完成的回答不会交给 `remember`。

### 普通 JSON 响应

不传 `stream` 或设为 `false` 时，等待回答与整理完成后一次返回：

```text
{ answer, evidence, memory, elapsedMs, mode }
```

`memory.action` 可能为 `added`、`merged`、`deleted` 或 `partial`。这是整轮摘要状态，不是每一条 LLM 决策；混合操作以计数和 message 为准。成功执行覆盖也计入 `merged`，`replaced` 是其中的覆盖数量，单纯合并数为 `merged - replaced`。

正常整理结果还包含 `recordId`、`facts`、`summaries`、`added`、`merged`、`replaced`、`deleted`、`message`。`facts` 是提取的用户事实数；`summaries` 是本轮生成的摘要数。纯提问可返回 `facts: 0, summaries: 1`，表示使用问答摘要兜底，并非整理失败。提取阶段失败会提前返回 partial，仅含 `recordId` 与说明等字段，因此客户端不要假设计数始终存在。

## `POST /api/search`

```json
{ "scope": "default", "query": "我希望怎样的回答风格？", "strategy": "expand" }
```

`query` 为去首尾空白后 1–4000 字符。只生成查询向量并检索，不生成回答、不写入记忆。返回 `Evidence`：

| 字段 | 含义 |
| --- | --- |
| `first` / `second` | 两轮实际选中的记忆及分数 / 来源 |
| `suggestions` | 没有达标候选时供展示的最近记忆，不作为回答证据 |
| `context` | 实际发送给回答模型的证据、编号、日期与节选标记 |
| `records` / `stages` | 对应完整原文 / 阶段摘要，供页面追溯 |
| `strategy` | 本次策略 |
| `trace` | 扩展原因、候选数、阈值、策略参数与预算使用情况 |

检索用的 `sources` 策略只跳过第二轮关联，仍会按来源读取原文或阶段摘要。

## `GET /api/memories?scope=default`

返回 `{ config, memories, records, stats }`。摘要按当前向量空间筛选，包含冷热区历史；向量本身不返回，使用 `dimensions` 表示维度。`records` 返回该 scope 的原文，不限于当前向量空间。

记忆的 `kind` 为 `qa`（问答）或 `fact`（事实）。该类型独立存储，不拼接到 `summary`，也不作为 Embedding 输入。

`config` 包含模型名、模式、准备状态、缺少的配置项和空间标识，不包含密钥。`stats` 为 `hot`、`cold`、`records` 数量。当前接口一次返回全部数据，没有分页。

## `GET /api/archive?scope=default&stageId=...`

按阶段 ID 返回 `{ stage, records }`，读取该阶段覆盖的完整原文。阶段不属于指定 scope 时返回 404。仅供查看，不生成新回答，也不会把归档追加给模型。

## `POST /api/seed`

```json
{ "scope": "default" }
```

仅 demo 可用，写入 5 条固定问答和一次预设合并；重复载入已存在示例时跳过。返回 `{ "ok": true }`。live 模式调用会报错，避免示例混入真实数据。

## 错误与限制

普通错误响应为 `{ "error": "说明" }`。Zod 校验或 JSON 解析错误返回 400，归档缺失返回 404；其他异常通常返回 500。POST 请求文本长度上限为 64,000 字符，超过时当前返回 500；不能把所有输入限制错误都假定为 400。

聊天接口不是通用记忆管理 API，目前没有独立的新增 / 删除 / 重建端点。代码内的 `remember` 等函数也尚未封装为稳定的公开 SDK。
