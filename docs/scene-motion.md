# 地图动作绑定（阶段 1 / 2）

演员层拥有完整动作；演出层拥有地图位置和动作引用。地图解析、P 点解析、NavMesh 和动作执行都在本地，不调用 chat。自然语言制作演员动作仍可由用户主动调用现有规划接口。

## 操作

1. 在 Actors 的动作库制作并保存完整动作。可用文字指导，也可展开“用已有动画创建基础动作（本地）”，选择路线移动、前往表演并返回或原地表演模板。模板直接使用现有动画，不调用生成后端。
2. 在 Play 打开地图、加入演员，放置地图 P 点。点击表面或拖入地图，点保留局部表面锚点、世界坐标和离面高度。
3. 从“演员层动作库”加入完整动作，在输入绑定中为演员动作的 p1、p2 等选择实际地图 P 点。不同实例、不同地图可复用同一演员动作；演员预览坐标不自动成为地图坐标。
4. 配置初始站位与角色通行尺寸，检查路线或直接播放。系统先验证整个动作，再开始执行；无需先预览一次。进度条控制整个动作，状态机运行时控制当前状态的一次完整动作。
5. 保存演出，重新打开恢复绑定、标点、实例与状态规则。运行进度和导航缓存不保存。

Play 不提供动画卡槽、动画选择和动作内部步骤编辑；这些属于 Actors。修改演员动作后，Play 显示版本变化，需要点击“更新动作引用”并确认点位绑定后重新播放。

旧 schemaVersion 1 演出仍可读取和播放。点击“将旧动作归入演员库”时显式保存演员动作，并把演出配置转换为引用；原地图坐标、动作顺序和状态引用保留。打开旧数据不会自动写入。迁移后需保存演出。

## 数据与接口

新 `ActorInstance.sceneMotion` 使用 schemaVersion 2：

```ts
{
  schemaVersion: 2,
  points: ActionPoint[],
  actions: [{
    id: "map-action", name: "桥上表演并返回",
    actorActionId: "actor-action", actorActionUpdatedAt: 123,
    bindings: { "point:actor-preview-p1": "map-p5" }
  }],
  selectedActionId: "map-action",
  startPointId: "map-p1",
  navigation: { radius: 1, height: 2, climb: .3, slope: 35 },
  machine: CharacterMachine // 可选，见状态机文档
}
```

`shared/actionBinding.ts` 提取完整动作所需的点、参数与固定位置输入；所有空间输入都必须绑定地图点。准备执行时读取指定演员动作版本，替换目标引用，删除预览起点，复用确定性执行器。演出不存储动画步骤副本。没有绑定完成的输入允许保存为草稿，执行时拒绝。

公开 `window.lifetimeSceneMotion`：

| 方法 | 用途 |
| --- | --- |
| `getCapabilities()` / `getActorActions(instanceId)` | 当前地图、实例、动作目录及空间输入 |
| `bindAction(instanceId, actorActionId, bindings?)` | 加入完整动作引用，返回地图动作 ID |
| `updateActionBinding(instanceId, id, bindings, refresh?)` | 修改点绑定；可显式更新源版本 |
| `getConfiguration(instanceId)` | 返回独立配置副本 |
| `setConfiguration(instanceId, config)` | 原子校验、替换配置、停止旧执行并同步 UI |
| `projectPoint(instanceId, [x,y,z])` | 在小范围容差内解析可站立地面 |
| `prepareAction(instanceId, actionId?)` | 解析源动作、冻结标点、验证完整路线与表演空间 |
| `executeAction(instanceId, actionId?)` | 准备成功后执行 |
| `getExecutionState(instanceId)` | 时间、位置、朝向及执行状态 |
| `pauseExecution / resumeExecution / cancelExecution` | 每实例独立控制；停止恢复设计位姿 |
| `seekExecution(instanceId, seconds)` | 跳转当前完整动作，不补发跳过的事件 |
| `subscribe(listener)` | 开始、步骤、到达、完成等事件 |

## 导航边界

P 点保存可编辑目的地与人工途经点，NavMesh 计算实际绕行拐点。地图三角形与点位搜索留在本地，不发送 AI；几何快照独立于渲染批处理。

水下地面不进入导航；桥、坡面和台阶按实例半径、高度、坡度与台阶高度计算。旋转盒模型用实际局部体积判断实心区域，避免粗包围盒误删倾斜桥面。路径必须完整到达，细节高度只从已确定的导航通道采样，不跳到另一层表面。

现有中式庭院桥入口高约 1 个世界单位，2 单位高蜘蛛鸭进入桥面需将台阶高度设置为 1.1；默认 .3 不会强行放行。通行参数描述该角色能力，不修改源地图。

当前地图执行仅支持 ground；可编辑空间点和朝向目标，但不实现地图飞行。原地动画保留源根位移与整圈旋转，以 15 Hz 包围盒采样拒绝明显障碍重叠。此检查不保证精确身体接触、IK、脚部贴地、物理落地或动态避让。多个实例共享静态导航缓存，时钟和姿态各自独立。
