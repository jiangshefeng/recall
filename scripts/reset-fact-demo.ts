import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { remember, retrieve, answerQuestion } from "../src/lib/rag";
import { getStore } from "../src/lib/store";
import { modelConfig } from "../src/lib/providers";

const statements = [
  "我正在学习 React，用它开发网页界面。我计划在 2026 年 11 月寻找前端实习。",
  "我喜欢简短的中文回答，讲解时最好给一个小例子。",
  "我的练习项目叫星河笔记，使用 TypeScript 开发。",
  "星河笔记的页面使用 Next.js，数据库使用 SQLite。",
  "星河笔记生产环境的订单缓存有效期为 5 分钟。",
  "星河笔记测试环境的订单缓存有效期为 2 分钟。",
  "截至 2026 年 9 月，星河笔记使用 Node.js 20。",
  "从 2026 年 10 月 20 日起，星河笔记的 Node.js 从 20 升级到 22，当前是 22。",
  "星河笔记不允许缓存用户余额，每次都需要读取数据库。",
  "星河笔记头像上传只支持 PNG 和 JPEG，单个文件不得超过 2MB。",
  "星河笔记的数据库每天凌晨 2 点备份。备份保留 14 天。",
  "星河笔记的支付重试必须复用同一个幂等键。幂等键在 Redis 中保留 24 小时。",
  "星河笔记生产环境日志级别为 INFO，不允许长期启用 DEBUG。",
  "我在工作日晚上 8 点到 9 点学习编程。周末会练习做网页。",
  "我准备在 2026 年 11 月 6 日去杭州参加技术会议，目前还没订车票。",
];

async function main() {
  const livePath = resolve(process.env.RAG_DB_PATH || "data/rag.sqlite");
  const dir = resolve("artifacts", `fact-demo-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  process.env.RAG_DB_PATH = resolve(dir, "memory.sqlite");
  assert.equal(modelConfig().mode, "live");
  const results: (Awaited<ReturnType<typeof remember>> & { question: string })[] = [];
  for (const question of statements) {
    const result = await remember("default", question, "已记录你提供的信息。", []);
    results.push({ question, ...result });
    writeFileSync(resolve(dir, "ingestion.json"), JSON.stringify(results, null, 2));
    console.log(`${results.length}/15 ${result.message}`);
    assert.notEqual(result.action, "partial");
  }
  const store = getStore();
  assert.equal(store.records("default").length, 15);
  assert.ok(store.memories("default").filter(m => m.sourceIds.includes(results[0].recordId)).length >= 2);
  const checks = [];
  for (const question of ["我是做前端还是后端的？", "星河笔记当前用哪个 Node.js 版本？", "数据库什么时候备份？备份留多久？", "明天巴黎下雪吗？"]) {
    const evidence = await retrieve("default", question, "expand");
    checks.push({ question, evidence, answer: question.includes("前端") ? await answerQuestion(question, [], evidence) : undefined });
  }
  writeFileSync(resolve(dir, "checks.json"), JSON.stringify(checks, null, 2));
  const stats = store.stats("default", modelConfig().space);
  store.close();
  const live = new DatabaseSync(livePath);
  live.exec("PRAGMA busy_timeout=5000");
  const backup = resolve(dir, "before-reset.sqlite");
  live.prepare("VACUUM INTO ?").run(backup);
  live.prepare("ATTACH DATABASE ? AS fresh").run(process.env.RAG_DB_PATH);
  try {
    live.exec("BEGIN IMMEDIATE");
    live.exec("DELETE FROM memories");
    live.exec("DELETE FROM memory_stages");
    live.exec("DELETE FROM stages");
    live.exec("DELETE FROM records");
    live.exec("INSERT INTO records SELECT * FROM fresh.records");
    live.exec("INSERT INTO memories SELECT * FROM fresh.memories");
    live.exec("INSERT INTO stages SELECT * FROM fresh.stages");
    live.exec("INSERT INTO memory_stages SELECT * FROM fresh.memory_stages");
    live.exec("COMMIT");
  } catch (e) { live.exec("ROLLBACK"); throw e; }
  finally { live.close(); }
  console.log(JSON.stringify({ stats, backup, dir }));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
