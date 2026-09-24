import type { Provider } from "../../shared/contracts";
const api = (
  import.meta.env.VITE_GENERATION_API ||
  "https://voxel-studio-backend.zeabur.app"
).replace(/\/$/, "");
interface Options {
  signal?: AbortSignal;
  onStage?: (stage: string) => void;
  fetcher?: typeof fetch;
}
export async function generateModel(
  description: string,
  provider: Provider,
  mode: string,
  options: Options = {},
): Promise<Record<string, unknown>> {
  const response = await (options.fetcher ?? fetch)(
    `${api}/api/generate/model`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description, provider, mode }),
      signal: options.signal,
    },
  );
  if (!response.ok) throw new Error(`模型生成失败（HTTP ${response.status}）`);
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    const value = await response.json();
    if (!value.modelJson) throw new Error(value.error || "生成响应缺少模型");
    return value;
  }
  if (!response.body) throw new Error("生成响应为空");
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "",
    result: Record<string, unknown> | null = null;
  const event = (block: string) => {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return;
    const value = JSON.parse(data);
    if (value.error || value.errorCode || value.stage === "error")
      throw new Error(value.error || value.errorCode || "模型生成失败");
    if (value.modelJson) result = value;
    if (value.stage) options.onStage?.(String(value.stage));
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done }).replace(/\r/g, "");
      let index: number;
      while ((index = buffer.indexOf("\n\n")) !== -1) {
        event(buffer.slice(0, index));
        buffer = buffer.slice(index + 2);
      }
      if (done) {
        if (buffer.trim()) event(buffer);
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (!result)
    throw new Error("生成连接结束，但未收到模型结果；请确认后再重试");
  return result;
}
export async function generateAnimation(
  modelJson: unknown,
  description: string,
  provider: Provider,
  mode: "quick" | "pro",
  options: Options = {},
): Promise<Record<string, unknown>> {
  const response = await (options.fetcher ?? fetch)(
    `${api}/api/generate/animation`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        modelJson,
        description,
        provider,
        mode,
        emitParticles: false,
      }),
      signal: options.signal,
    },
  );
  const result = await response.json();
  if (!response.ok || result.ok === false || result.error)
    throw new Error(result.error || `动画生成失败（HTTP ${response.status}）`);
  return result;
}
