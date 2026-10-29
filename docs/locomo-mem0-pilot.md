# LoCoMo Mem0 预试

这个预试比较四组：项目当前的动态记忆 RAG、普通 RAG Top 6、普通 RAG Top 3（敏感性对照）以及 Mem0 OSS。四组使用相同的历史对话前缀、问题、Qwen 回答模型和最终回答提示词。Top 3 组是额外对照，不替代普通 RAG Top 6。

默认取 `conv-30` 第一个会话的前 8 条发言，选出 5 道证据落在该前缀内的问题，再加 2 道无法由前缀回答的问题。题目在模型调用前固定；LoCoMo 的标准答案和证据 ID 不会发送给模型。这个样本只用于跑通流程和估算，不代表完整 LoCoMo 成绩，也不是严格的未见测试集。

Mem0 使用 Node OSS SDK，不使用 Mem0 云服务。它的向量库写入本次输出目录的独立 SQLite 文件，Embedding 通过本地 Ollama，记忆提取和最终回答使用 `.env.local` 中配置的聊天模型。所有输入对话、索引、答案和请求账本都留在本次输出目录，不写入日常记忆数据库。Mem0 遥测关闭。

默认输出目录为 `artifacts/locomo-mem0-pilot-conv-30-t8-luna-v2/`，包括 `dynamic.sqlite`、`raw.sqlite`、`mem0.sqlite`、`report.json` 和逐请求模型响应。断点续跑要求模型、数据、配置和脚本哈希都一致；参数变化后请指定新的 `LOCOMO_OUT`。此前 Qwen 预试和 Luna 较大样本的部分结果留在旧目录，不会混入本轮结果。

## 运行

先确认本地 Ollama 正在运行，并且 `.env.local` 的聊天模型和 Embedding 配置可用。运行：

```powershell
npm run test:locomo:mem0-pilot
node --import tsx scripts/render-locomo-four-arm.ts
```

可通过环境变量调整样本：

```powershell
$env:LOCOMO_SAMPLE = 'conv-30'
$env:LOCOMO_SESSIONS = '1'
$env:LOCOMO_TURN_LIMIT = '8'
$env:LOCOMO_OUT = 'artifacts/locomo-mem0-pilot-conv-30-t8-luna-v2'
npm run test:locomo:mem0-pilot
```

脚本在请求发送前预留 token 和费用估算，默认预算上限为 3 美元、聊天 token 上限为 2,000,000；动态与 Mem0 建库阶段会为四组问答预留 0.90 美元。可用 `LOCOMO_BUDGET_USD`、`LOCOMO_ANSWER_BUDGET_USD`、`LOCOMO_BUDGET_TOKENS` 和 `LOCOMO_ANSWER_RESERVE` 调整。当前 Luna 代理没有公开单价，因此暂按输入每百万 token 5 美元、输出每百万 token 15 美元估算；可用 `LOCOMO_INPUT_USD_PER_MILLION` 和 `LOCOMO_OUTPUT_USD_PER_MILLION` 调整。该估算不是服务商账单，也无法限制同一账号上的其他并发消费。

Mem0 查询最多取 6 条，并按与其他组相同的最终上下文字符和估算 token 预算截断。Mem0 的相似度分数和来源元数据定义不同于项目检索，因此不直接横向比较检索分数；来源覆盖率也只对动态和原文组统计。回答质量、请求 token、估算费用、检索与回答耗时应分别观察。

本地预览写入 `results-preview.md` 和 `scores-preview.json`。当前预览沿用官方的标点/冠词归一化与类别规则，但未运行官方 NLTK Porter stemmer，因此明确标为近似分数，不可称作官方 LoCoMo 成绩。
