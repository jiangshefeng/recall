# 开发与维护

[返回 README](../README.md)

## 目录结构

```text
src/app/page.tsx              聊天、记忆库、配置说明
src/app/globals.css           黑白布局与响应式样式
src/app/retrieval-trace.tsx    可折叠的检索证据面板
src/app/stage-archive.tsx      按需展开归档原文
src/app/markdown-content.tsx   Markdown 与 GFM 展示组件
src/app/api/                  chat / search / memories / archive / seed
src/lib/rag.ts                回答、事实提取、批量整理
src/lib/retrieval.ts          热区筛选、二轮扩展、来源追溯
src/lib/evidence-budget.ts    证据预算、去重与节选
src/lib/compression.ts        阶段压缩条件、未覆盖来源
src/lib/compact-context.ts    共享上下文引用
src/lib/providers.ts          LLM 与 Embedding HTTP 适配
src/lib/sse.ts                浏览器与服务端共用的 SSE 解析
src/lib/store.ts              SQLite 存储与事务
src/lib/similarity.ts         余弦计算与 demo 向量
tests/                       本地自动测试与模拟模型
e2e/                         浏览器行为测试
scripts/                     真实模型检查、数据准备与修复工具
```

项目使用 Next.js App Router 和 Node runtime。修改 Next.js 代码前，按 `AGENTS.md` 阅读项目安装版本附带的文档。

每次修改用户可见行为或配置时，同步检查 README、`docs/` 和 `.env.example`；这项约定已写入 `AGENTS.md`。只描述实际实现，不将开发机器的密钥或个人对话写入文档。

## 本地检查

```sh
npm test
npm run build
npm run test:e2e
```

单元与集成测试覆盖相似度、冷热迁移、来源保存、并发旧状态检查、空间隔离、检索预算、阶段压缩、四种整理操作、上下文去重、纯提问的问答摘要兜底与事实隔离、开发热更新补建表，以及 SSE 的 UTF-8 分块、增量到达与中断不入库。模拟 HTTP 模型用来验证协议和流程，不证明任何真实模型的普遍语义准确性。

浏览器测试默认通过 Playwright 使用已安装的 Microsoft Edge，自动启动 3100 端口 demo 服务，使用 `.next-e2e` 输出目录及 `data/e2e-rag.sqlite`。覆盖聊天、左右消息布局、流式增量显示、记忆面板开关、原文归档、预算展示与移动端。不会使用默认的 `data/rag.sqlite`；截图等产物写入 `artifacts/`。

`e2e/markdown.spec.ts` 验证 Markdown 在流式输出期间渲染、未闭合代码块、GFM 表格及任务列表、移动端横向滚动，以及原始 HTML 和危险链接不会成为可执行内容。渲染采用 `react-markdown` 的默认 URL 过滤，不启用原始 HTML 解析；正文不通过 `dangerouslySetInnerHTML` 写入页面。

如果没有 Edge，可在安装 Playwright Chromium 后，将 `playwright.config.ts` 的 `channel: "msedge"` 改为相应浏览器配置。运行前确保 3100 端口空闲，当前不复用已存在的测试服务。

`npm run typecheck` 单独执行 TypeScript 检查。新检出项目尚未生成 Next 路由类型时，先执行 build。Next.js 在 build / dev / e2e 时可能改写自动生成的 `next-env.d.ts` 引用路径，不需要手动加入测试输出目录。

### 修改后页面仍执行旧逻辑

如果源码和自动测试已经包含新行为，但 HTTP 接口仍返回旧提示，先重启该项目的 Next.js 进程，再刷新页面。曾出现开发服务持续返回旧版「空事实不新增热区」结果的情况；重启后，通过 `/api/chat` 的 `done.memory` 和 `/api/memories` 核对才确认生效。直接导入函数的测试通过，不代表运行中的服务已经更新。

排查记忆写入时，分别检查原始问答是否保存、摘要的来源 ID 是否包含该问答、以及是否发生合并。使用独立测试 scope，避免把验证内容混入日常空间；失败期间只有原文的旧问答不会因重启自动补建摘要。

## 真实模型检查

以下命令读取已有 `.env.local`，会访问配置的真实模型，可能产生费用；不会修改配置文件：

| 命令 | 内容与数据位置 |
| --- | --- |
| `npm run test:live` | 检索、预算与回答引用检查；内存数据库，报告 `artifacts/retrieval-live-check.json` |
| `npm run test:extended` | 多条合成事实写入与查询；数据库 / 报告位于 `artifacts/extended-rag/` |
| `npm run test:compare` | 15 题各测两次，对比最近 6 条聊天与同样聊天加动态记忆；独立数据库、完整证据及回答位于 `artifacts/memory-comparison-*/` |
| `node --env-file=.env.local --import tsx scripts/verify-stage-live.ts` | 初次压缩、增量合并和再次压缩；使用 `artifacts/stage-live-*/` 独立数据库 |
| `node --env-file=.env.local --import tsx scripts/verify-operations-live.ts` | 合并、覆盖、撤回与新增；使用 `artifacts/operations-live-*/` 独立数据库 |
| `node --env-file=.env.local --import tsx scripts/verify-stream-live.ts` | 真实 SSE 增量、完成事件、完整回答入库与纯提问的热区摘要兜底；使用 `artifacts/stream-live-*/` 独立数据库 |
| `node --env-file=.env.local --import tsx scripts/verify-forget-prompt.ts <原A/B报告目录>` | 重放原报告中含旧取件码与撤回要求的证据，测试不复述、明确恢复、新值、普通更新和后续提取；使用 `artifacts/forget-prompt-*/` 独立数据库 |

单次模型检查通过，只代表该组模型、提示词与样本通过。真实模型行为会变化，不将测试样例当作固定准确率承诺。

撤回提示词脚本针对当前 A/B 合成数据中的取件码场景；它检查字符串是否出现，并保留完整回答供复核。字面检查不能覆盖改写、编码或所有语义泄露，也不证明历史数据已被擦除。原 A/B 报告只读，不修改其失败记录。

### 判断记忆是否改善回答

`scripts/compare-memory-data.ts` 预先定义合成对话和每题评分标准，覆盖旧事实、多事实组合、偏好与配置更新、推断、否定、助手建议来源、撤回、未知信息、空间隔离，以及近期聊天和通用知识对照。历史助手答复是固定编写的；摘要提取、向量、整理、检索和测试回答使用真实模型。这个设计比较固定历史下记忆模块的效果，不代表完整自然对话评测。

两组使用相同回答函数、模型和最近 6 条消息；B 组额外收到检索证据。每题运行两次，交替两组请求顺序，测试回答不回写数据库，避免污染后续结果。`report.json` 保存所有写入状态、实际摘要、证据、回答、检索与回答耗时；`answers.md` 展示逐题对照。服务请求失败单列，不能作为模型语义错误计分。脚本不以关键词命中自动判定正确，需要按预先定义的标准检查实际回答。

复核后可在报告目录写入 `grades.json`（`grades` 数组每项包含 `id`、`repeat`、布尔 `baseline/rag` 和 `reason`，另有 `findings`、`limitations` 字符串数组），再运行 `node --import tsx scripts/render-memory-comparison.ts <报告目录>` 生成 `comparison.md`。应注明复核者是人还是模型；当前助手复核不等于独立人类盲评。汇总会保留所有逐题回答，便于核对评分。

区分“没记进去”“没有检索到”“证据足够但回答错误”。原文自身保存了近期上下文，因此仅看原文 ID 命中会低估上下文间接提供的信息，诊断时应查看实际 `evidence.context`。耗时受网络与输出长度影响；记录的证据 token 是估算值，不是账单成本。该测试不比较完整历史直接输入或其他 RAG 系统，也不测长期压缩与大规模性能。

`scripts/` 还包含开发时期的数据导入、修复与重置工具，其中部分会修改当前数据库。特别是 `reset-fact-demo.ts`、`repair-example-preference.ts` 和 `import-extended-fixtures.cjs`，运行前先阅读脚本、确认目标并备份；它们不属于新用户的启动步骤。

旧版问答摘要若带有「问答记录（助手回答未验证）：」前缀，可在停止应用后执行 `node --env-file=.env.local --import tsx scripts/remove-qa-prefix.ts`。脚本先在 `artifacts/remove-qa-prefix-*/before.sqlite` 创建一致性备份，再为当前向量空间中带该前缀的冷热区摘要生成正文向量，并在事务内更新摘要、向量和独立类型。原文、来源 ID、冷热状态及时间保留；其他向量空间跳过并报告。再次执行不会重复处理已清理记录，向量生成失败时不更新记录。完成后重启应用。

## 数据与备份

默认数据库位于 `data/rag.sqlite`，启用 WAL。`records` 保存原始问答，`memories` 保存向量与状态，阶段与操作审计保存在关联表。

新建连接时会创建缺少的表。开发热更新保留全局数据库实例，代码通过存储版本检查更新实例方法并补建新表，不关闭正在使用的连接，也不会清空原始问答。该机制只负责当前的追加建表，不是任意字段变更的通用数据库迁移系统。

备份前停止使用这份数据库的所有应用进程，再复制整个 `data/` 目录，包括存在的 `-wal`、`-shm` 文件。使用自定义 `RAG_DB_PATH` 时备份对应文件及同名辅助文件。恢复也应在停机状态进行，不在运行中覆盖数据库。

「新对话」和切换空间仅重置界面，不会清除旧数据。数据库不包含完整的聊天会话导航与恢复机制；原始问答可在记忆库查看。

`.gitignore` 忽略 `.env.local` 等环境文件、`data/`、`artifacts/`、日志、依赖和构建产物，仅保留 `.env.example`。提交前仍应检查实际暂存区；忽略规则不会自动移除之前已经提交的敏感文件。

## 部署与后续扩展

`npm run dev` 和 `npm start` 默认绑定 `127.0.0.1`。需要远程访问时，应先增加身份认证、按身份绑定 scope 的权限校验与调用配额。当前 API 的同源检查不能替代这些能力。

SQLite 需要持久可写磁盘；短生命周期或只读的无服务器文件系统不能直接承载当前默认存储。大量记忆时，先考虑分页与数据库向量索引；目前的实现会加载热区并线性评分。

反向代理需要支持 SSE，关闭响应缓冲，并允许连接跨越检索、生成和整理阶段；应用已发送 `Cache-Control: no-cache, no-transform` 和 `X-Accel-Buffering: no`，实际是否生效仍取决于代理配置。

目前没有自动重试队列、模型迁移 / 向量重建入口、独立 npm 包、通用文件导入或后台整理任务。若继续扩展，优先保持原文可追溯、一次批量整理和失败可见的行为边界。
