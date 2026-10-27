import { test, expect } from "@playwright/test";

test("Markdown renders during streaming and contains wide content on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      if (input !== "/api/chat") return originalFetch(input, init);
      const encoder = new TextEncoder();
      const first = "## 测试标题\n\n**重点**与 `inline`\n\n```ts\nconst text = '" + "x".repeat(150);
      const rest = "';\n```\n\n- 第一项\n- 第二项\n\n1. 步骤一\n2. 步骤二\n\n> 引用内容\n\n| 名称 | 说明 | 状态 | 来源 |\n| --- | --- | --- | --- |\n| React | 界面 | 完成 | 文档 |\n\n[文档](https://example.com)\n\n~~旧内容~~\n\n- [x] 已完成\n\n<img src=x onerror=alert(1)>\n\n[危险链接](javascript:alert%281%29)";
      const body = new ReadableStream({ start(controller) {
        const emit = (data: object) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        emit({ type: "delta", text: first });
        (window as unknown as { finishMarkdown: () => void }).finishMarkdown = () => {
          emit({ type: "delta", text: rest });
          emit({ type: "answer", answer: first + rest });
          emit({ type: "done", memory: { message: "已保存" }, elapsedMs: 100 });
          controller.close();
        };
      } });
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    };
  });
  await page.goto("/");
  await expect(page.getByText("演示模式", { exact: true })).toBeVisible();
  await page.getByLabel("输入问题").fill("**我的原文**");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const answer = page.locator(".message.assistant .markdown-content");
  await expect(answer.getByRole("heading", { name: "测试标题" })).toBeVisible();
  await expect(answer.locator("strong")).toHaveText("重点");
  await expect(answer.locator("pre code")).toContainText("const text");
  await expect(page.getByLabel("输入问题")).toBeDisabled();
  await expect(page.locator(".message.user .message-content")).toHaveText("**我的原文**");
  await page.evaluate(() => (window as unknown as { finishMarkdown: () => void }).finishMarkdown());
  await expect(page.getByLabel("输入问题")).toBeEnabled();
  await expect(answer.locator("table tbody tr")).toHaveCount(1);
  await expect(answer.locator("ol li")).toHaveCount(2);
  await expect(answer.locator("blockquote")).toContainText("引用内容");
  await expect(answer.locator("del")).toHaveText("旧内容");
  await expect(answer.getByRole("checkbox")).toBeChecked();
  await expect(answer.getByRole("link", { name: "文档", exact: true })).toHaveAttribute("href", "https://example.com");
  await expect(answer.locator("img, script, a[href^='javascript:']")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await answer.locator("pre").evaluate(el => getComputedStyle(el).overflowX)).toBe("auto");
  expect(await answer.locator(".markdown-table-scroll").evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/markdown-mobile.png", fullPage: true });
});
