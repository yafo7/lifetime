# 独立 Lifetime 架构

## 业务边界

`src/client/app.ts` 只组合 Actors、Play、应用级任务及工作区切换。

- `actors/workspace.ts`：演员选择、模型版本、生成表单、动画列表。生成请求捕获演员及模型版本；异步结果不会写入后来选中的演员。
- `play/workspace.ts`：地图资源、独立演员实例、手动变换、单片段播放和演出草稿。实例引用不可变模型版本/动画 ID，既不修改源演员，也不修改源地图。
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

当前演出是基础场景与单片段预览，没有导演系统、时间线、自动寻路或自动环境融合。与旧项目的数据兼容范围是地图/渲染方案 JSON 和完整场景 ZIP，不迁移旧长动画和环境动作数据库。
