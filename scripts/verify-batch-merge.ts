import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { remember } from "../src/lib/rag";
import { getStore } from "../src/lib/store";
import { modelConfig } from "../src/lib/providers";

async function main() {
  const dir = resolve("artifacts", `batch-merge-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  process.env.RAG_DB_PATH = resolve(dir, "test.sqlite");
  const originalFetch = globalThis.fetch;
  let summaryCalls = 0, mergeCalls = 0, batchItems = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input).includes("chat/completions") && typeof init?.body === "string") {
      const body = JSON.parse(init.body);
      const system = body.messages[0].content as string;
      if (system.includes("提炼当前问答")) summaryCalls++;
      if (system.includes("批量合并任务")) {
        mergeCalls++;
        batchItems = JSON.parse(body.messages[1].content).jobs.length;
      }
    }
    return originalFetch(input, init);
  };
  try {
    const first = await remember("batch", "截至2026年9月，项目青山使用 Node.js 20；项目青山数据库备份保留7天。", "已记录。", []);
    assert.equal(mergeCalls, 0);
    const second = await remember("batch", "从2026年10月26日起，项目青山的 Node.js 从20升级到22；同日起数据库备份保留期从7天改为14天。", "已记录。", []);
    const stats = getStore().stats("batch", modelConfig().space);
    const report = { first, second, summaryCalls, mergeCalls, batchItems, stats,
      memories: getStore().memories("batch").map(({ vector, ...m }) => m) };
    writeFileSync(resolve(dir, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ dir, first, second, summaryCalls, mergeCalls, batchItems, stats }));
    assert.equal(summaryCalls, 2);
    assert.equal(mergeCalls, 1);
    assert.ok(batchItems >= 2);
    assert.equal(second.merged, 2);
    assert.equal(second.action, "merged");
  } finally {
    globalThis.fetch = originalFetch;
    getStore().close();
  }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
