# 运动接口 v2

## 资源与界面

当前模型版本的整个动画库就是可用动画目录。新动作直接引用 `clipId`，不依赖动画池、用途槽位或 `poolId`。

动作制作仅提供文本指导、地图标点、生成/取消、预览与保存。动画从左侧拖入文本形成紫色引用，标点形成蓝色引用；标点也可点击“插入”或输入 @ 选择。普通文字仍由规划器理解。

文本保存为 `PromptPart[]`，不保存 HTML：

```ts
{ type: "text", text: "从" }
{ type: "point", pointId: "稳定标点ID" }
{ type: "animation", clipId: "动画ID", modelRevisionId: "模型版本ID" }
```

动画 token 精确绑定资源及模型版本，不能用同名资源替换。前端、规划响应及服务端保存均验证引用；方案必须实际使用每个显式动画引用（含叠加层），否则报错。时间顺序和语义仍由规划器处理。删除文本引用中的点会被拦截；删除只被方案引用的点会使方案失效。

## 标点与表面锚点

坐标是 `[x,y,z]`，Y 向上；UI 使用“向上高度”或“离面距离”，不混用轴名。最多 20 个点，最终位置 x/z 范围 ±50，Y 为 0～100。

- 点主体拖放 / 点击放置：摄像机射线命中最近可见模型表面或实际地面；参考树和当前角色参与拾取，线框、标点、辅助图形不参与。重新放置会清零偏移。
- 选中点的 ↑ 手柄：固定当前世界 X/Z，沿世界 Y 调高。靠近向上的表面会磁吸（进入 0.65、脱离 1.1 场景单位），选择离意图高度最近的面，跳过底面。蓝色候选环提示，Alt 临时关闭磁吸，Esc / 失焦 / 切换工作区取消本次拖动。
- 表面点可选择“向上高度”或“离面距离”。后者沿表面世界法线偏移，斜面 / 侧面也有效；法线使用逆转置矩阵处理非均匀缩放。沿竖直方向拖离原表面锚点下方或改变偏移轴线时，点转换为基于地面的空间点。

`ActionPoint` 保留 `ground`（Y=0 的投影）和 `height`，可选 `offsetMode:up|normal` 与 `surface`。表面锚点包含 objectId/nodeId、localPosition/localNormal，以及 position/normal 世界快照。树使用稳定实例 ID，演员使用身份 + 不可变模型版本，节点由模型层级路径标识。

没有 surface 的旧点继续解析为 ground + 向上高度，不需批量迁移。有 surface 时，最终位置为已解析表面位置 + 偏移方向 × height。编辑显示、规划、校验及下次执行前通过场景解析局部锚点，保存同步世界快照。原表面缺失或失效时必须重新放置，不静默落回地面。服务端只校验序列化契约，不加载 Three.js 场景。

执行器只接收解析后的坐标快照，运行中不追踪移动表面。Actors 使用预览路径，Play 通过独立场景端口提供地图拾取、完整 NavMesh 路径与动作空间检查；两层复用执行器，不包含物理接触或 IK。

## 页内执行端口

`window.lifetimeMotion` 绑定 Actors 中当前加载的演员及动作上下文，不是后台常驻或 HTTP 遥控服务。Play 使用 `window.lifetimeSceneMotion`，将完整演员动作绑定到地图点并调度状态关系。

```ts
const motion = window.lifetimeMotion;
const caps = motion.getCapabilities();
// caps: actorInstanceId, modelRevisionId, animations, nodes, points, bounds, commands
const protocol = motion.getProtocol();
const valid = motion.validateAction(plan);
const executionId = motion.executeAction(valid, caps.actorInstanceId);
const unsubscribe = motion.subscribe(event => console.log(event));
motion.pauseExecution(executionId);
motion.resumeExecution(executionId);
motion.getExecutionState(executionId);
motion.cancelExecution(executionId);
unsubscribe();
```

直接调用移动接口示例（clipId 和目标点必须来自实际能力表）：

```ts
motion.moveTo({
  destination: {point: caps.points[0].id},
  speed: 2,
  animation: {clipId: caps.animations[0].clipId, rate: 1, repeat: 1},
  sync: "fitClip"
}, caps.actorInstanceId);
```

上例单次片段结束时到点。如果动画声明可循环，可以使用 `repeat:"untilArrival"`、`sync:"independent"`，按 speed 控制移动速度。`fitClip` 时实际速度由路径距离与片段时长决定，speed 不控制耗时。接口也接受明确坐标；UI 使用点 ID 以保留编辑能力。

## 动作协议

```json
{
  "schemaVersion": 2,
  "name": "走到 p2 后做动作",
  "modelRevisionId": "实际模型版本ID",
  "start": {"point":"p1的稳定ID"},
  "steps": [
    {
      "id":"approach", "type":"moveTo",
      "destination":{"point":"p2的稳定ID"}, "speed":2,
      "animation":{"clipId":"实际动画ID","rate":1,"repeat":"untilArrival"},
      "sync":"independent"
    },
    {
      "id":"finish", "type":"playClip",
      "animation":{"clipId":"实际动画ID","rate":1,"repeat":1}
    }
  ]
}
```

`untilArrival` 仅用于已声明可循环的片段。执行前验证模型版本、资源、循环能力及路径，不能依靠动画名称猜测循环或事件时间。

- `start` 可省略：省略时从演员当前锚点出发；明确“以 p1 为起点”才指定 start，预览开始时放置到该点。“先走到 p1”应输出 moveTo，不能通过 start 瞬移。
- `moveTo`：目的地、移动速度、动画引用；可选 `path:{mode:"ground"|"air",via:Target[],height:拱高}`、layers、sync、rootHeight、finalHeading。Target 支持 `[x,y,z]`、`{point:id}`、`{parameter:name}`、`{context:"actionStartPosition"}`。
- `playClip`：原地播放有限次数，允许 layers。
- `turnTo`：heading（度）或 target（目标引用）二选一，speed（度/秒）。target 以当前站位朝向目标的 X/Z 方向，忽略目标高度；相同水平位置无法确定方向时拒绝。
- `wait`：seconds。
- 1～100 个顺序步骤，各有唯一 id；可选 transition（0～2 秒）和 markers（归一化进度事件）。
- 动画引用：clipId、segment（默认 full）、start/end（片段内秒数）、rate、repeat。可选 nodes 遮罩、weight 和 blend（override/additive）。叠加层必须指定 nodes（包含子树），最多 4 层。
- sync=independent：按 speed 计算移动耗时。sync=locomotion：要求已标定 referenceSpeed，否则拒绝。sync=fitClip：单次片段和移动同时完成。
- 地面路径所有点 Y=0；空间点使用 air，路径拥有高度控制权。模型根部水平动画位移在动作执行时移除，地面动画默认保留竖直位移。
- 可选 parameters 仍供程序调用；当前制作 UI 不提供 JSON 参数输入，规划器应使用点引用。

轨迹支持折线和拱形飞行，无障碍物避让、足底 IK、自动接地或物理碰撞。混合不保证任意全身动画自然；执行器负责时间与变换规则，动作的艺术质量取决于源动画和规划结果。

## 编译与生命周期

开始执行前验证并编译全部步骤；错误不会中断已有动作。相同演员默认拒绝并行位置控制，`executeAction(plan, instanceId, parameters, {replace:true})` 可明确替换。UI 预览使用替换。

执行开始时解析标点，冻结本次坐标。拖点/改高度不会改变正在执行的路径；下一次预览使用新位置并重新计算时间。修改文本使方案失效，必须重新生成。生成过程中若指导或标点改变，不接受过期响应。切换演员/模型取消规划并隔离草稿。

切换模型清理执行；切换工作区暂停。暂停冻结时间与位置；停止保持姿态。中央播放按钮可重播上次执行快照；右侧预览使用当前编辑的点。完成后保留末帧，如需恢复站立由动作方案增加收尾片段。

事件：started、stepStarted、markerReached、destinationReached、stepCompleted、completed、paused、resumed、cancelled。接口保留最近执行实例，过期 executionId 拒绝操作。

## 保存与兼容

POST `/api/resources/actors/:id/motion-actions` 保存 `SavedAction`：id/name、模型版本、document、points、prompt（可读文本）、plan 及时间戳。服务端校验点、文本引用、动画绑定及方案后原子写入，不创建新动画池。

v1 的 poolId/slot 及旧 pools/actions 字段仅用于历史兼容，原数据不删除。旧动作打开时将已设默认值的坐标参数转为可编辑标点，只有用户保存才写回。若旧动作缺失必要参数或动画，需要重新生成方案。

## 文本规划与验证

规划器请求现有 `/api/chat`，输入用户指导、结构化 token、标点 ID/坐标和当前模型动画能力，不发送模型几何或整段帧数据。返回方案后执行同样的协议和运动约束校验；不自动执行、不生成缺失动画、不自动重试。

`tests/points.test.ts` 覆盖动画库直接引用、模型隔离、标点快照、起点/空间点、非法引用、规划契约和存储恢复。`tests/motionBrowserServer.ts` 在临时目录构建测试页面，并提供固定的本地规划响应；它不调用真实 AI，也不修改正式 data。真实自然语言理解质量需使用实际后端验证。


## 分段编辑与播放倍率

打开或生成 v2 动作后，预览下方按步骤显示动画及累计起止秒数。选择片段可更换当前模型版本的动画、调整 0.25～3× 倍率、原动画起止秒数及原地播放次数；已有叠加层可独立调整，并保留节点范围、权重和混合方式。点击应用提交草稿，点击“应用并从头预览”先应用表单再重播，最后使用“保存动作”持久化。修改文本后需重新生成；重新生成会覆盖手动片段调整。

移动段提供两种模式：

- **保持移动速度**：`sync:independent`，`speed` 决定移动耗时，动画倍率只影响姿态播放。循环动画自动使用 `untilArrival`；非循环动画只播一次，时长不足则拒绝应用。
- **动画结束时到达**：`sync:fitClip`，单次动画决定耗时，倍率越高到达越快，移动速度输入禁用。

`MotionPort.getOrigin()` 返回当前演员位置和朝向；`inspectAction(plan, origin?)` 返回 `{stepId,type,start,end,duration,clipId?,rate?}[]`，使用同一执行编译器计算准确时间，不启动执行。`validateAction` 可传入 origin；`executeAction` 的 options 接受 origin，供草稿重复预览保持起点。`invalidateAction()` 清除旧请求与播放状态，避免编辑后仍重播旧方案。缺省 origin 的外部调用仍从当前演员位置开始；方案显式 start 优先。

编辑校验失败保留原草稿。替换动画只修改选中的使用位置；只有旧动画已不在方案任何位置使用时才同步替换对应文本 token。旧 v1 动作仍可兼容播放，需重新生成 v2 后使用分段编辑。当前不提供拆分、排序或全动作进度拖动。动画库直接播放的倍率为临时预览设置，不写回源动画。


## 动画卡槽（2026-09-29）

动画库可直接拖入已有卡槽替换/填充，拖到末尾“＋ 拖入动画”追加原地动画，也可从空草稿开始组合。所有槽位等宽显示，不再用宽度模拟时间线。每张动画卡片有 0.25～3× 速率滑条：拖动实时显示数值，松开应用到草稿；预览执行最新方案，保存后可恢复。普通动画预览的速率滑条即时控制当前播放，不持久化到源动画。

点击 × 仅移除当前槽内的主动画，不删除步骤或路线。v2 支持：

- `moveTo.animation:null`：sync 仅能省略或为 independent，按 speed、path、destination 执行。移除 fitClip 动画时切换为 independent，耗时随原 speed 重算。
- `playClip.animation:null`：必须带有限正数 seconds，保留移除前的时长；放入动画时去掉 seconds，按新动画计算时长。
- layers 可继续存在，移除叠加动画只影响该层。没有主动画时使用静态基础姿态。

删除最后一个使用某动画的槽内引用时，同时清除对应文本动画 token；其他槽仍在使用则保留 token。替换、清空、追加都经结构及执行编译校验，失败时保留原方案。最多 100 个步骤；旧版 v1 仍需重新生成后编辑。不会删除动画库中的资源。

## 地图中的动作

Play 公开独立的 `window.lifetimeSceneMotion`，复用 v2 动作编译器；只引用演员层完整动作并绑定地图点，不使用动画卡槽编辑器。实例地图标点、完整地面寻路、独立播放与配置保存见 [scene-motion.md](scene-motion.md)。Actors 的平面/空中路径接口保持原有行为；场景动作使用地图空间和 NavMesh，不把完整地图传给 AI。

## 当前预览界面（2026-10-08）

Actors 暂时隐藏动画卡槽，保留原数据和编辑实现；Play 只提供完整动作绑定与状态规则。选中有效动作即可直接按中央播放按钮开始，不要求先点击预览。预览区显示播放/暂停、整段进度及时间；状态机的进度条表示当前状态的一次动作，拖动后暂停调度。普通动画库预览保留原控制。执行器 seeked 事件不发送被跳过的到达、片段完成或动作完成事件。
