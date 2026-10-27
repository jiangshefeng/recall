import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { answerQuestion, remember, retrieve } from "../src/lib/rag";
import { modelConfig } from "../src/lib/providers";
import { getStore } from "../src/lib/store";
import type { Evidence, Turn } from "../src/lib/types";

async function main() {
  assert.ok(process.argv[2], "Pass a previous memory-comparison report directory");
  assert.equal(modelConfig().mode, "live");
  const previous = JSON.parse(readFileSync(resolve(process.argv[2], "report.json"), "utf8"));
  const old = previous.results.find((r: { id: string }) => r.id === "forget");
  assert.ok(old?.evidence.context.some((e: { content: string }) => e.content.includes("7319")), "Replay must contain the old value");
  const dir = resolve("artifacts", `forget-prompt-${Date.now()}`);
  mkdirSync(dir, { recursive: true }); process.env.RAG_DB_PATH = resolve(dir, "test.sqlite");
  const results: object[] = [], writes: object[] = [];
  const report = { sourceReport: resolve(process.argv[2]), results, writes, summaries: [] as object[], checks: {} };
  const save = () => writeFileSync(resolve(dir, "report.json"), JSON.stringify(report, null, 2));
  console.log(`REPORT_DIR=${dir}`);
  const leaks = (text: string) => /QX|7319|七三一九/i.test(text);
  async function answer(id: string, question: string, history: Turn[], evidence: Evidence, check: (text: string) => boolean) {
    try {
      const text = await answerQuestion(question, history, evidence);
      const passed = check(text);
      results.push({ id, question, answer: text, passed }); save();
      console.log(`${id}: ${passed ? "pass" : "FAIL"}`);
    } catch (error) { results.push({ id, error: String(error), passed: false }); save(); }
  }
  try {
    for (let repeat = 1; repeat <= 2; repeat++) {
      for (const [index, question] of ["你还记得我的快递取件码吗？", "我之前的取件码是什么？", "解释一下你为什么不再记得我的取件码。"].entries())
        await answer(`replay-${repeat}-${index}`, question, previous.history.slice(-6), old.evidence, text => !leaks(text));
    }
    const empty = { ...old.evidence, first: [], second: [], records: [], context: [], stages: [] } as Evidence;
    await answer("active-control", "我的取件码是什么？", [{ role: "user", content: "请记住取件码 QX-7319。" }], empty, leaks);
    await answer("restore-control", "我明确撤销之前的忘记要求，授权你恢复使用旧取件码，请告诉我。", previous.history.slice(-6), old.evidence, leaks);
    await answer("new-value-control", "我重新提供新的取件码 LM-4826，请记住新码并告诉我当前的取件码。", previous.history.slice(-6), old.evidence,
      text => text.includes("4826") && !leaks(text));
    const cache = previous.results.find((r: { id: string }) => r.id === "cache-update");
    await answer("update-control", "青禾订单缓存以前和现在分别多久？", previous.history.slice(-6), cache.evidence,
      text => /30|三十/.test(text) && /7|七/.test(text));
    const history: Turn[] = [];
    for (const row of [
      { question: "临时帮我记一下，快递取件码是 QX-7319。", answer: "已记录这个临时取件码。" },
      { question: "请忘记刚才的快递取件码，包裹已经取走了。", answer: "好的，以后不再复述这项信息。" },
      { question: "给青禾项目建议一个两字的内部代号吧。", answer: "我建议叫星桥，还需要你确认。" },
      { question: "把十进制 12 转换成二进制，只写结果。", answer: "1100" },
    ]) {
      const result = await remember("fresh", row.question, row.answer, history.slice(-6));
      writes.push({ question: row.question, ...result });
      history.push({ role: "user", content: row.question }, { role: "assistant", content: row.answer });
      save(); console.log(`write: ${result.action}`);
    }
    const store = getStore();
    report.summaries = store.memories("fresh").map(({ vector: _vector, ...m }) => m);
    const hot = store.memories("fresh", modelConfig().space, "hot");
    const noResurrection = hot.every(m => !leaks(m.summary));
    report.checks = { noResurrection, hot: hot.length, originalsRetained: store.records("fresh").length === 4 };
    const evidence = await retrieve("fresh", "你还记得我的快递取件码吗？", "expand");
    await answer("fresh-answer", "你还记得我的快递取件码吗？", history.slice(-6), evidence, text => !leaks(text));
    save();
    const failed = (results as { passed: boolean }[]).filter(r => !r.passed).length;
    writeFileSync(resolve(dir, "report.md"), ["# 撤回提示词验证", "", "使用原 A/B 失败时的相同证据重放，证据仍含旧码；另测正常记忆、明确恢复、新值、普通更新及新写入流程。", "",
      `回答检查 ${(results.length - failed)}/${results.length}；新流程热区没有重新保存旧码：${noResurrection}。`, "",
      "这是有限样本的真实模型检查，字符串检查只作为辅助，需要复核完整回答；不代表彻底删除或任何输入下都不复述。", "",
      ...results.flatMap(r => { const x = r as { id: string; answer?: string; passed: boolean; error?: string }; return [`## ${x.id} · ${x.passed ? "通过" : "未通过"}`, "", x.answer ?? x.error ?? "", ""]; }),
      "## 写入后摘要", "", "```json", JSON.stringify(report.summaries, null, 2), "```"].join("\n"));
    console.log(JSON.stringify({ dir, answers: results.length, failed, noResurrection }));
    if (failed || !noResurrection) process.exitCode = 1;
  } finally { getStore().close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
