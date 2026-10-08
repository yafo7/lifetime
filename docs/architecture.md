# 独立 Lifetime 架构

## 业务边界

`src/client/app.ts` 只组合 Actors、Play、应用级任务及工作区切换。

- `actors/workspace.ts`：演员选择、模型版本、生成表单、动画列表。生成请求捕获演员及模型版本；异步结果不会写入后来选中的演员。
- `play/workspace.ts`：地图资源、独立演员实例、地图动作绑定、状态关系和演出草稿。新实例引用演员层完整动作与模型版本，不在 Play 制作动画步骤。
- `services/generation.ts`：严格按 API reference 直接请求两个生成接口。模型流式接收 SSE，动画接收 JSON；完整保留返回数据，不扩写提示词、不编排、不自动重发。
- `services/jobs.ts`：应用级任务，区分生成失败与保存失败。仅保存失败可重试同一个结果；重新生成必须由用户主动触发。
- `services/resources.ts`：本项目资源 HTTP 客户端。

## 渲染与数据

`rendering/viewport.ts` 管理渲染循环、相机输入和释放。`animationPlayer.ts` 每次从 rest pose 采样，位置/Euler 为增量，四元数为绝对局部旋转，停止回到静态姿态。同一演员可实例化多次，各实例独立变换和播放。

`rendering/map/client` 与 `rendering/map/shared` 是从原 Lifetime 的地图查看器入口提取的必要依赖，保留地图数据、渲染方案、地形、水、草、材质和后处理的兼容性。它们没有编辑器入口、地图生成服务、旧 HTTP 服务器或 agent；旧格式的类型和函数命名保留，便于对照。业务代码只经 Viewport 和共享资源契约使用这部分代码。

`vendor/voxel-render-runtime` 提供渲染能力；删去了不需要的生成客户端，只留下静态 LUT。`vendor/voxel-motion-runtime` 提供几何构造与旧版动画求值。二者均在仓库内部，使用同一个 Three.js；已保存资源的播放无需下载后端运行时代码。

## 本地存储

`src/server/http.ts` 只提供 `/api/resources` 和生产静态文件，不代理或调用生成后端。

| 资源 | 主要接口 | 存储约束 |
| --- | --- | --- |
| 演员 | GET/POST `/actors`，GET/PATCH `/actors/:id` | 独立演员身份与名称 |
| 模型 | POST `/actors/:id/models` | 追加不可变版本，重复保存同一结果幂等 |
| 动画 | POST `/actors/:id/clips` | 校验模型版本和节点绑定，保留原始响应 |
| 地图 | GET/POST `/maps`，GET `/maps/:id` | 导入形成独立快照，不引用原项目磁盘路径 |
| 地图包 | GET `/maps/:id/export`、`/maps/:id/hdri` | 完整资源导出和本地 HDRI 读取 |
| 演出 | GET `/performances`、GET/PUT `/performances/:id` | 地图资源 ID、演员模型版本、实例变换和播放设置 |

`store.ts` 串行化修改并以临时文件加 rename 原子写入，避免多个生成请求完成时互相覆盖。`mapFiles.ts` 处理地图包版本、路径、解压大小、资产和环境贴图校验；`src/shared` 仅承载业务契约及共享校验。

## 接口来源与限制

后端参考文档于 2026-09-24 实时读取，快照在 `api-reference-2026-09-24.md`。默认 GPT / VOXEL-PRO 和 GPT / QUICK，另提供文档中的 DeepSeek 和其他基础模式。UI 不暴露多阶段动画、合并、迁移、环境动作或其他新增工作流。

当前演出支持独立实例的地图标点、静态 NavMesh 寻路和分段动作预览，没有导演系统、NPC agent 或自动环境融合。与旧项目的数据兼容范围是地图/渲染方案 JSON 和完整场景 ZIP，不迁移旧长动画和环境动作数据库。

第二步在场景运动端口上增加简单角色状态机。`shared/characterMachine.ts` 负责规则与引用校验；`motion/characterMachine.ts` 按动作完成、重复次数、等待时间调度后续状态；`play/characterMachinePanel.ts` 编辑规则。地图几何、路径编译与动作空间检查仍由原场景端口负责，状态切换从实际位置继续。运行时每个实例独立，规则随演出保存；不保存运行时钟、不调用 chat、不引入 NPC agent。具体接口见 [character-machine.md](character-machine.md)。


## 动画库、标点与动作执行

- `shared/motion.ts`：v2 动作协议、标点与文本 token 契约、动画目录和严格校验。新动作使用 clipId，不依赖 poolId；v1 兼容旧动作。
- `actors/actionPanel.ts`：完整动作草稿、动作库、生成/预览/保存及异步结果隔离。制作输入为文本和预览标点；`actionTemplatePanel.ts` 与 `shared/actionTemplates.ts` 直接用已有动画制作基础模板，无需 chat。动画卡槽隐藏，保留数据与编辑模块。
- `actors/pointPrompt.ts`：contenteditable 输入适配器，保存 text / point / animation token 而不是 HTML；支持拖放、插入和 @ 提示。
- `actors/scenePoints.ts`：标点表面拖放、竖直手柄、磁吸提示与偏移投影。通过 Viewport 的 pickSurface / projectPoint 接口使用相机。
- `rendering/surfacePicker.ts`：显式模型注册、最近表面求交、局部锚点解析、世界法线和磁吸迟滞；不依赖 DOM 或 WebGL 上下文。
- `services/motionPlanner.ts`：将文本 token、权威标点表、当前动画目录交给现有 `/api/chat`；只返回方案，不自动执行或生成缺失动画。固定响应仅用于测试。
- `services/motionPort.ts`：公开 `window.lifetimeMotion`，提供能力（含标点位置）、校验、执行及播放控制。
- `motion/runtime.ts`：无 DOM/网络依赖的确定性执行器；执行开始前解析标点/参数并编译全部步骤。运行使用坐标快照，下一次执行重新解析点的位置；显式 start 设置起点。
- `rendering/animationPlayer.ts`：连续采样、节点遮罩与加法/覆盖混合。Viewport 分离运动锚点与动画根位移；初始相机按演员包围盒取景。
- `Actor.motionActions` 保存文本 token、标点及方案；服务端在原子写入前验证引用和模型版本。旧 pools/actions 字段保留，不因打开旧数据触发写入。
- 四棵参考树位于地面半轴中点；标点吸附当前可见模型表面或 100×100 地面；支持世界向上及表面法线偏移。标点不是地图编辑对象。
- Actors 端口控制独立预览，支持地面折线和空中路径；Play 使用独立的场景端口接入地图地面导航，双方复用执行编译器。当前没有 IK 或物理求解。

协议与边界见 [motion-api.md](motion-api.md)。


## 动作分段编辑

- `actors/actionTimeline.ts` 显示各步骤的累计时间、动画和倍率，选中后编辑主动画或已有叠加层。界面负责表单，不维护另一套播放时钟。
- `motion/editing.ts` 复制并修改 v2 方案，验证动画绑定、取段与文本引用；`motion/runtime.ts` 的 `inspectAction` 复用执行编译器计算时长。几何与时长校验通过后，ActionPanel 才提交草稿。
- 移动速度与动画倍率独立：保持移动速度时，循环动画播放到目标点；动画结束时到达则以单次片段时长决定移动耗时。原地动画按取段、倍率和次数计算时长，后续片段自动顺延。
- 草稿缓存预览起点与朝向，重复预览从同一起点执行；应用编辑会清除旧播放快照。保存沿用现有动作资源协议，原始动画资源不被修改。
- 普通动画库预览倍率仅控制当前预览，切换动画恢复 1×。卡槽编辑模块保留在 Actors，当前界面隐藏；Play 只绑定完整动作，不引用这个编辑组件。两层的完整动作进度条复用执行时钟。


## 动画卡槽解耦

卡槽对应顺序步骤，空间指令与 `animation` 引用分开。v2 的 moveTo / playClip 允许 `animation:null`：移动空槽按 speed 和路线执行；原地空槽使用 seconds 保留时间。执行器在没有主动画时使用静态姿态，已有叠加层仍独立执行。移除 fitClip 主动画后改用 independent，按原 speed 重新计算耗时。

`motion/editing.ts` 提供 clearAnimation / appendAnimation / editAnimation，统一复制草稿、校验版本及同步引用；UI 不直接修改源资源。动画库使用现有稳定动画 MIME，卡槽校验模型版本后接收拖放；提供选择框作为键盘操作入口。卡片上的速率滑条松开即提交该槽倍率，时间由执行器重算；进一步取段等设置仍显式应用。保存使用既有动作存储接口。

## 地图动作底层能力

`shared/sceneMotion.ts` 定义实例的 P 点、动作引用、起始站位与通行尺寸，服务端保存前校验资源绑定与地图边界。新 schemaVersion 2 不保存动画步骤：`shared/actionBinding.ts` 提取演员动作的空间输入，`play/sceneBindingPanel.ts` 将它们绑定到实际地图 P 点。执行前读取已确认的源动作版本、替换目标引用并交给同一个执行器。旧 schemaVersion 1 可读取和播放，显式迁移时才把内嵌动作保存到演员库。

`navigation/geometry.ts` 从本仓库地图资源提取世界空间三角形和可拾取表面，独立于渲染批处理/裁剪。旋转盒使用局部体积检测，避免粗包围盒误删斜面；其他碰撞类型保守处理。`navigation.worker.ts` 使用 Recast 构建静态 NavMesh；`navigation.ts` 用 Detour 解析完整路径和同一通道的细节高度，保留人工途经点。通行尺寸按缩放后的实例计算，地图或参数改变后重新构建。

`services/sceneMotionPort.ts` 统一准备、执行、暂停、取消、结构化配置与事件，每实例一套 `MotionRuntime`。环境适配器负责地面路线；执行器只维护确定性时间、位姿和片段。原地动画保留根位移与整圈旋转，移动段去掉重复水平根位移。`navigation/actionClearance.ts` 以独立模型采样原地动作包围盒，提前拒绝明显的障碍重叠；不求解身体接触或修复源动画。

演出只保存源资源引用、设计位姿与可编辑配置；运行轨迹、执行进度、NavMesh 为临时状态。保存重开重新解析锚点并计算路线。完整接口与限制见 [scene-motion.md](scene-motion.md)。
