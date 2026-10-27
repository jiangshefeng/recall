import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { remember, retrieve, answerQuestion } from "../src/lib/rag";
import { getStore } from "../src/lib/store";
import { modelConfig } from "../src/lib/providers";

async function main() {
  const dir = resolve("artifacts", `preference-update-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  process.env.RAG_DB_PATH = resolve(dir, "test.sqlite");
  process.env.RAG_MERGE_THRESHOLD = "0.65";
  const results = [];
  for (const [scope, question] of [
    ["update", "我喜欢讲解时附带小例子。"],
    ["update", "不用给我例子，我要的时候会给你说。"],
    ["temporary", "我喜欢讲解时附带小例子。"],
    ["temporary", "仅这一次回答不用举例。"],
    ["different", "我喜欢讲解时附带小例子。"],
    ["different", "我希望回答用中文。"],
  ]) {
    const result = await remember(scope, question, "已收到。", []);
    results.push({ scope, question, ...result });
    assert.notEqual(result.action, "partial");
    console.log(JSON.stringify(results.at(-1)));
  }
  const store = getStore(), space = modelConfig().space;
  const stats = Object.fromEntries(["update", "temporary", "different"].map(s => [s, store.stats(s, space)]));
  assert.deepEqual(stats.update, { hot: 1, cold: 2, records: 2 });
  assert.equal(stats.temporary.cold, 0);
  assert.equal(stats.different.cold, 0);
  const empty = await remember("echo", "谢谢", "已确认：你喜欢中文和例子，项目使用 TypeScript。", []);
  assert.equal(store.stats("echo", space).hot, 0);
  const evidence = await retrieve("update", "以后回答需要举例吗？", "expand");
  const answer = await answerQuestion("以后回答需要举例吗？", [], evidence);
  const report = { stats, results, empty, answer, evidence };
  writeFileSync(resolve(dir, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ dir, stats, answer }));
  store.close();
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
