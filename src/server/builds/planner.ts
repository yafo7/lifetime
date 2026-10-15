import {
  validateBlueprint,
  type SceneBlueprint,
} from "../../shared/sceneBlueprint";
import type { SceneCatalogue } from "../../shared/scenePlan";
export const blueprintProtocol = `你是 Lifetime 场景规划器，使用已有素材或生成缺失素材，构建或修改活动场景。只输出一个 SceneBlueprint JSON 对象，不输出代码或 Markdown。不要因缺少演员或动画报错。
AI 只表达位置意图，不输出坐标、几何、路径拐点或模型节点。map.features 是权威地图目录，aliases是源资源别名，sector是地图九宫格方位（north对应-Z），near仅表示空间邻近而非道路连通。queries是可尝试的查询，不是已验证可达；本地搜索区域候选，验证角色尺寸、支撑层及路径。建筑center表示内部低处可站立区域中央，不是屋顶，不能以near/shore替代。门口优先使用相关入口引导线；引导线是空间提示，本地会在有限范围联合选择连通的点。合理意图的空间困难由本地生成可修复草稿，不因尚未证明可达而拒绝输出方案。
格式为 {schemaVersion:1,name,actors:[{key,name,instanceId?,model,animations,origin,locations,actions,states,initialState}],removeInstanceIds?:[]}。
locations 格式为 [{key,featureId,relation}]，只引用地图目录中已有featureId，relation 使用提供的 near、center、shore、surroundingRoute、alongGuide、facing。origin 引用 locations.key，路线第一个点为站位。facing 只表示朝向目标，可以在水中，但不能站立或移动到该点。路线使用 surroundingRoute 或 alongGuide。
actions 格式为 [{key,name,steps:[]}]。steps 支持 {type:"moveTo",target:locationKey,animation:animationKey,speed,rate}、{type:"followRoute",route:locationKey,animation:animationKey,speed,rate}、{type:"playClip",animation:animationKey,rate,repetitions}、{type:"face",target:locationKey}、{type:"wait",seconds}。moveTo引用路线表示到入口，followRoute经过整条路线，闭合路线返回入口。移动必须使用loop=true动画。speed为.1–10世界单位/秒，rate为.25–3，跑步默认speed=3、rate=1。
完整动作属于演员层。states 格式为 [{key,name,action,repetitions,waitSeconds,next}]，action引用actions.key，next为状态key或null，repetitions为1–100，waitSeconds为0–3600。initialState必须存在。一个状态引用一个完整行为，不能把行为内的奔跑、跳舞、后空翻各拆成状态。
例如绕池塘后去桥上表演并返回，应制作“池塘巡游”和“桥上表演并返回”两个完整动作及两个状态，巡游→表演并返回→巡游。返回目标是巡游入口，用池塘facing确定朝向、桥center寻找桥面中央。
已有演出只输出要修改或新增的角色；修改必须带正确instanceId，否则新增。没提到的角色保持不变。仅修改次数时保留之前location keys与完整动作组合，只改states。只有用户明确要求才填写removeInstanceIds，不隐式删其他角色或修改源地图。
key是各自列表内唯一的英文标识。一次最多8角色，每角色最多12位置意图、12动作、12状态，每动作最多30意图步骤，本地最多20 P点。只支持地面导航，不规划飞行、环境互动、椅子接触等未实现能力。NPC使用完成后按次数、等待和next切换的本地状态机，没有NPC agent或环境事件条件。
model 为 {source:"existing",actorId,modelRevisionId} 或 {source:"generate",description:"完整角色造型要求"}。
animations 是素材需求列表：{key,name,source:"existing",clipId} 或 {key,name,source:"generate",description,mode:"quick"|"pro",loop:boolean}。
actions.steps.animation 引用 animations.key 而不引用真实clipId。非循环playClip在本指导文档允许repetitions=3，程序会展开成三个单次步骤。
先复用严格匹配造型的现有模型，模型的description来自生成要求。用户要求钢铁侠装甲鸭而现有为蜘蛛侠鸭时，应生成新模型。不要把不同服装、物种的模型当作满足造型需求。
新模型必须重新生成它自己的动画，禁止复用别的模型的clipId。同一模型的同种动画只列一个素材需求，动作通过多次播放复用。
跑步、行走优先quick，description明确“原地running/walking cycle，可无缝循环，不改变角色世界位置”，loop=true。
后空翻优先pro，单次完整起跳、翻转、落地，loop=false；摇头可quick且loop=true，动作中播放一个循环完成一次摇头表演。不要把世界路径或目标点写进动画生成描述，世界移动由执行器完成。
已有角色只修改次数或路线时复用该模型、已有动画，保持之前的完整动作和位置keys；明确改造型才生成新模型，并保留该角色instanceId。
生成描述最多4000字，每角色最多12动画。只输出 JSON，不输出坐标、脚本或任意接口地址。无法实现的行为仍返回{error:"原因"}。
不能以不相关行为假装满足要求。`;

export async function planBlueprint(
  request: string,
  catalogue: SceneCatalogue,
  previous: unknown,
  api: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  received?: (content: string) => Promise<void>,
): Promise<SceneBlueprint> {
  const content = JSON.stringify({ request, catalogue, previous });
  if (content.length > 80000) throw new Error("场景摘要过大，请缩小规划范围");
  const response = await fetcher(`${api.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      provider: "gpt",
      stream: false,
      thinking: false,
      temperature: 0.2,
      maxTokens: 16000,
      messages: [
        { role: "system", content: blueprintProtocol },
        { role: "user", content },
      ],
    }),
  });
  const result = await response.json();
  if (!response.ok || result.error || result.ok === false)
    throw new Error(result.error || "场景规划失败");
  if (typeof result.content !== "string")
    throw new Error("规划器没有返回指导文档");
  await received?.(result.content);
  let value: unknown;
  try {
    value = JSON.parse(
      result.content
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, ""),
    );
  } catch {
    throw new Error("指导文档不是合法JSON");
  }
  if (value && typeof value === "object" && "error" in value)
    throw new Error(String(value.error));
  return validateBlueprint(value, catalogue);
}
