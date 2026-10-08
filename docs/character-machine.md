# 角色状态机（阶段 2）

状态描述完整行为，执行演员层已保存、在地图上绑定好位置的完整动作。状态机只处理动作之间的关系，不编排动画片段、不生成资源、不调用 chat，也没有 NPC agent。

## 使用与验收例子

Actors 制作两个动作：

- **池塘巡游**：依次跑过路线标点并返回入口。移动动画与路线步骤在演员层定义。
- **桥上表演并返回**：跑到表演点、面向池塘、摇头跳舞、后空翻、跑回池塘边。这些都是同一个动作内部的步骤。

Play 加入这两个动作，绑定实际地图位置；创建两个状态：

```text
围绕池塘跑步 → 桥上表演并返回 → 围绕池塘跑步 → …
```

每个状态设置执行动作、执行次数、完成后等待和后续状态。后续选自身即可持续重复，选“结束并保持站位”则结束。状态和动作不是一对一：多个状态可引用同一完整动作。婆婆可以只有一个站立状态。

中央播放/暂停控制所选角色；“播放全部角色”启动启用角色或继续暂停角色。“暂停全部”冻结动作和等待时钟，“停止全部”恢复设计位姿。右侧“进入”从当前真实位置和朝向切换到指定状态。下一动作准备期间保持原位，不瞬移到演员预览起点。

中央进度条表示当前状态的一次完整动作，拖动后暂停，继续时从动作结束进入等待/后续状态。单独“预览所选动作”用于检查绑定，会退出该实例状态机。切换工作区暂停；保存、更换地图或修改配置停止旧执行。重开只恢复规则，不自动播放。

## 数据

`ActorInstance.sceneMotion.machine` 保存规则：

```ts
{
  schemaVersion: 1,
  enabled: true,
  initialStateId: "patrol",
  states: [
    { id: "patrol", name: "围绕池塘跑步", actionId: "bound-patrol",
      repetitions: 1, waitSeconds: 0, nextStateId: "show" },
    { id: "show", name: "桥上表演并返回", actionId: "bound-show",
      repetitions: 1, waitSeconds: 0, nextStateId: "patrol" }
  ]
}
```

`actionId` 指向本实例的地图动作绑定，不是 clipId。最多 100 状态，执行次数 1–100，等待 0–3600 秒。初始/后续状态与动作必须存在；被引用的动作不能直接删除。服务端保存前使用同一校验，运行时钟、派生路径与 NavMesh 不保存。

## 端口与实现

`window.lifetimeSceneMotion` 提供：

| 方法 | 用途 |
| --- | --- |
| `setStateMachine(instanceId, rules \| null)` | 原子提交或移除规则 |
| `startStateMachine(instanceId)` | 从初始状态和配置站位开始 |
| `switchState(instanceId, stateId)` | 从当前站位进入指定状态 |
| `getMachineState(instanceId)` | 当前状态/动作、阶段、次数、等待和错误 |
| `subscribeMachine(listener)` | 每实例状态变化 |
| `playAll / pauseAll / cancelAll` | 演出整体控制 |
| `pauseExecution / resumeExecution / cancelExecution` | 每实例控制 |

`shared/characterMachine.ts` 定义规则和引用校验；`motion/characterMachine.ts` 为无网络、DOM 或几何的调度器；`services/sceneMotionPort.ts` 解析动作引用并接入导航和执行器；`play/characterMachinePanel.ts` 编辑动作之间的规则，`play/sceneBindingPanel.ts` 管理位置绑定。动画与完整动作制作留在 Actors。

每次重复和切换从上一动作真实终点重新编译。完整路径与表演空间检查通过才开始；不可达、缺失资源、过期动作版本或空间不足时显示失败，该角色停止调度，其他角色不受影响。异步准备采用版本校验，编辑/停止/换图后的旧结果不会启动。

等待使用模拟时间，不使用墙钟定时器；准备期间不补播错过的时间。本版没有事件条件、角色记忆、环境互动、物理/IK 或多角色节拍同步。未来第三步生成器可调用相同的动作绑定与状态机端口，无需另一套执行逻辑。
