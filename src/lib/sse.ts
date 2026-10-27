// Shared by the provider adapter and browser. Network chunks may split UTF-8 or SSE lines.
export async function* readSSE(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = "", event = "message", data: string[] = [];
  function line(value: string) {
    if (!value) {
      const result = data.length ? { event, data: data.join("\n") } : undefined;
      event = "message"; data = []; return result;
    }
    if (value.startsWith(":")) return;
    const colon = value.indexOf(":"), field = colon < 0 ? value : value.slice(0, colon);
    const content = colon < 0 ? "" : value.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = content;
    if (field === "data") data.push(content);
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const result = line(buffer.slice(0, end).replace(/\r$/, ""));
        buffer = buffer.slice(end + 1);
        if (result) yield result;
      }
      if (done) break;
    }
    if (buffer) line(buffer.replace(/\r$/, ""));
    const result = line(""); if (result) yield result;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
