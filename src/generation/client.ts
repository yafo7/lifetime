import type { Provider } from "../shared/contracts";
export interface GenerationOptions {
  api: string;
  signal?: AbortSignal;
  onStage?: (stage: string) => void;
  fetcher?: typeof fetch;
}
export class GenerationFailure extends Error {
  constructor(
    message: string,
    readonly uncertain = false,
  ) {
    super(message);
  }
}
async function remote(options: GenerationOptions, path: string, body: unknown) {
  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(
      `${options.api.replace(/\/$/, "")}${path}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: options.signal,
      },
    );
  } catch (error) {
    throw new GenerationFailure(
      `生成连接中断，结果待确认：${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }
  if (!response.ok)
    throw new GenerationFailure(
      `生成失败（HTTP ${response.status}）`,
      response.status >= 500,
    );
  return response;
}
export async function generateModel(
  description: string,
  provider: Provider,
  mode: string,
  options: GenerationOptions,
): Promise<Record<string, unknown>> {
  const response = await remote(options, "/api/generate/model", {
    description,
    provider,
    mode,
  });
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    let value;
    try {
      value = await response.json();
    } catch {
      throw new GenerationFailure("模型连接结束但结果未收到，结果待确认", true);
    }
    if (!value.modelJson)
      throw new GenerationFailure(value.error || "生成响应缺少模型");
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
      throw new GenerationFailure(
        value.error || value.errorCode || "模型生成失败",
      );
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
  } catch (error) {
    if (error instanceof GenerationFailure) throw error;
    if (!result)
      throw new GenerationFailure(
        "生成连接中断，未收到模型结果；结果待确认",
        true,
      );
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (!result)
    throw new GenerationFailure(
      "生成连接结束，但未收到模型结果；请确认后再重试",
      true,
    );
  return result;
}
export async function generateAnimation(
  modelJson: unknown,
  description: string,
  provider: Provider,
  mode: "quick" | "pro",
  options: GenerationOptions,
): Promise<Record<string, unknown>> {
  const response = await remote(options, "/api/generate/animation", {
    modelJson,
    description,
    provider,
    mode,
    emitParticles: false,
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new GenerationFailure("动画连接结束但结果未收到，结果待确认", true);
  }
  if (!response.ok || result.ok === false || result.error)
    throw new GenerationFailure(
      result.error || `动画生成失败（HTTP ${response.status}）`,
    );
  return result;
}
