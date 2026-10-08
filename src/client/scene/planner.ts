import {
  validateScenePlan,
  type SceneCatalogue,
  type ScenePlan,
} from "../../shared/scenePlan";

export const sceneProtocol = `你是 Lifetime 场景规划器，负责使用现有素材构建或修改活动场景。只输出一个 JSON 对象，不输出代码或 Markdown。
AI 只表达位置意图，不输出任何坐标、几何、路径拐点或模型节点。map.features 是权威地图目录，queries 是支持的查询，实际点位和可达性由本地系统验证。只使用 catalogue 中存在的演员、模型和动画；没有需要的素材时返回 {error:"具体缺失的演员或动画"}。本版本不调用模型或动画生成。
格式 {schemaVersion:1,name,actors:[{key,name,actorId,modelRevisionId,instanceId?,origin,locations:[{key,featureId,relation}],actions:[{key,name,steps:[]}],states:[{key,name,action,repetitions,waitSeconds,next}],initialState}],removeInstanceIds?:[]}。
key 使用英文标识且在各自列表内唯一。origin 引用一个 locations.key；可以引用路线，其第一个点为站位。relation 使用提供的 near、center、shore、surroundingRoute、alongGuide、facing。facing 只是朝向目标，可以在水中，不能站立或移动到此点。路线使用 surroundingRoute 或 alongGuide。
steps 支持：{type:"moveTo",target:locationKey,animation:clipId,speed:每秒世界单位,rate:倍率}；{type:"followRoute",route:locationKey,animation:clipId,speed,rate}；{type:"playClip",animation:clipId,rate,repetitions}；{type:"face",target:locationKey}；{type:"wait",seconds}。
moveTo 可以引用路线，表示到路线入口。followRoute 完整经过路线，闭合路线最后返回入口。移动必须使用模型所属的 loop=true 动画。speed 为 .1–10，rate 为 .25–3，默认跑步 speed=3、rate=1。非循环表演 repetitions 必须为1；重复后空翻应使用多个 playClip 步骤。仅支持地面行走，不规划飞行、环境互动、坐到椅子等未实现能力。
完整动作属于演员层。一个状态引用一个完整动作，不能把一个完整行为里的奔跑、跳舞、后空翻各拆成状态。states 的 action 引用 actions.key；next 是状态 key 或 null，repetitions 为1–100，waitSeconds为0–3600。初始状态必须存在。
用户要求绕池塘后去桥上表演并返回，应制作“池塘巡游”和“桥上表演并返回”两个完整动作、两个状态，巡游→表演并返回→巡游。表演返回目标应为巡游路线入口。使用池塘 facing 意图确定面向池塘，桥的 center 意图寻找桥面中央。
已有演出时只输出需要修改或新增的角色；修改已有角色必须带正确 instanceId，否则视为新增独立实例。没提到的角色保持不变。用户只修改次数时保留该角色之前的 location keys 和完整动作组合，仅改 states。移除角色只有用户明确要求时才填写 removeInstanceIds。不要隐式删除其他角色，不要修改源地图。
运行时没有 NPC agent 和环境事件条件，仅支持完成后按次数、等待和 next 切换。一次至多8角色，每角色至多12位置意图、12动作、12状态，动作至多30意图步骤。本地编译后最多20 P点。无法满足时返回 error，不能以不相关行为假装满足。`;
export async function planScene(
  request: string,
  catalogue: SceneCatalogue,
  options: {
    signal?: AbortSignal;
    fetcher?: typeof fetch;
    previous?: unknown;
  } = {},
): Promise<ScenePlan> {
  if (!request.trim() || request.length > 4000)
    throw new Error("请填写4000字以内的场景要求");
  const api = (
    import.meta.env.VITE_GENERATION_API ||
    "https://voxel-studio-backend.zeabur.app"
  ).replace(/\/$/, "");
  const context = JSON.stringify({
    catalogue,
    request,
    previous: options.previous,
  });
  if (context.length > 80000)
    throw new Error("场景目录过大，请缩小演员和地图规划范围");
  const response = await (options.fetcher ?? fetch)(`${api}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: options.signal,
    body: JSON.stringify({
      provider: "gpt",
      stream: false,
      thinking: false,
      temperature: 0.2,
      maxTokens: 10000,
      messages: [
        { role: "system", content: sceneProtocol },
        { role: "user", content: context },
      ],
    }),
  });
  const result = await response.json();
  if (!response.ok || result.ok === false || result.error)
    throw new Error(result.error || `场景规划失败（${response.status}）`);
  if (typeof result.content !== "string")
    throw new Error("规划器没有返回场景计划");
  let plan: unknown;
  try {
    plan = JSON.parse(
      result.content
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, ""),
    );
  } catch {
    throw new Error("场景规划结果不是合法JSON");
  }
  if (plan && typeof plan === "object" && "error" in plan)
    throw new Error(String(plan.error));
  return validateScenePlan(plan, catalogue);
}
