# 一句话场景构建：已有素材版本

第三步当前实现 3.1 地图语义目录、3.2 自动标点与动作/状态装配，并支持已有演出的增量修改。3.3 缺失模型和动画的自动并行生成尚未接入。当前生成场景只调用一次 `/api/chat`，不调用模型或动画生成接口；素材不足时明确失败。

## 使用

在 Play 打开地图或已有演出，在右侧“一句话构建场景”输入要求并点击“生成场景”。例如：

> 让蜘蛛鸭绕池塘跑一圈，然后跑到桥中央，面向池塘跳舞并后空翻，再返回继续巡游。

系统使用演员库中的模型版本与动画，生成可在 Actors 中查看的完整动作，自动建立地图 P 点、空间输入绑定和角色状态机。成功后自动打开新演出，点击“播放全部角色”开始播放。再次输入“改为绕池塘跑三圈”会保存另一个演出版本；未提及的角色保留，次数修改复用完整动作与 P 点。

角色通行能力属于本地实例配置，AI 不填写或提高这些参数。已有实例沿用原设置；新角色按模型包围盒缩放至约 2 单位高，默认允许台阶高度 0.3。可展开“新角色通行设置”显式调整。当前庭院的桥入口约 1 单位高，蜘蛛鸭示例已设为 1.1；从空地图新建时若希望上桥，需明确配置这个能力。路径不可达或表演空间不足时不会保存演出。

## 分工和数据

```text
用户要求 + 小型地图语义目录 + 真实素材目录 + 当前逻辑方案
                   ↓ 一次 chat
          ScenePlan（地点意图、完整动作、状态关系）
                   ↓ 严格校验
  本地地点解析 → 地图 P 点/表面锚点 → NavMesh 完整路径
                   ↓
  Actors 完整动作 → Play 输入绑定 → 状态衔接/表演空间检查
                   ↓
        保存演员动作，保存新演出，用户播放
```

- `shared/mapSemantics.ts`：地点目录与查询意图，不含坐标或几何。
- `navigation/semanticIndex.ts`：从水域、模型名称/标签和已标注动线建立小型目录；包围盒等实际数据留在本地索引。桥、树、建筑的分类当前来自名称规则，无法准确命名的物件不会假装已经识别。
- `shared/scenePlan.ts`：严格意图协议、真实素材引用和当前状态摘要。禁止坐标、未知字段、虚构动画、跨模型动画绑定、不支持的状态事件。
- `scene/planner.ts`：调用已有 chat 接口。发送语义目录、模型/动画 ID 与时长、循环能力、角色及状态摘要；不发送地图完整 JSON、模型节点、动画帧、P 点坐标或 NavMesh。
- `navigation/locationResolver.ts`：地面附近、岸边、桥面中央、绕水域闭合路线、已有动线及朝向目标的本地解析。树旁站位选地面，桥中央选可通行支撑面，绕水域路线必须完整闭合且不穿水。路线搜索目前使用有限候选，并非任意地图的全局空间推理。
- `scene/actionCompiler.ts`：把意图编译为演员层完整动作。Actors 保存独立预览输入，Play 保存这些输入到实际地图 P 点的映射；不把地图坐标写进源动作。
- `scene/performanceAssembler.ts`：复制演出、保留未涉及角色、装配状态和所有可能的完成后衔接，校验后才交给保存流程。
- `scene/buildCoordinator.ts`：规划、构建、保存、取消和恢复。保存动作后使用服务端返回的实际版本绑定演出；新的演出 ID 保留原版本。
- `shared/sceneDesign.ts`：保存前校验规划元数据。`Performance.sceneDesign` 保存逻辑意图、真实实例 ID、动作/地点映射与自动点快照，用于后续修改。手动移动过的 P 点在位置意图不变时保留；手动删除实例或完整动作绑定会移除该角色的自动基线，不阻止普通编辑。

“池塘巡游”和“桥上表演并返回”各是一个完整动作，一个状态执行一个完整动作。动画倍率控制姿态采样速度，移动 speed 控制世界移动速度，两者独立。NPC 按本地状态规则运行，不调用 AI。

## 程序端口

UI 和未来的 AI 调用同一端口：

```ts
const catalogue = await window.lifetimeSceneBuilder.getCatalogue();
await window.lifetimeSceneBuilder.generate("让蜘蛛鸭绕池塘跑步"); // 一次 chat
await window.lifetimeSceneBuilder.build(scenePlan, "来自外部规划器"); // 本地，零 chat
const record = window.lifetimeSceneBuilder.getBuildState();
window.lifetimeSceneBuilder.cancel();
```

`ScenePlan` 示例结构如下；真实 ID 必须来自目录，不能使用示例占位符直接执行：

```ts
{
  schemaVersion: 1, name: "池塘巡游",
  actors: [{
    key: "duck", name: "蜘蛛鸭", actorId, modelRevisionId,
    instanceId, // 修改现有角色时必填；新增时省略
    origin: "circuit",
    locations: [{key: "circuit", featureId: "water:pond", relation: "surroundingRoute"}],
    actions: [{key: "patrol", name: "绕池塘跑步", steps: [
      {type: "followRoute", route: "circuit", animation: runClipId, speed: 3, rate: 1}
    ]}],
    states: [{key: "patrol", name: "巡游", action: "patrol", repetitions: 1, waitSeconds: 0, next: "patrol"}],
    initialState: "patrol"
  }]
}
```

步骤支持 moveTo、followRoute、playClip、face、wait。至多 8 个自动规划角色；每角色最多 12 个位置意图、12 个完整动作、12 个状态、20 个最终 P 点。一个动作最多 30 个意图步骤，展开后还需通过原动作协议的限制。已有手动角色不因未被规划而删除。删除需显式 `removeInstanceIds`，不能同时修改同一实例。

## 失败与恢复

最近一次构建记录保存在浏览器 localStorage。计划得到后，构建/保存失败可点击“继续构建”，不会重新调用 chat。保存响应丢失时，按稳定动作 ID 和内容识别已保存资源，避免重复保存版本。源动作被修改时拒绝恢复。

刷新会把进行中的构建标记为中断，需要重新打开原始演出才能继续；地图版本或原草稿改变后拒绝应用旧结果。未保存草稿无法保证跨刷新恢复。规划请求未返回计划时只能由用户重新提交；取消停止等待，不保证远端 chat 同时停止。浏览器存储不足会显示恢复不可保证，但仍允许完成资源保存。

演员动作分项原子保存，演出最后保存，二者不是一个跨资源事务。后续保存失败时已保存动作会保留，记录用于续存；不发布半成品演出，也不删除已经写入的动作。每次成功构建保存为新演出版本，旧演出与源地图保留。

本轮 API 对照沿用 `/api/chat` 的非流式协议（2026-10-08 核对在线 reference）：provider=gpt、stream=false、thinking=false；返回 content 为计划 JSON。验证使用固定规划响应，没有测试真实模型的规划质量，也没有真实素材生成请求。
