import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { remember } from "../src/lib/rag";
import { getStore } from "../src/lib/store";
import { embed, modelConfig } from "../src/lib/providers";

async function main() {
  const dir = join(process.cwd(), "artifacts", `operations-live-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  process.env.RAG_DB_PATH = join(dir, "test.sqlite");
  const store = getStore(), space = modelConfig().space;
  assert.equal(modelConfig().mode, "live");
  const summary = "用户要求讲解时默认提供例子。";
  const vector = await embed(summary);
  const results = [];
  let mergeCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (typeof init?.body === "string") {
      const body = JSON.parse(init.body);
      if (body.messages?.[0]?.content.includes("判断两条记忆关系")) mergeCalls++;
    }
    return originalFetch(input, init);
  };
  try {
    for (const [operation, question] of [
      ["merge", "请记住，讲解时默认提供例子，这一点不变。"],
      ["replace", "以后讲解默认不要举例，我主动要的时候再给。"],
      ["delete", "请忘记我之前让你讲解时默认提供例子的偏好，删除这条记忆，不要再用它。"],
      ["add", "我平时最喜欢的运动是游泳。"],
    ]) {
      const scope = `verify-${operation}`, rawId = `${scope}-raw`;
      store.saveRecord({ id: rawId, scope, question: summary, answer: "收到", context: "[]", createdAt: "2026-10-01T00:00:00Z" });
      store.saveMemory({ id: `${scope}-old`, scope, space, summary, vector, status: "hot", sourceIds: [rawId], parentIds: [], reason: "测试初始值", createdAt: "2026-10-01T00:00:00Z" });
      const before = mergeCalls;
      const result = await remember(scope, question, "已收到你的要求。", []);
      const hot = store.memories(scope, space, "hot");
      results.push({ operation, result, mergeCalls: mergeCalls - before, hot: hot.map(m => ({ summary: m.summary, reason: m.reason })) });
      console.log(JSON.stringify(results.at(-1)));
      if (operation === "merge") assert.equal(result.merged, 1);
      if (operation === "replace") assert.equal(result.replaced, 1);
      if (operation === "delete") { assert.equal(result.deleted, 1); assert.equal(hot.length, 0); }
      if (operation === "add") { assert.equal(result.added, 1); assert.equal(hot.length, 2); }
      assert.ok(mergeCalls - before <= 1);
    }
  } finally {
    writeFileSync(join(dir, "report.json"), JSON.stringify({ results, mergeCalls }, null, 2));
    globalThis.fetch = originalFetch; store.close();
    console.log(JSON.stringify({ dir, mergeCalls }));
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
