# LoCoMo 试测

[返回 README](../README.md)

数据及官方评分代码来自 [snap-research/locomo](https://github.com/snap-research/locomo)，论文为 ACL 2024《Evaluating Very Long-Term Conversational Memory of LLM Agents》。数据许可见上游 `LICENSE.txt`（CC BY-NC 4.0）。公开版本 `data/locomo10.json` 有 10 段长对话、1986 题；前四类共 1540 题。不要把不同类别、模型、证据预算或评分方式的结果直接比较。

## 本项目适配

当前默认检索已调整为3＋3条记忆，每条最多读取4条最新原文候选、默认发送最近2条，未覆盖原文达到5条时在合并过程中阶段压缩。已有评测报告保留其运行时配置（例如此前的6＋6），不能用新默认值解读旧报告；复测请使用新输出目录。调整参数或代码后，不要在旧报告目录续跑并混合成绩。

`scripts/evaluate-locomo.ts` 默认使用第一段 `conv-26` 的全部 19 次会话、419 条发言；按类别内均匀位置固定选题，默认每类 8 题，共 40 题。选题在导入前确定，不按模型表现选题。它是一个完整对话上的分层小样本试测，不是全量 LoCoMo 成绩。

每条原始发言以 `姓名: 发言` 作为独立的历史用户陈述导入，会话时间通过 `recordedAt` 保存，`dia_id` 留在外部来源映射中，不把导入说明当成用户事实；助手答复为空，前六条带日期的原始发言仅作上下文。两位说话人都接受相同处理，不把第二位人物当成助手而漏记其事实。使用正式的 `remember` 提取、合并、覆盖、阶段压缩及检索流程。`remember` 的内部可选参数 `{ recordedAt }` 可保留导入时间，缺省仍使用当前时间；HTTP 接口未开放该参数。原数据无时区，时间使用 UTC 存储约定，不推断时区转换。图片只使用数据附带的文字描述，不下载或识别图片。

对照组每条原始发言建立一个向量，不提取、合并或压缩。两组采用相同检索函数、阈值、证据预算、聊天模型和英文简短回答提示词，查询时不附带近期对话。它比较原文索引与动态记忆；不是生产页面中文回答提示词的原样成绩。提取 / 合并提示词不针对题目修改。原始记录及前六条上下文格式在两组一致。

标准答案、题型和参考证据 ID 不传给模型，测试回答不写回记忆。每题两组共用查询向量，回答顺序交替。来源覆盖率按被选中证据关联的 `dia_id` 计算；阶段覆盖某条原文不代表其关键内容在压缩后仍保留，上下文间接携带的来源也不计入此指标。不能把这个数字称为语义召回准确率。

## 运行

先将上游同一提交的 `data/locomo10.json`、`task_eval/evaluation.py` 和 `LICENSE.txt` 下载至忽略目录 `artifacts/locomo-data/`，分别命名为 `locomo10.json`、`official-evaluation.py` 和 `LICENSE.txt`。建议同时记录提交 SHA、数据 SHA256 和下载日期。

```sh
npm run test:locomo -- --sample conv-26 --questions 40 --out artifacts/locomo-pilot-conv26-v2
```

命令读取 `.env.local` 并调用真实模型，产生 API 使用量；无需新增环境变量。独立的 `dynamic.sqlite`、`raw.sqlite` 和 `report.json` 全部保存在指定输出目录，不使用日常数据库。报告记录样本、选题、配置、核心代码哈希、每条写入状态、实际证据、两组回答、耗时及服务返回的聊天 token 用量。未返回 usage 或失败请求的用量未知，不按零费用推断。

当聊天服务地址为阿里云 `aliyuncs.com` 时，评测进程默认在所有聊天请求中加入 `enable_thinking: false`，对写入和两组回答一致生效，生产服务配置不变。可用 `--disable-thinking false` 保留服务默认行为；其他服务默认不传该参数。不要在同一输出目录更改此设置后续跑。

相同命令可续跑。续跑要求数据、配置及核心代码一致；已经完成的问答不重跑，已经写入但中断在检查点前的原始记录按恢复记录处理，不重复导入。连续五条发言无法建立索引时停止，避免持续请求故障服务。服务失败、记忆整理 partial 都保留在报告中，不通过隐蔽重试删掉失败样本。

可加 `--budget-cny 4.5` 限制本次进程新增聊天请求的估算费用。默认单价为输入每百万 token 0.8 元、输出 2.7 元，可通过 `--input-cny-per-million` 和 `--output-cny-per-million` 调整。每次请求前按输入 UTF-8 字节数加余量与最大输出预算预留，响应后按返回 usage 计数；未返回 usage 的请求保留预留估算。预算和本次请求起点记录在 `budgetRuns`，重启进程会开始新的预算。本功能不读取账单，不计算缓存优惠，不能代替服务端账户消费限制；示例单价仅适用于相应模型和地域。

### 复用数据库补测

已完成一轮后，可用 `--extend-from` 将其数据库快照与已完成答案复制到一个新的输出目录，增加题目且跳过全部记忆构建。例如补齐 `conv-26` 的 199 题：

```sh
npm run test:locomo -- --sample conv-26 --questions 199 --extend-from artifacts/locomo-pilot-conv26-v2 --out artifacts/locomo-conv26-all199 --budget-cny 2
```

源报告必须为 completed，所选题目须包含全部已有题；数据、模型、提示词、检索参数及核心代码必须完全一致。源 SQLite 不能存在未检查点化的 WAL。目标必须使用新目录，续跑时继续使用该目标目录及相同参数即可。脚本保留源报告哈希、数据库文件哈希、沿用和新增题目索引；不覆盖源小样本结果，不重跑已有答案，不补写未索引原文。原日志与用量继承保留，新增费用以本轮 `budgetRuns` 的请求起点区分。

补测不改变原系统参数，全部题目得分按实际题型数量加权；各类题数不相等，不能直接把与原来每类 8 题的总分变化解释成系统改善。应另外查看新增题成绩，并仍然注明只测一段对话。

### 新配置的 DeepSeek 三组对照

`scripts/run-locomo-campaign.ts` 固定使用 `deepseek-v4-pro-0813`，只覆盖评测进程的模型，不改生产配置。动态使用正式建库、3+3检索、每条最多4个原文候选且默认送最近2条、完整原文关联保留、未覆盖原文达到5条触发阶段压缩。普通组共用原文分块和本地查询向量，分别Top3和Top6。回答提示词与之前小测相同，temperature=0、关闭thinking，查询答案不写回。

在任何批次调用前固定样本顺序和两种前缀的题号：剩余不少于30万token时选前两次完整会话，18万至30万时选第一次完整会话，更少时停止新建库，改用已完成问题的冻结证据做至多四轮重复回答。选择只依赖数据范围和预算，不依赖预测得分。三组完整答题组不足预算时停止，失败或缺失usage停止且保留预留，不自动重试。每个独立批次从头建库，原生产数据库不修改。

输出在 `artifacts/locomo-deepseek-v4-pro-0813-3plus3/`：`plan.json` 记录固定规则和题号，`runs.json` 记录实际批次及分配预算，每批 `report.json` 保存原始答案、证据、请求用量和源码哈希。所有批次、微型预检、建库和重复回答共用100万输入加输出token上限；脚本不读取百炼实时余额，以用户提供的模型额度为前提，实际抵扣以控制台为准。单批脚本也可独立使用，但跨批预算必须由控制脚本分配，不能为每个批次重复分配100万。

```powershell
$env:LLM_MODEL='deepseek-v4-pro-0813'
# 首次运行一次；若已有preflight.json，先检查其状态，不能重复未知扣费请求。
node --env-file=.env.local --import tsx scripts/preflight-locomo-model.ts
node --env-file=.env.local --import tsx scripts/run-locomo-campaign.ts
# 本地评分，不调用云端；可在批次之间或全部结束后执行：
node --import tsx scripts/render-locomo-campaign.ts
```

离线评分仍用原官方函数，输出 `summary.json`、`comparison.md` 及逐题分数；只汇总三组完整的共同题，重复题不增加独立题数。短前缀的普通Top6可能接近全文，没有覆盖完整长期记忆。部分题此前使用其他模型测过；本轮同时改变模型和检索配置，不能把跨轮分数变化直接归因于参数修改，也不能把F1称为正确率。

## 评分

### 当前源码重新建库的完整长会话对照

`scripts/run-locomo-full.ts` 固定选择conv-26、conv-49、conv-50的全部官方原题，分别199、196、204题，共599道不同问题、1,496条原始发言。每段完整历史都从头调用当前生产remember建库，创建独立SQLite文件；不复制旧库、旧摘要或旧答案。普通组从同一原始发言重新生成1400字符分块，本地Embedding后分别Top3和Top6。每段完成建库后答其全部原题，查询答案不写回。

当前使用配置中的Responses模型，三组相同reasoning强度、回答提示词和证据预算，不发送模型未声明支持的temperature。Responses协议先用小请求验证，评测预检最多64输出token。正式manifest记录API类型、推理参数、源数据与当前实现源码哈希。固定选题后不能按成绩调参并仍声称独立验证。

控制脚本串行运行独立会话任务，每个任务拥有独立数据库和预分配预算；合计3,000万输入加输出token是防止失控的上限，并非要消耗到此值。每题先为完整三组回答预留预算，不足则保存已有结果。只有明确返回gateway_concurrency_limit且输出为空的Responses拒绝才退避重试，最多三次；每次失败及未知用量预留照常保留。其他接口失败或缺少用量停止对应任务，不自动重复未知扣费请求。当前输出默认在 `artifacts/locomo-sub2api-gpt61-fresh-599-v2/`，旧的连通性试错记录保留在独立目录。

`scripts/recover-locomo-transport.ts`可在任务停止后，显式迁移仅评测传输代码改变的检查点：必须提供输出目录和原评测脚本哈希，其他核心源码必须完全一致；原报告先归档，迁移和明确限流拒绝记录保留，不重写已完成建库操作。它不允许用新记忆逻辑续用旧库。最初的并发尝试及后续串行执行也保留在计划归档中。

```powershell
# 新评测先做一次连通性探针；已有响应文件时先检查，避免重复请求。
node --env-file=.env.local --import tsx scripts/probe-sub2api.ts
# 默认读取 artifacts/responses-provider-probe/responses.json 的实际用量；
# 使用其他探针目录时设置 LOCOMO_RESPONSES_PROBE 为对应 responses.json 路径。
node --env-file=.env.local --import tsx scripts/run-locomo-full.ts
```

每个会话完成后自动调用离线官方评分，更新comparison.md与summary.json，长会话分组、分类分数和完整逐题答案都保留。会话之间评分串行，报告使用临时文件原子替换，允许另一个会话继续运行时读取。这个范围是10段官方会话中的3段，不是全量LoCoMo；部分数据用于过往调试或测试，不能声称严格未见验证集。F1不是人工正确率。

### 普通 RAG 对照与免费 token 小测

`scripts/evaluate-locomo-small.ts` 为独立试测：固定 `conv-48` 前两次完整会话（50条发言），选择全部参考证据均在该范围内的20道前四类题，以及事先均匀抽取的5道对抗题。选择仅依据范围和类别，不依据预测分数；此前合并诊断使用的 conv-26 不用于本轮。它不是完整对话或全量 LoCoMo。

普通组以原文连续发言分块，目标1400字符，同一会话内重叠一条完整发言，不跨会话，过长单条保留完整。每块独立向量索引，单轮余弦 Top-6，无分数截断，不提取/合并/摘要、不二跳、不附加上下文。动态组从头调用正式 remember 建库并使用 expand 检索。两组使用同一 `qwen3.8-max-0902`、本地 Embedding、英文简短回答提示词、temperature=0、关闭thinking和相同最终证据字符/token预算；动态原文允许携带前6条上下文，此差异属于被测系统。标准答案不传模型，测试答案不写回。

普通索引仅6块，Top-6会取到全部块，接近短历史全文对照，不能据此判断大库检索能力。因此在任何答题前额外固定 Top-3 敏感性对照（top3-plan.json），复用同一索引和动态答案，只新增普通 Top-3 回答，不重新建库。三组分别报告。

PowerShell 中仅对评测进程设置模型，不修改生产 `.env.local`：

```powershell
$env:LLM_MODEL='qwen3.8-max-0902'
node --env-file=.env.local --import tsx scripts/evaluate-locomo-small.ts
# 第一轮 completed 后补测预先声明的普通 Top-3，复用动态答案，不重复建库：
node --env-file=.env.local --import tsx scripts/evaluate-locomo-top3.ts
```

产物位于 `artifacts/locomo-plain-rag-max0902-conv48-s2/`，正常数据库不修改。聊天输入与输出合计上限80万token，建库请求最多占60万以预留答题量；每次请求前按UTF-8字节数＋余量＋最大输出预留，调用后以usage结算。该上限跨进程续跑累计，不重置；无usage或中断请求保留保守预留并停止，未解决前拒绝重复调用。每题先预留完整两组回答的预算，不能完成下一对时停止并保留已有结果。向量为本地调用，不计入百炼聊天token。示例以模型有独立100万免费额度为前提，脚本不读取账户剩余额度，实际抵扣以控制台为准。

Top-3 产物位于其 `ordinary-top3/` 子目录，复制父报告请求记账并追加新调用，所有阶段合计仍受80万上限控制；父报告哈希和声明计划在子报告中保留。不能把父子报告的累计token相加。两个报告分别使用官方评分及小测渲染脚本处理。

### 追加多会话对照

`scripts/evaluate-locomo-extra.ts` 沿用小测的生产记忆流程、回答提示词和预算预留，预先包含动态、普通 Top6、普通 Top3 三组；每题先预留完整三组回答，按题号轮换回答顺序。通过 `LOCOMO_SAMPLE`、`LOCOMO_SESSIONS`、`LOCOMO_OUT` 和 `LOCOMO_BUDGET_TOKENS` 指定样本、完整会话数、独立输出目录和本报告累计上限。仅评测进程设 `LLM_MODEL=qwen3.8-max-0902`，不改变生产配置。预算必须大于8万且不超过60万；建库提前保留8万用于答题，达到预算时保留现有记录，不补发请求。

追加批次在 `artifacts/locomo-extra-max0902/plan.json` 预先固定样本顺序、选题与新增聊天token总上限60万。顺序运行，每个新报告上限为60万减去已用额度，不能分别给每个报告60万。额外重复测试须复用已经完成的库，并将同题重复结果单列，不增加独立题数。评分仍使用同一官方函数，模型返回名称与配置不一致时停止。Top3和Top6共享原文分块和查询向量；每条回答、证据、用量和代码哈希保留。短历史和上游参考证据错误等原有限制仍适用。

`scripts/evaluate-locomo-repeat.ts` 要求计划内两份报告完成且没有未解决的聊天请求；按预先固定的样本、题号顺序复用证据，最多重复四轮。其账本只记录新增调用，共用60万上限时加上两份父报告的用量，不能再次重复累计。已测且完全相同的冻结提示词，按原服务返回的输入token数＋最大输出＋512余量预留；新提示词仍使用UTF-8字节保守上界。每次调用前保留完整三组回答预算，不足时正常停止；不重建库，也不把重复题数当成新题。

`node --import tsx scripts/render-locomo-extra.ts <Python路径>` 仅在本地评分和生成报告，不调用云端。它将Top3及Top6投影为兼容原评分脚本的输入，使用未修改的官方函数；分别报告新增独立题、与上轮合并的独立题、重复测试和token账本，输出 `artifacts/locomo-extra-max0902/comparison.md` 及 `summary.json`。只汇总三组都完成的共同题目，未完成数量与接口异常单列；重复测试不加入独立题均分。

用下述官方评分脚本计算 scores.json 后，再执行 `node --import tsx scripts/render-locomo-small.ts <报告目录>` 生成 results.md 和 summary.json。已有结果、失败请求、partial写入、完整证据、原始响应、usage和代码哈希均保留，不通过重试隐藏失败。分类型F1及第五类规则分单列，不与旧Flash测试直接比较，不作为显著性结论。

`scripts/score-locomo.py` 从下载的官方评分源文件中加载 `normalize_answer`、`f1_score`、`f1` 和 `eval_question_answering` 四个函数，保持函数逻辑不变。需要 Python 包 `numpy`、`nltk`、`regex`；不需要下载 NLTK 语料，也不需要安装 BERT 模型。可通过 `LOCOMO_PYTHON_PACKAGES` 指向独立依赖目录。

```sh
python scripts/score-locomo.py artifacts/locomo-pilot-conv26-v2/report.json artifacts/locomo-data/official-evaluation.py
node --import tsx scripts/render-locomo.ts artifacts/locomo-pilot-conv26-v2
```

前四类按官方规则计算经过词干处理的 token F1；第 5 类按官方规则检查弃答短语，单独报告。五类平均混合了不同指标，不能称为正确率。服务失败和未完成题目单列，不混作语义错误。输出 `scores.json`，包含逐题分数、类别分数、来源覆盖率和两组对照。保留原始答案便于人工复核；词匹配得分不等同于人工判断。

正式报告还应说明仅测一个对话、每类仅 8 题、没有多次重复、图像未直接读取，以及模型和网络波动。增加样本时先固定选题和配置，不能根据试测答案调参后仍把该试测作为独立验证集。
