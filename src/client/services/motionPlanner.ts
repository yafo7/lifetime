import {
  capabilities,
  validateAction,
  pointPosition,
  validateDocument,
  validateAnimationReferences,
  type PromptPart,
  type MotionContext,
  type MotionPlan,
} from "../../shared/motion";

export const motionProtocol = `你是 Lifetime 动作规划器。只输出一个 JSON 对象，不输出 Markdown 或代码。
document 中 type:animation 是用户拖入的确切动画引用，必须使用其 clipId，不可忽略或换成同名动画。按引用所在文本的语义安排顺序、片段和叠加。无法合理使用时返回 error。表面标点的 position 是已解析的世界坐标；height 是相对锚点的偏移，不能直接当世界高度。任何非零世界高度的路径使用 air。
只使用提供的动画库能力。缺少动画或可信片段时返回 {"error":"具体缺失能力"}，不能伪造动画、节点、分段或落地事件。
动作格式：{schemaVersion:2,name,modelRevisionId,start?:{point:标点ID},parameters?:{destination:{type:"vec3",default:[x,y,z]}},steps:[步骤]}。
步骤 id 唯一，按数组顺序运行，仅支持以下四种：
moveTo: {id,type:"moveTo",destination:{point:标点ID}或[x,y,z]或{parameter:"destination"}或{context:"actionStartPosition"},speed:场景单位每秒,path?:{mode:"ground"或"air",via?:[{point:标点ID}或[x,y,z]],height?:拱高},animation:动画引用,layers?:叠加引用数组,sync?:"independent"或"locomotion"或"fitClip",rootHeight?:"animation"或"path",finalHeading?:角度}。
playClip: {id,type:"playClip",animation:动画引用,layers?:叠加引用数组}。
turnTo: {id,type:"turnTo",heading:角度,speed:每秒角度}，或使用 target:{point:标点ID} 面向标点（heading 与 target 二选一）。wait: {id,type:"wait",seconds:秒}。
每步还允许 transition:淡入秒数，markers:[{name,at:0到1的步骤进度}]，只使用用户或能力明确确认的事件时间。
动画引用：{clipId:能力中的动画ID,segment:能力中的片段名称,rate:播放倍率,repeat:正整数或"untilArrival",start?:片段内起点秒,end?:片段内终点秒}。
只有 loop=true 的片段可重复。moveTo 的循环动画使用 untilArrival；playClip 不能用 untilArrival。
sync=independent 按移动速度计算时长；locomotion 还使用 referenceSpeed 联动倍率（必须已标定）；fitClip 让整段路径在单次片段结束时到达，实际移动速度由距离与片段耗时确定，speed 此时仅为保留参数。
叠加引用还必须包含 nodes:[明确的节点ID，包含子树],weight:0到1,blend:"override"或"additive"。叠加引用用有限 repeat，结束时淡出。
空间采用 x/z 地面平面，y 高度。ground 所有点 y=0；air 高度由路径控制，rootHeight 必须是 path。普通 moveTo 默认保留动画竖直位移，去除根节点水平位移。
不要简单叠加冲突的全身动画：移动中后空翻可用 moveTo+后空翻+fitClip；行走挥手可用节点叠加。飞踢落地优先使用一个完整片段。
提供的 points 是权威标点表，document 中的 point 引用是明确的身份引用。涉及已有标点的位置时必须输出 {point:id}，不可把其坐标写死。未放置的标点不可使用。
用户说“以 p1 为起点”才设置 start:{point:id}；说“走到 p1”则从当前演员位置移动，不能设置 start。没有明确起点就省略 start。
用户只说“在 p1 做动作”，应先 moveTo p1，再播放动作。空间点应使用 air 路径并设置 rootHeight:path。不要将离地高度误认为地面坐标；y 是高度。
不输出未定义或没有默认值的参数；所有用户指定的标点都应被正确引用。不够明确或缺少动画时返回 error，不假装执行成功。
返回动作本身，不包装 plan 字段；禁止额外字段、HTTP 调用、脚本或每帧数据。`;

export async function planMotion(
  prompt: string,
  ctx: MotionContext,
  options: {
    signal?: AbortSignal;
    fetcher?: typeof fetch;
    document?: PromptPart[];
  } = {},
): Promise<MotionPlan> {
  if (!prompt.trim()) throw new Error("请填写动作要求");
  if (options.document)
    validateDocument(options.document, ctx.points ?? [], ctx);
  const api = (
    import.meta.env.VITE_GENERATION_API ||
    "https://voxel-studio-backend.zeabur.app"
  ).replace(/\/$/, "");
  const response = await (options.fetcher ?? fetch)(`${api}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: options.signal,
    body: JSON.stringify({
      provider: "gpt",
      stream: false,
      thinking: false,
      temperature: 0.2,
      maxTokens: 6000,
      messages: [
        {
          role: "system",
          content: ctx.pool
            ? motionProtocol +
              "\n兼容旧请求：本次使用 schemaVersion:1 和能力表的 poolId；动画引用使用 slot。"
            : motionProtocol,
        },
        {
          role: "user",
          content: JSON.stringify({
            capabilities: capabilities(ctx),
            request: prompt,
            document: options.document,
            points: (ctx.points ?? []).map((p) => ({
              id: p.id,
              name: p.name,
              ground: p.ground,
              height: p.height,
              offsetMode: p.offsetMode ?? "up",
              surface: p.surface,
              position: p.ground ? pointPosition(p) : null,
            })),
          }),
        },
      ],
    }),
  });
  const result = await response.json();
  if (!response.ok || result.error || result.ok === false)
    throw new Error(result.error || `动作规划失败（${response.status}）`);
  if (typeof result.content !== "string")
    throw new Error("规划器未返回动作文件");
  const text = result.content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("规划器返回的内容不是合法 JSON；请调整要求后重试");
  }
  if (value && typeof value === "object" && "error" in value)
    throw new Error(String(value.error));
  const plan = validateAction(value, ctx);
  if (options.document)
    validateAnimationReferences(options.document, plan, ctx);
  return plan;
}
