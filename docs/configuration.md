# 配置说明

[返回 README](../README.md)

配置从项目根目录 `.env.local` 的服务端环境变量读取。新项目可复制 `.env.example`；已有配置直接编辑。更换数据库路径或模型后重启服务；开发服务器有时会自动重载环境变量，重启是明确生效的方式。

## 模型与运行模式

| 环境变量 | 默认 / 回退 | 说明 |
| --- | --- | --- |
| `RAG_MODE` | `demo` | 仅接受 `demo`、`live`；live 配置不全时报错，不回退演示 |
| `LLM_BASE_URL` | `https://api.openai.com/v1` | 兼容聊天接口的 API 前缀，可改为千问等供应商 |
| `LLM_API_KEY` | 空 | live 聊天密钥 |
| `LLM_MODEL` | 空 | live 聊天模型名 |
| `EMBEDDING_BASE_URL` | 未设置时使用聊天地址 | 兼容向量接口的 API 前缀 |
| `EMBEDDING_API_KEY` | 未设置时使用聊天密钥 | 本地 Ollama 可填占位值 `ollama` |
| `EMBEDDING_MODEL` | 空 | live 向量模型名 |
| `RAG_DB_PATH` | `<项目目录>/data/rag.sqlite` | SQLite 文件路径；可用绝对路径避免工作目录差异 |
| `RAG_NEXT_DIST_DIR` | `.next` | Next.js 输出目录，主要用于隔离测试服务 |

`.env.example` 显式写了两个接口地址，若要使用 Embedding 地址的代码回退，需要移除对应配置，而非原样保留示例地址。聊天与 Embedding 可以分别使用云端或本机服务，当前仍要求向量接口有非空密钥字段。

BASE_URL 不包含 `/chat/completions` 或 `/embeddings`。页面聊天要求服务支持 `stream: true`，返回 `text/event-stream` 的 `choices[].delta.content`；非流式 API 调用、事实提取和整理使用完整聊天 JSON。仅支持这些接口不代表所有供应商的额外鉴权、模型参数或结构化输出机制都已适配。

## 相关性与扩展

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `RAG_SEARCH_THRESHOLD` | **0.45** | live 首轮与二轮原问题 / 邻居相似度门槛 |
| `RAG_MERGE_THRESHOLD` | **0.6** | live 整理候选门槛，每条事实最多 3 条候选 |
| `RAG_FIRST_CANDIDATES` | 20 | 首轮评分候选上限 |
| `RAG_FIRST_LIMIT` | 6 | 首轮最多选入的记忆数 |
| `RAG_NEIGHBORS_PER_SEED` | 5 | 每个首轮起点的邻居候选上限 |
| `RAG_SECOND_LIMIT` | 6 | 第二轮最多选入的记忆数 |
| `RAG_MIN_FIRST_RESULTS` | 3 | 首轮少于该数量且有预算时尝试扩展 |
| `RAG_MIN_STRONG_RESULTS` | 2 | 首轮高分记忆少于该数量且有预算时尝试扩展 |
| `RAG_STRONG_SCORE` | 0.75 | 首轮高分判定；同时不低于当前检索门槛 |

这些分数是余弦相似度，不是置信度或准确率。降低门槛会扩大候选范围，也可能带来不相关内容。候选是否合并仍由 LLM 判断。阈值代码会限制到 `[-1, 1]`，异常数值回退默认值；建议使用上述正常范围内的数值校准。

demo 固定使用检索门槛 0.08、重复摘要候选门槛 0.64，且每条事实只取一个整理候选；两个 live 阈值不控制 demo。

## 证据预算与阶段压缩

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `RAG_MAX_RECORDS` | 12 | 两轮共用的证据数上限，每个阶段摘要也算一条 |
| `RAG_CONTEXT_MAX_CHARS` | 18000 | 实际历史证据 JSON 的字符上限 |
| `RAG_CONTEXT_MAX_TOKENS` | 6000 | 同一 JSON 的估算 token 上限 |
| `RAG_RECORD_MAX_CHARS` | 5000 | 每条证据正文的字符上限 |
| `RAG_STAGE_SOURCE_THRESHOLD` | 10 | 未覆盖原文超过此数量时压缩 |
| `RAG_STAGE_CHAR_THRESHOLD` | 12000 | 未覆盖完整记录序列化总字符数超过此值时压缩 |
| `RAG_MERGE_INPUT_MAX_CHARS` | 64000 | 批量整理资料 JSON 字符上限 |
| `RAG_MERGE_INPUT_MAX_TOKENS` | 20000 | 批量整理资料 JSON 估算 token 上限 |

回答证据超限时允许带标记节选；批量整理资料超限时放弃本次整理、尽量保存独立事实并返回 partial。预算不是整个模型请求的上限；原文存储也不受这些发送预算裁剪。

阶段摘要最多 4,000 字符、事实最多 20 条且每条最多 700 字符。没有用户事实时，同一次提取调用生成一条最多 700 字符的问答摘要，继续生成向量和整理；类型单独保存，不添加固定前缀参与向量计算。近期对话最多 6 条、合并候选最多 3 条，目前写在代码与 schema 中，没有单独环境变量。阶段阈值与检索数量参数会做范围限制；请使用有效正整数，特别是合并资料预算。

## 配置和数据的边界

密钥只在服务端读取，不使用 `NEXT_PUBLIC_`，不通过配置接口返回。`.env.local`、数据库、日志和 `artifacts/` 已在 Git 忽略规则中；不要把实际密钥粘贴进问题、截图、源码或提交记录。

live 模式会将问题、相关历史与本轮整理资料发给相应模型服务。本地 Embedding 不代表聊天数据也留在本机，取决于 `LLM_BASE_URL`。`scope` 不提供权限认证。

更换数据库路径会打开另一份数据库，不会迁移或清空旧文件。更换 Embedding 服务地址 / 模型名会切换检索向量空间，不自动重建旧记忆。
