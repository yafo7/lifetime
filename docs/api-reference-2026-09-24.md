# Voxel Studio Backend — API Reference

> **适用场景**：用 AI 生成低多边形 3D 模型和动画。本指南面向第三方前端集成——涵盖所有需要正确渲染的信息。

---

## 目录

1. [快速开始](#1-快速开始)
2. [端点总览](#2-端点总览)
3. [模型生成](#3-模型生成)
4. [修改模型 (Refine)](#34-修改已有模型--post-apirefinemodel)
5. [装载配件 (Mount)](#35-装载配件--post-apimount)
6. [拆分部位 (Extract Part)](#36-拆分部位--post-apiextractpart)
7. [动画生成](#5-动画生成)
8. [模板模块 (Runtime)](#6-模板模块-runtime)
9. [粒子系统](#7-粒子系统)
10. [简单 LLM 对话](#8-简单-llm-对话)
11. [完整集成示例](#9-完整集成示例)
12. [错误处理](#10-错误处理)
13. [注意事项](#11-注意事项)

---

## 1. 快速开始

```js
// 两个线上端点互为备份，任选其一：
const API = 'https://voxelstudio.site';                    // 主（自定义域名，Vercel）
// const API = 'https://voxel-studio-backend.zeabur.app';  // 备（Zeabur）

// 生成一个模型
const resp = await fetch(`${API}/api/generate/model`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ description: 'a lowpoly knight', provider: 'gpt', mode: 'standard' }),
});
const text = await resp.text();
// 解析 SSE 取 modelJson
```

---

## 2. 端点总览

| 端点 | 方法 | 返回 | 用途 |
|------|------|------|------|
| `/health` | GET | `{"ok":true}` | 健康检查 |
| `/api/docs/:name` | GET | `text/markdown` | 拉取参考文档，例如 `/api/docs/api-reference` 返回本文件 |
| `/api/generate/model` | POST | SSE 流 | 生成单个模型 |
| `/api/generate/batch` | POST | SSE 流；`stream:false` 时为 JSON | 批量生成多个模型 |
| `/api/generate/replay` | POST | JSON | 多形态重放： seeded 模型换种子重出新形态（见 §3.2） |
| `/api/generate/animation` | POST | JSON | **动画统一入口**，用 `mode` 字段路由到 quick / pro |
| `/api/refine/model` | POST | JSON | AI 修改已有模型 |
| `/api/mount` | POST | JSON | 装载配件（武器/穿戴/配饰）到已有模型 |
| `/api/extract/part` | POST | JSON | 把一个 group 子树从模型中拆分出来（见 §3.6） |
| `/api/chat` | POST | SSE 流；`stream:false` 时为 JSON | 简单 LLM 对话 |
| `/api/templates/module.js` | GET | ES Module | runtime（动画模板 + 几何构建 + 粒子转换） |
| `/api/templates/geometry-schema.js` | GET | ES Module | 几何参数 schema（module.js 相对 import） |
| `/api/animation/resample` | POST | JSON | 已有 baked 动画按帧段变速重采样（可选 utility，见 §5.2 `_speedSegments` 字段） |
| `/api/transfer/animation` | POST | JSON | 动画迁移：把一个模型的 baked 动画适配到另一个结构不同的模型（见 §5.3） |
| `/api/combine/animations` | POST | JSON | 动画合并：把多个 baked 动画按顺序拼接成一个更长的动画（见 §5.4） |

**向后兼容**：以下 legacy 端点仍可用，新集成推荐直接用 `/api/generate/animation`。

| Legacy 端点 | 等价于 |
|---|---|
| `POST /api/generate/animation-quick` | `/api/generate/animation` + `mode:"quick"` |
| `POST /api/generate/animation-pro` | `/api/generate/animation` + `mode:"pro"` + `description` |
| `POST /api/generate/animation-pro-multiphase` | `/api/generate/animation` + `mode:"pro"` + `phases` |

---

## 3. 模型生成

### 3.1 单个模型 — `POST /api/generate/model`

**Provider 选项**（所有生成端点通用）：

| key | 说明 |
|---|---|
| `gpt` | GPT 模型（默认） |
| `deepseek` | DeepSeek（thinking 固定关闭） |

`provider` 字段可省略，省略时默认 `gpt`。

**deepseek provider 专属**：

- 可用 `model` 字段指定具体模型；一般无需传，省略时由服务端决定。
- **thinking 固定关闭**，请求级开思考入口不提供。
- 生成耗时参考（voxel 模式）：单件 2–6s。

请求示例：

```json
{ "description": "一只戴帽子的柴犬", "provider": "deepseek", "mode": "voxel" }
```

> **旧 provider 值（`glm` / `fireworks` / `deepseek-v4-pro`）已停止维护**：传入不会报错，但可能随时移除。请传 `gpt` / `deepseek` 或省略。

**失败兜底**（gpt 系 provider 默认开启）：`gpt` 请求生成失败（限速、上游错误、生成结果无效等，已含服务端自动重试）时，服务端自动换 `deepseek` 完整重跑一次，以保证有输出。客户端无需任何处理——兜底成功的响应与正常响应格式完全一致，模型元数据 `_meta.ai.provider` 记录实际生成者；`deepseek` 自身的失败不触发兜底。请求体传 `forceProvider: true` 可禁用兜底（失败即原样失败，A/B 对照等场景用）；不传或传 `false` 均为默认兜底行为。适用所有 provider 可选的端点。

`mode`（必填；旧字段 `promptMode` 仍兼容）：

| 值 | 说明 |
|---|---|---|
| `standard`（默认）| 标准生成，质量最高 |
| `lite` | 快速生成，适合简单模型 |
| `voxel` | 体素风格（仅 box + group，~20 box 抽象） |
| `voxel-pro` | 体素高细节（仅 box，60-100 mesh，整体感优先） |
| `curve` | 曲线风格（sphere/cyl/torus，偏符号感） |
| `wire` | 金属铁丝勾线风格（极细 cyl + 极少 tri，抽象符号化） |
| `math` | 数学美学（仅 box，分形/螺旋/黄金比例等数学结构生成形态） |

> **voxel-pro mesh 限制**：所有几何节点 `mesh.type` 均为 `box`，前端按 box 参数（`width`/`height`/`depth`）渲染即可。返回格式与其他 mode 完全一致，无需特殊处理。

**`materialTags`（可选，材质标签系统）**：传入材质词表 JSON 对象时启用材质语义标签。后端按词表规则生成，返回的 `nodes[].tags` 携带标签（见 §3.2）。省略或空对象 → 不启用，输出无任何材质相关字段。与 `mode` 正交，所有 mode 都支持。词表格式参考 `material-tags-v1.json`。

**`refs`（可选，参考模型）**：最多 3 个参考模型，用于"风格类似但按描述生成新模型"的场景（如同一风格的系列机器人）。每个元素为 `{ "model": <modelJson>, "note": "借用说明，≤40字" }`，`note` 可省，也接受直接传裸 modelJson。AI 充分参考各 ref 的设计，生成满足 description 的新模型并从各 ref 借用风格/配色/细节参数；**描述与 ref 冲突时以描述为准，ref 之间冲突时按数组顺序（靠前优先）**。ref 须含 `_meta.ai` 元数据（即 AI 生成的模型），否则该 ref 被忽略。与 `mode` 正交，所有 mode 都支持；`/api/generate/batch` 传入时**所有 description 共享同一组 refs**。

**`seeded`（可选，多形态生成）**：传 `true` 时生成的模型为多形态模型——同一模型用不同种子重放会得到不同的个体形态：结构与数值都可能变化（如分叉数量、部件有无、尺寸颜色），描述对应的整体轮廓、主体比例与色彩主题保持稳定。返回的 `modelJson` 携带 `_meta.seed` 标记（`{ v, seed }`）；重放通过 `POST /api/generate/replay` 完成（毫秒级、无 LLM 调用，见 §3.2「多形态（种子化）模型」）。省略或 `false` → 单一形态生成：不携带 `_meta.seed`，不可种子重放。与 `mode` 正交，所有 mode 都支持；`seed`（可选数字）指定初始种子用于定点复现，省略则随机。

**请求**
```json
{
  "description": "a lowpoly knight with a sword and shield",
  "provider": "gpt",
  "mode": "standard",
  "seeded": true,
  "materialTags": { "README": { "...": "词表 README" }, "tags": { "base": { "...": "..." } } },
  "refs": [
    { "model": { "...": "参考模型 modelJson" }, "note": "借用配色和比例" },
    { "model": { "...": "参考模型 modelJson" } }
  ]
}
```

**返回：SSE 流**

```
event: blockout
data: {"stage":"blockout","text":"Analyzing description..."}

event: thinking_start
data: {"stage":"thinking_start"}

event: thinking_done
data: {"stage":"thinking_done"}

event: result
data: {"stage":"result","done":true,"modelJson":{...}}

event: error
data: {"stage":"error","errorCode":"GENERATION_FAILED"}
```

SSE 事件类型：
- `blockout` — 结构分析阶段
- `thinking_start` / `thinking_done` — AI 思考中，可用于 UI 加载动画。**`provider=deepseek` 时思考固定关闭，这两个事件不会出现**（provider=gpt 时有，且为思考摘要）
- `result` — 完成，`modelJson` 是渲染就绪的模型数据
- `error` — 生成失败，读取 `errorCode`；当前值为 `GENERATION_FAILED`。

**前端解析示例**：
```js
async function generateModel(description) {
  const resp = await fetch(`${API}/api/generate/model`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description, provider: 'gpt', mode: 'standard' }),
  });
  const text = await resp.text();
  let modelJson = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const event = JSON.parse(line.slice(5).trim());
    if (event.stage === 'error') throw new Error(event.errorCode || 'GENERATION_FAILED');
    if (event.done || event.stage === 'result') {
      modelJson = event.modelJson;
    }
  }
  return modelJson;
}
```

#### Description 示例（按 mode 选合适风格）

```json
{ "mode": "standard",  "description": "a lowpoly knight with a sword and kite shield, red plume on the helmet" }
{ "mode": "voxel-pro", "description": "a chubby robot with a single dome head, compact body, stubby legs" }
{ "mode": "curve",     "description": "a round chubby cat with small pointed ears and a long tail" }
```

**写法要点**：一句话主体 + 1~2 个识别特征 > 长描述堆细节；想要的颜色/比例直接写进 description（AI 按 60-30-10 配色分配）；不要写"emblem/logo"式描述（所有 mode 都要求立体物体本身）。

### 3.2 modelJson 格式（v2）

生成返回的 modelJson 是 **v2 格式**（`format: 2`）：一个**扁平 `nodes` 数组**，每个 node 的 transform 都是**相对父级的局部坐标**，层级由 `parent` 字段表达。

```json
{
  "name": "Knight",
  "type": "lowpoly",
  "format": 2,
  "nodes": [
    { "id": "body", "transform": { "pos": [0, 2.5, 0] } },
    { "id": "m0", "parent": "body",
      "transform": { "pos": [0, 0, 0] },
      "mesh": { "type": "box", "params": { "width": 2, "height": 3, "depth": 1.4 }, "color": 10066329 } },
    { "id": "m5", "parent": "upperArmR",
      "transform": { "pos": [0.19, -0.32, 0.16], "quat": [0.61, 0, -0.73, 0.33] },
      "mesh": { "type": "cylinder",
                "params": { "radiusTop": 0.18, "radiusBottom": 0.2, "height": 0.9, "radialSegments": 8 },
                "color": 9055202, "boneFrom": "upperArmR_wp0", "boneTo": "upperArmR_wp1" } },
    { "id": "torch_head", "parent": "body",
      "transform": { "pos": [0, 4, 0] },
      "mesh": { "type": "sphere", "params": { "radius": 0.3 }, "color": 16753920 },
      "tags": [ { "tag": "fire", "value": 0.75, "variant": "normal" } ] }
  ],
  "_meta": { "skipAutoCenter": true, "ai": { "v": 1, "data": "<encrypted>", "edits": "" } }
}
```

**group vs mesh**：node 有 `mesh` → 几何叶节点；无 `mesh` → group（= 动画骨骼节点）。动画 `baked.animation` 的 key 是 group id（group 即骨骼）。

#### ⚠️ 朝向（最常见的渲染错误）

`cylinder` / `cone` 的默认轴是 **+Y（竖直）**。斜向件的朝向由 node 的 **`transform.quat`** 给出。**渲染时必须 `obj.quaternion.set(...quat)`**，否则所有圆柱竖直 → 模型朝向全错。

#### node 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 唯一 id |
| `parent` | string | 父 node id（省略则根） |
| `transform.pos` | `[x,y,z]` | **相对父级的局部偏移** |
| `transform.quat` | `[x,y,z,w]` | 朝向（cylinder/cone 必需）。默认轴 +Y，quat 将 +Y 转到目标方向 |
| `transform.scale` | `[sx,sy,sz]` | 可选的非均匀缩放，默认 `[1,1,1]`。应用前建议检查全 > 0 |
| `mesh` | object | 有 → 叶几何节点；无 → group |
| `mesh.type` | string | `box sphere cylinder cone torus wedge tri patch icosahedron dodecahedron octahedron` |
| `mesh.params` | object | 几何参数（完整表见 §6）。用 `runtime.buildGeometry(type, params)` 构建 |
| `mesh.color` | number | `0xRRGGBB` 简写 |
| `mesh.material` | object | 完整材质 `{color, roughness?, metalness?, opacity?, transparent?, flatShading?}`，存在时覆盖 `color` |
| `mesh.boneFrom` / `mesh.boneTo` | string | chain/connect 圆柱的骨骼端点（动画链检测用；静态渲染可忽略） |
| `tags` | array? | 可选。材质语义标签，仅当请求启用 `materialTags` 时出现。见下方「材质标签渲染约定」 |
| `label` | string? | 可选。mesh 节点的语义名（2~6 字中文，如 `胸甲`/`剑刃`），仅关键 mesh 携带。渲染端忽略；编辑/动画等语义消费方使用 |
| `with` | object? | 可选。与 `label` 配套的批量件序号（如 `{i:3}`），仅批量件携带。渲染端忽略；动画等语义消费方使用 |

#### 顶层字段

| 字段 | 说明 |
|------|------|
| `name` / `type` | 模型名 / 固定 `lowpoly` |
| `format` | `2`（版本号，渲染器可 feature-detect） |
| `_meta.skipAutoCenter` | 渲染端忽略 |
| `_meta.ai` | 渲染端忽略 |
| `_meta.semanticSnapshot` | 可选。模型语义快照 `{ v, text, stats }`——`text` 为紧凑文本摘要（group 层级/代表 mesh/批量件规律），供动画、组合等下游管线使用。生成、修改（§3.4）、装配（§3.5）返回的 `modelJson` 都会携带最新快照；模型无 group 时该字段不存在。渲染端忽略 |

#### 材质标签渲染约定

当请求传入非空 `materialTags` 时，`nodes[]` 的任意节点（group 或 mesh）可能携带可选 `tags` 数组，每条形如：

```json
{ "tag": "base", "value": "gold" }                    // enum 模式:每部件至多一个
{ "tag": "fire", "value": 0.75, "variant": "green" }  // blend 模式:value ∈ {0,0.25,0.5,0.75,1};variant 仅部分 tag 支持
```

渲染端约定：

- **继承**：group 节点的 tags 沿 `parent` 链向下传播给所有后代 mesh；mesh 节点重新声明同名 tag 覆盖继承值。收集一个 mesh 的有效 tags = 沿父链向上取所有 group tags，再用 mesh 自身 tags 覆盖同名项。
- **编译**：渲染端用有效 tags 查词表（`material-tags-v1.json`）编译成分层材质（effect layers）+ 可选粒子（companion），完全覆盖节点 `mesh.color` / `mesh.material` 的基础着色。同一个 `(tag, value, variant)` 组合的部件 batch key 相同，可合批。
- **未实现的 tag**：词表中 `status: notImplemented` 的 tag（如 electric/poison/ice/wet 等）渲染端先落默认材质；数据格式已冻结，渲染层补齐后存量模型自动生效，前端不应因遇到未知 tag 报错。
- **无 tags 字段**：请求未传 `materialTags` 时，所有节点都没有 `tags` 字段（不是空数组），渲染端走常规 `mesh.color` / `mesh.material`。

#### 多形态（种子化）模型

请求带 `seeded: true` 时，返回的 `modelJson` 顶层 `_meta.seed` 为 `{ "v": 1, "seed": <初始种子> }`。这类模型可用不同种子重放出不同的个体形态：

**`POST /api/generate/replay`**（JSON，非流式）

请求：`modelJson` 传要重放的多形态模型（即 `seeded` 生成返回的那个 modelJson，完整传入、不要删减字段——重放所需的信息就记录在它身上）；`seed` 传新种子。

```json
{
  "modelJson": { "...": "要重放的多形态模型 modelJson" },
  "seed": 12345
}
```

返回：**同一模型在新种子下重新计算出的形态**——结构和数值都可能不同于传入的模型（例如分叉数量不同），并非把传入内容原样返回：

```json
{ "ok": true, "seed": 12345, "modelJson": { "...": "新种子下的模型" } }
```

行为约定：

- 重放后的 `modelJson` 与普通模型格式完全一致，直接走既有加载/渲染/动画路径，下游无需任何适配
- 同一模型换种子：**结构与数值都可能变化**（如分叉数量、部件有无、尺寸颜色）；描述对应的整体轮廓、主体比例与色彩主题保持稳定
- 同一 `seed` 永远得到同一形态；`group id` 与首次生成一致、`mesh id` 按确定顺序生成——已有动画/挂载引用保持有效
- 返回的 modelJson 可继续 replay 或 refine
- 错误：`400 no_metadata`（模型缺少重放所需元数据）/ `400 metadata_corrupted` / `422 replay_exec_failed`

### 3.3 批量生成 — `POST /api/generate/batch`

**请求**
```json
{
  "descriptions": ["a knight", "a dragon", "a castle"],
  "provider": "gpt",
  "mode": "standard",
  "materialTags": { "README": {}, "tags": {} },
  "refs": [{ "model": { "...": "参考模型 modelJson" }, "note": "系列风格基准" }]
}
```

> `materialTags`、`refs` 可选，语义同 §3.1。若提供，则应用到批量内的每一个 description——`refs` 共享即"风格一致但功能不同"的系列生成。`seeded: true` 同样适用于批量（每个模型独立随机种子）。

**返回：SSE 流（默认）**
```text
event: start
data: {"stage":"start","total":3}

event: item
data: {"stage":"item","completed":1,"total":3,"result":{"success":true,"index":0,"modelJson":{...},"name":"Knight","meshCount":85}}

event: item
data: {"stage":"item","completed":2,"total":3,"result":{"success":false,"index":2,"errorCode":"GENERATION_FAILED"}}

event: done
data: {"stage":"done","total":3,"succeeded":2,"failed":1,"results":[...]}
```

> 默认返回 `text/event-stream`，后端仍按现有并发策略启动任务，但每个模型完成后立即发送一个 `item` 事件，失败项不阻塞其他项。

**兼容 JSON 返回**

请求体传入 `"stream": false` 时，返回旧版普通 JSON：

```json
{
  "total": 3,
  "succeeded": 3,
  "failed": 0,
  "results": [
    { "success": true, "index": 0, "modelJson": {...}, "name": "Knight", "meshCount": 85 },
    { "success": false, "index": 2, "errorCode": "GENERATION_FAILED" }
  ]
}
```

### 3.4 修改已有模型 — `POST /api/refine/model`

对已生成的模型进行 AI 修改。需要模型保留 `_meta.ai` 元数据（仅限通过 `/api/generate/model` 生成的模型）。

**请求**
```json
{
  "modelJson": { ... },
  "description": "make the sword bigger, add a cape",
  "provider": "gpt",
  "refModelJson": { ... },
  "materialTags": { "README": {}, "tags": {} }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `modelJson` | object | 完整模型数据（须含 `_meta.ai`） |
| `description` | string | 修改描述 |
| `provider` | string | AI provider，取值同模型生成（`gpt` / `deepseek`）。**省略时默认 `deepseek`** |
| `refModelJson` | object? | 可选参考模型（须含 `_meta.ai`，即 AI 生成的模型）。AI 充分参考 ref 的设计（颜色/形状参数/数量/装饰/组合关系）进行修改（如"穿上 ref 这件衣服"）。**原模型 mode 优先**——不强制采用 ref 的 mode 约束。无 AI 元数据的 ref 会被忽略 |
| `materialTags` | object? | 可选材质词表，语义同 §3.1。提供时 AI 会给部件打/改 `tags`，返回的 `nodes[].tags` 反映新标签；省略则不启用材质系统 |

**返回：JSON**
```json
{
  "ok": true,
  "modelJson": { ... }
}
```

**错误**
| error | 含义 |
|-------|------|
| `no_metadata` | 模型缺少 AI 元数据（非 AI 生成或手动编辑过） |
| `metadata_corrupted` | 元数据损坏，需重新生成模型 |

> **非流式**。Refine 一次返回完整结果，不像模型生成那样走 SSE。返回的 `modelJson` 会按修改后的结构重建 `_meta.semanticSnapshot`（见 §3.2 字段表）；模型无 group 时该字段被移除。

#### Description 示例

```json
{ "description": "make the sword 1.5x longer and add a glowing gem on the hilt" }
{ "description": "wear the ref armor on torso and shoulders", "refModelJson": { ... } }
{ "description": "add a tattered red cape flowing behind the back" }
```

**写法要点**：写**最小修改**（"加一顶帽子" 而非 "重新设计这个角色"）；要改多处 → 分多次调用；用 `refModelJson` 时明确"以 ref 为准、装到主模型 X 部位"；尊重原 mode（voxel 模型别要求"光滑球面"）。

### 3.5 装载配件 — `POST /api/mount`

将配件（武器/穿戴/配饰）装到已有模型上。primary 必须保留 `_meta.ai` 元数据；`secondary` 传文字描述时 AI 直接生成并装配（单次完成，配件与主模型坐标/比例/骨骼对齐），传模型数据时按现有模型装配。

**请求**
```json
{
  "primary": { ... },
  "secondary": "文字描述",
  "description": "右手持枪，枪口朝上",
  "provider": "gpt"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `primary` | object | 完整模型数据（须含 `_meta.ai`） |
| `secondary` | object \| string | 配件模型数据（须含 `_meta.ai`）或文字描述（AI 自动生成并装配） |
| `description` | string | 可选。装配说明，如"戴在头上"、"右手持枪"；也可以直接写进 `secondary` 描述里。缺省时 AI 自动选择合理挂载点 |
| `provider` | string | AI provider，同模型生成 |

**返回：JSON**
```json
{
  "ok": true,
  "modelJson": { ... },
  "mountedGroupId": "mount01_wizard_hat"
}
```
```

**错误**

| error | 含义 |
|-------|------|
| `no_metadata` | primary 或 secondary 缺少 AI 元数据 |
| `metadata_corrupted` | 元数据损坏 |
| `invalid plan` | AI 输出无法解析 |

> **非流式**。返回的 `modelJson` 中，配件 mesh 位于 `mounted: true` 的 group 下，前端可据此识别可拆卸部件；`_meta.semanticSnapshot` 按挂载后的结构重建（文字描述路径的配件 mesh 带 label，模型路径保留 secondary 原 label）。

#### Description 示例

```json
{ "primary": { ... }, "secondary": "a sword", "description": "held in the right hand, blade pointing down" }
{ "primary": { ... }, "secondary": "a wide-brim hat", "description": "worn on the head, brim pointing forward" }
{ "primary": { ... }, "secondary": "a round shield", "description": "attached to the left shoulder, facing outward" }
```

**写法要点**：写**装配意图 + 朝向**（"右手持枪，枪口朝上"），不要写精确坐标；写大小意图（"小一点的背包"）帮助 AI 选 scale；`secondary` 是字符串时用最朴素描述（"a sword"），装配关系写在 `description`；一次只装一个配件。

### 3.6 拆分部位 — `POST /api/extract/part`

把模型的一个部位（group 子树）拆下来，返回**两个独立模型**：拆出的部分（extract）和剩下的部分（rest）。适合"把机器鸟的翅膀拆下来"这类需求——拆出的部位可作为独立资产保存、单独动画、或再 mount 回去。

**`groupId` 与 `description` 二选一**：要么直接指定 group，要么用自然语言描述让 AI 解析。两者都传时以 `groupId` 为准，`description` 被忽略。

方式一 — 直接指定 group（推荐）：
```json
{ "modelJson": { ... }, "groupId": "leftWing" }
```

方式二 — 自然语言描述：
```json
{ "modelJson": { ... }, "description": "左边那个翅膀", "provider": "gpt" }
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `modelJson` | object | 必填。要拆分的完整模型（v2 格式，带 `nodes` 数组） |
| `groupId` | string? | 目标 group 的 id；也接受 group 的 name（如 `"左翅膀"`）。与 `description` 二选一 |
| `description` | string? | 部位的自然语言描述（如 `"左边那个翅膀"`），由 AI 从模型结构（含语义快照）中选出最匹配的 group |
| `provider` | string? | AI provider，取值同模型生成（`gpt` / `deepseek`）。**省略时默认 `deepseek`**。需要 AI 的内部步骤使用 |

**返回：JSON**
```json
{
  "ok": true,
  "groupId": "leftWing",
  "groupName": "左翅膀",
  "extract": { "name": "机械鸟·左翅膀", "format": 2, "nodes": [ ... ], "_meta": { ... } },
  "rest":    { "name": "机械鸟",         "format": 2, "nodes": [ ... ], "_meta": { ... } }
}
```

| 字段 | 说明 |
|------|------|
| `groupId` / `groupName` | 实际拆出的 group（`description` 输入时由此得知解析结果） |
| `extract` | 拆出的子树模型。根 group 的 `transform` 已换算成**世界坐标**，其后代节点坐标不变——模型拆下来**原地不动**，渲染时无需任何平移补偿。`name` 为 `原名·部位名` |
| `rest` | 剩余节点的完整模型，各节点坐标与输入完全一致，`name` 沿用原名 |

两个模型都重建了 `_meta.semanticSnapshot` 和 group OBB（`_obb`），可直接用于动画生成。

**渲染与后续使用**

- 两个模型都是标准 v2 modelJson，按 §3.2 渲染即可。`extract` 保留在世界原位；若想居中展示，按其 AABB 自行居中（`_meta.skipAutoCenter` 已置 true，引擎不会自动居中）。
- 可再修改性：输入模型带 AI 元数据时，两个输出通常各自内嵌新的 `_meta.ai`，可直接传给 `/api/refine/model` 或作为 secondary 传给 `/api/mount`。检查 `modelJson._meta?.ai?.data` 是否存在即可判断（缺失时 refine 会报 `no_metadata`）。
- 动画兼容：原模型的动画若引用了被拆走的 group id，在对方模型上已无对应节点——前端加载两侧模型时应按 group id 过滤失效的动画 track。

**边界情况**

- 目标必须是 group（无 `mesh` 的节点），传 mesh id 报 `group_not_found`。
- `rest` 中可能留下**空 group**（其子节点整个被拆走）——这是有意的：保留骨骼节点，动画引用不悬空。渲染时空 group 无几何，不影响显示。
- chain（链体）整体跟随其所属 group：拆 chain 所在的 group 会带走整条 chain（含全部 waypoint group）；拆 chain **中间某个 waypoint** 得到的是从该关节开始的链尾。
- 拆分以输入 modelJson 为准——之前的手动编辑（位移/改色）保留在对应一侧的节点数据里；两侧模型的编辑历史（`_meta.ai.edits`）重置为空。

**错误**

| error | 含义 |
|-------|------|
| `modelJson with nodes required` | 缺少模型 |
| `groupId or description required` | 两个选择器都没传 |
| `group_not_found` | 目标不存在。响应附 `candidates`（现有 group id 列表）供前端提示 |

> **非流式**。`groupId` 直配时通常瞬间返回；`description` 需要一次 AI 解析。

---

## 5. 动画生成

动画分两种模式：
- **Quick**（数值轨道 baked，适合循环/简单动作）→ §5.1
- **Pro**（逐帧烘焙数据，适合复杂攻击/连招/分阶段变速）→ §5.2

### 5.0 统一入口 — `POST /api/generate/animation`

**推荐入口**，用 `mode` 字段路由到 quick / pro。三个 legacy 端点（`/api/generate/animation-quick` 等）等价于下表的便捷写法，详见 §2。

| `mode` | 必填字段 | 行为 |
|---|---|---|
| `"quick"`（默认）| `description` | Quick 动画 → 返回 baked 逐帧数值轨道（与 Pro 同格式，见 §5.1） |
| `"pro"` | `description` 或 `phases` | Pro 动画 → 返回 baked 逐帧数据。传 `description` 走单阶段；传 `phases` 走多阶段串联 |

```json
// Quick
{ "mode": "quick", "modelJson": { ... }, "description": "running cycle" }

// Pro 单 description
{ "mode": "pro", "modelJson": { ... }, "description": "wind up and slash..." }

// Pro 多阶段
{ "mode": "pro", "modelJson": { ... }, "phases": [{ "name": "蓄力", "description": "..." }, ...] }
```

> **关于 `duration` 字段**：所有动画端点的 `duration` 字段**仍然接受**（向后兼容）但**不再传给 AI**——动画时长由 AI 根据动作内容自动决定（基于 tween/path 终点自动推导）。详见 §11 注意事项。

> **动画端点的 `provider`**：与模型生成一致，支持 `gpt`（默认）和 `deepseek`（thinking 固定关闭）。deepseek 下动画生成无思考事件、延迟显著更低，前端切换 provider 无需其它改动。

### 5.1 Quick 动画（数值轨道 baked）

#### 请求

```json
{
  "mode": "quick",
  "modelJson": { ... },
  "description": "running cycle, arms swinging",
  "provider": "gpt",
  "emitParticles": false
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `mode` | string | 统一入口必填 `"quick"`；调用 legacy `/api/generate/animation-quick` 时可省略 |
| `modelJson` | object | 模型数据 |
| `description` | string | 动画描述 |
| `duration` | number? | **已废弃**——AI 自动决定。请求体仍接受但不传给 AI |
| `provider` | string | AI provider，同模型生成 |
| `emitParticles` | boolean | 是否生成粒子特效（见 `baked.emit`），默认 false |
| `vfxTags` | object? | 可选 VFX 词汇表 JSON。提供时启用 VFX 系统（见 `baked.vfx` 与 §7.5）。省略则不启用 |

**返回：JSON**——后端直接返回烘焙好的**逐帧数值轨道**，前端按帧采样播放即可，无需任何动画求值逻辑：

```json
{
  "ok": true,
  "baked": {
    "fps": 60,
    "duration": 1.2,
    "loop": false,
    "animation": {
      "rightArm": {
        "posX": [0, 0, 0, ...],
        "posY": [0, 0.01, 0.03, ...],
        "posZ": [0, 0, 0, ...],
        "rotX": [0, -0.12, -0.45, ...],
        "rotY": [0, 0.02, 0.08, ...],
        "rotZ": [0, -0.31, -1.02, ...]
      }
    }
  }
}
```

##### `baked` 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `fps` | number | 帧率（固定 60）。第 `i` 帧的时间 = `i / fps`；总帧数 = `ceil(duration × fps) + 1` |
| `duration` | number | 动画总时长（秒），由 AI 根据动作内容决定 |
| `loop` | bool | 是否循环（循环类动作为 true） |
| `animation` | object | 按 group id 索引的数值轨道（见下）。只包含参与动画的 group |
| `vfx` | object? | 可选，仅请求传 `vfxTags` 且 AI 使用了 VFX 时出现：`{ "continuous": [{ "target": groupId, ...preset参数 }], "events": [] }`（结构同 Pro，见 §7.5） |
| `emit` | object? | 可选，仅 `emitParticles: true` 且 AI 使用了粒子时出现：`{ [groupId]: { "emit": { ...嵌套emit配置 } } }`（emit 配置 schema 见 §7） |

##### `baked.animation[group]` 轨道结构

每个 group 是 6 条等长数组（长度 = 总帧数）：

| 轨道 | 含义 |
|------|------|
| `posX/posY/posZ` | position **增量**（叠加到 group 的基础 position） |
| `rotX/rotY/rotZ` | rotation **增量**（弧度，Euler XYZ 序，叠加到基础 rotation） |

**渲染采样**：播放时间 `t` → 帧号 `f = clamp(round(t × fps), 0, 帧数-1)`（循环时先 `t % duration`），逐 group 读取 6 条轨道的第 `f` 个元素，叠加到基础姿态。数值已圆整到 4 位小数。

#### 前端播放

```js
function sampleFrame(baked, t) {
  const dur = baked.loop ? baked.duration : Math.min(t, baked.duration);
  const f = Math.max(0, Math.min(baked.animation[Object.keys(baked.animation)[0]].rotX.length - 1,
    Math.round((dur % baked.duration || 0.0001) * baked.fps)));
  const pose = {};
  for (const [gid, tr] of Object.entries(baked.animation)) {
    pose[gid] = {
      position: [tr.posX[f], tr.posY[f], tr.posZ[f]],
      rotation: [tr.rotX[f], tr.rotY[f], tr.rotZ[f]],
    };
  }
  return pose;  // ⚠️ 增量，叠加到基础姿态（同 Pro）
}
```

#### Description 示例

```json
{ "mode": "quick", "modelJson": { ... }, "description": "running cycle" }
{ "mode": "quick", "modelJson": { ... }, "description": "idle breathing with subtle body sway" }
{ "mode": "quick", "modelJson": { ... }, "description": "slash sword diagonally from upper right to lower left" }
```

**写法要点**：
- **关键词决定 loop / one-shot**（后端自动路由）：含 `attack/hit/strike/slash/stab/jump/throw/launch/shoot/dash/charge/砍/刺/劈/砸/跳/扔/冲撞` → one-shot（启用 envelope 三段曲线：蓄力→爆发→收招）；其他（`idle/walk/run/fly/breathe/swim/挥手/风吹`）→ loop
- Loop 类用状态词，一句话够（`"running cycle"` 比 "双腿交替摆动，身体上下起伏" 更有效）
- One-shot 类用动词，描述完整动作流程
- 模型 group 命名质量影响动画质量：`rightArm` / `head` / `leftLeg` 远好于 `m0` / `g1`

---

### 5.2 Pro 动画（逐帧烘焙）

Pro 模式由后端生成精确的**逐帧动画数据**（baked animation），前端只需按帧采样播放。Pro 模式有两种调用形式——**单 description（推荐日常用法）** 和 **phases 数组（需要分阶段 UI 标签时用）**。

**适用场景**：复杂攻击/技能/连招、需要精确节奏控制、需要分阶段变速播放。

后端会**自动检测**单阶段动画里的"攻击核心"帧段（基于武器 quaternion 角速度峰值），通过 `_speedSegments` 字段返回变速建议——前端可直接用它做"蓄力慢、攻击快"播放，无需手动配置 phases。

#### 端点

| 端点 | 用途 |
|------|------|
| `POST /api/generate/animation` | **推荐**统一入口。`mode:"pro"` + `description` 走单阶段；`mode:"pro"` + `phases` 走多阶段 |
| `POST /api/generate/animation-pro` | legacy 简写——等价于 unified + 单 `description` |
| `POST /api/generate/animation-pro-multiphase` | legacy 简写——等价于 unified + `phases` |

#### 单 description 请求（推荐）

```json
{
  "mode": "pro",
  "modelJson": { ... },
  "description": "wind up the sword behind the right shoulder, then slash diagonally from upper right to lower left, recover to guard stance",
  "provider": "gpt",
  "vfxTags": { ... }
}
```

#### 多阶段请求（phases 数组）

```json
{
  "mode": "pro",
  "modelJson": { ... },
  "phases": [
    { "name": "蓄力", "description": "身体下蹲蓄力，双臂后摆" },
    { "name": "攻击", "description": "挥剑前劈" },
    { "name": "收招", "description": "回到待机姿态" }
  ],
  "provider": "gpt",
  "vfxTags": { ... }
}
```

#### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `mode` | string | 统一入口必填 `"pro"`；调用 legacy 端点时可省略 |
| `modelJson` | object | 模型数据（含 group 节点结构） |
| `description` | string? | 单阶段形式必填（与 `phases` 二选一）。自然语言描述完整动作流程 |
| `phases` | array? | 多阶段形式必填（与 `description` 二选一）。1~N 个阶段按数组顺序串联 |
| `phases[].name` | string? | 阶段名（用于前端 UI 显示）。省略时为 `"阶段 N"` |
| `phases[].description` | string | 该阶段的自然语言动作描述 |
| `phases[].duration` | number? | **已废弃**——AI 自动决定。请求体仍接受但不传给 AI |
| `provider` | string? | AI provider（同模型生成） |
| `vfxTags` | object? | 可选 VFX 词表（语义同 Quick 模式，见 §7.5） |

#### 响应

```json
{
  "ok": true,
  "mode": "pro",
  "baked": {
    "fps": 60,
    "duration": 1.4,
    "loop": false,
    "animation": {
      "body":     { "posX": [0,0,0,...], "posY": [0,0.05,0.1,...], "posZ": [0,0,0,...], "rotX": [0,0,0,...], "rotY": [0,0,0,...], "rotZ": [0,0,0,...] },
      "rightArm": { "posX": [...], "posY": [...], "posZ": [...], "rotX": [...], "rotY": [...], "rotZ": [...] }
    },
    "vfx": { "continuous": [...], "events": [...] }
  },
  "phases": [
    { "index": 0, "name": "蓄力", "description": "...", "duration": 0.8, "startSec": 0.0, "endSec": 0.8 },
    { "index": 1, "name": "攻击", "description": "...", "duration": 0.6, "startSec": 0.8, "endSec": 1.4 }
  ],
  "_phaseCount": 2,
  "_phaseBoundaries": [
    { "index": 0, "startFrame": 0,   "endFrame": 47 },
    { "index": 1, "startFrame": 48,  "endFrame": 83 }
  ],
  "_suggestedSpeeds": [0.8, 2.0],
  "_speedSegments": [
    { "startFrame": 0,  "endFrame": 47,  "speed": 0.8 },
    { "startFrame": 48, "endFrame": 83,  "speed": 2.0 }
  ]
}
```

> `_phaseBoundaries` / `_suggestedSpeeds` / `_speedSegments` 是后端**赠送给前端的变速建议**——前端想用就用、不想用就忽略，详见下方字段说明。

##### `baked` 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `fps` | number | 帧率（固定 60）。帧间隔 = `1 / fps` |
| `duration` | number | 动画总时长（秒）= 各 phase 时长之和 |
| `loop` | bool | 是否循环。多阶段通常 `false` |
| `animation` | object | 按 group id 索引的逐帧数据（见下） |
| `vfx` | object? | 可选，仅在请求传 `vfxTags` 且 AI 使用了 VFX 时出现：`{ continuous: [{ target, ...preset参数 }], events: [] }`（见 §7.5） |

##### `baked.animation[group]` 轨道结构

每个 group 是 6 条等长数组（结构同 Quick §5.1）：`posX/posY/posZ`（position 增量）、`rotX/rotY/rotZ`（rotation 增量，弧度，Euler XYZ 序），全部叠加到基础姿态。

**渲染采样**：帧号 `f = clamp(round(t × fps), 0, 帧数-1)`，直接读第 `f` 个数组元素（无需插值——帧已按 60fps 密集烘焙）。

##### `phases[]` 元数据

| 字段 | 类型 | 说明 |
|------|------|------|
| `index` | number | 阶段序号（0-based） |
| `name` | string | 阶段名（来自请求或默认 `"阶段 N"`） |
| `description` | string | 原始描述（来自请求） |
| `duration` | number | 该阶段时长（秒） |
| `startSec` | number | 阶段在总时间轴上的起始时间 |
| `endSec` | number | 阶段在总时间轴上的结束时间 |

阶段时间窗口连续且覆盖整段动画：`phases[0].startSec == 0`，`phases[N-1].endSec == baked.duration`，相邻阶段 `prev.endSec == next.startSec`。

##### `_speedSegments` / `_suggestedSpeeds` / `_phaseBoundaries`

后端响应的**可选变速建议字段**——不是请求参数，前端想用就用、不想用就忽略。

| 字段 | 类型 | 说明 |
|------|------|------|
| `_phaseBoundaries` | array? | 每个 phase 在 baked 帧数轴上的起止帧（fps=60，帧 i 时间 = `i / 60`）|
| `_suggestedSpeeds` | array? | 与 `phases` 等长的播放倍率建议。`1.0` = 正常，`2.0` = 加速一倍，`0.5` = 慢放一倍 |
| `_speedSegments` | array? | 实际可应用的帧段变速列表。结构 `{ startFrame, endFrame, speed }`。**没检测到合适节奏时为 `undefined`** |

**生成规则**：
- **多阶段 + 含攻击阶段**：按 phase 边界分速。攻击阶段（`description` 含 `attack/strike/slash/stab/chop/slash/砍/刺/劈/砸/挥` 等关键词）`2.0×`，其他 `0.8×`
- **单阶段攻击动画**：自动检测武器 quaternion 角速度峰值找出"攻击核心"段 → `2.0×`；如果蓄力段 >25% 总时长也加速 → `1.5×`；收招段保持正常
- **非攻击动画 / 节奏均匀**：返回 `undefined`，前端按线性时间播放即可

**前端三种用法**：
- **A（推荐）**：播放循环里读 `_speedSegments`，根据当前帧落在哪个 segment 调整时间步进——零额外请求
- **B**：完全忽略，按线性时间播放——动画照常工作，只是没节奏感
- **C**：把 segments 传给 `/api/animation/resample`（§5.3）让后端重采样，多一次 HTTP

#### 前端播放（分阶段变速）

`phases[]` 的核心用途是**让前端独立控制每个阶段的播放速率**，无需重新请求后端。例：

```js
// 1) 按时间 t 在 baked.animation 上采样（线性插值）
function sampleAt(baked, t) {
  const out = {};
  for (const [gid, frames] of Object.entries(baked.animation)) {
    const times = Object.keys(frames).map(Number).sort((a, b) => a - b);
    let prevT = times[0], nextT = times.at(-1);
    for (const tk of times) {
      if (tk <= t) prevT = tk;
      if (tk >= t) { nextT = tk; break; }
    }
    const alpha = nextT === prevT ? 0 : (t - prevT) / (nextT - prevT);
    const a = frames[prevT.toFixed(3)], b = frames[nextT.toFixed(3)];
    out[gid] = a.map((v, i) => (v == null || b[i] == null) ? null : v + (b[i] - v) * alpha);
  }
  return out;
}

// 2) 播放循环：根据 t 落在哪个 phase 应用对应速率
function playProAnimation(baked, phases) {
  const rateByName = { '蓄力': 0.5, '攻击': 1.5, '收招': 1.0 }; // 用户配置
  let t = 0;
  let lastTs = performance.now();
  function frame(now) {
    const dt = (now - lastTs) / 1000; lastTs = now;
    const ph = phases.find(p => t >= p.startSec && t < p.endSec);
    const rate = ph ? (rateByName[ph.name] ?? 1.0) : 1.0;
    t += dt * rate;
    if (t >= baked.duration) {
      if (baked.loop) t %= baked.duration;
      else return; // 停止
    }
    const pose = sampleAt(baked, t);
    // 把 pose 的 position/rotation/scale 增量叠加到 group 的基础姿态，applyToScene(pose);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
```

> **增量叠加**：`baked.animation` 存的是**相对基础姿态的增量**（不是绝对值）。每帧渲染时 = group 的 rest pose + frame delta。停止播放时清除增量即恢复 rest pose。

#### Description 示例

**单 description 形式（推荐日常用法）**：

```json
{ "mode": "pro", "modelJson": { ... },
  "description": "wind up the sword behind the right shoulder, then slash diagonally from upper right to lower left, recover to guard stance" }

{ "mode": "pro", "modelJson": { ... },
  "description": "crouch and leap forward, midair bring the sword down in a heavy overhead chop, land with one hand on the ground" }

{ "mode": "pro", "modelJson": { ... },
  "description": "gather fire energy between both palms, then thrust hands forward to release a fireball" }
```

**多阶段形式（需要分阶段 UI 标签时用）**：

```json
{ "mode": "pro", "modelJson": { ... },
  "phases": [
    { "name": "蓄力", "description": "下蹲蓄力，剑收到肩后" },
    { "name": "挥砍", "description": "右下到左上斜劈，剑刃冒火焰" },
    { "name": "收招", "description": "回到持剑警戒姿态" }
  ] }
```

**写法要点**：
- **单 description 是日常用法**——AI 在沙箱里自己编排"蓄力→攻击→收招"整段动作，后端 `_speedSegments` 自动检测攻击核心并加速，无需手动配 phases
- **phases 数组是高级用法**——只在需要前端给每阶段起 UI 标签、用户单独调每阶段速度时用
- description 写**完整动作流程**（含起势、爆发、收尾），用动词（slash/thrust/cast/jump/leap）而非状态词
- multiphase 推荐 2~4 阶段，每阶段聚焦一个核心动作

#### 错误

| HTTP | 含义 |
|------|------|
| 400 | `phases must be an array with at least 1 entry` — phases 缺失或为空 |
| 500 | `Phase N failed: <原因>` — 第 N 阶段生成失败，message 含具体原因（429/rate_limited 等） |

---

### 5.3 动画迁移 — `POST /api/transfer/animation`

把一个模型的**已烘焙动画**迁移到另一个结构不同的模型上：动作意图与节奏被重新适配到目标模型的关节上；若目标模型缺少实现该动作所需的结构（如源动画靠挥臂而目标无任何肢体），返回业务错误而非硬凑结果。

**请求**

```json
{
  "sourceModel": { ... },
  "sourceAnimation": { "fps": 60, "duration": 1.2, "loop": false, "animation": { ... } },
  "targetModel": { ... },
  "provider": "gpt"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `sourceModel` | object | 动画原宿主模型（完整 modelJson） |
| `sourceAnimation` | object | 该模型的 baked animation（§5.2 的 `baked` 字段原样传入） |
| `targetModel` | object | 迁移目标模型（完整 modelJson，须含至少一个 group 节点） |
| `provider` | string? | AI provider（同模型生成，默认 `gpt`） |

**响应（成功 — 动作已适配到目标模型）**

```json
{
  "ok": true,
  "mode": "transfer",
  "baked": { "fps": 60, "duration": 1.2, "loop": false, "animation": { "torso_root": { ... }, "limb_R": { ... } } }
}
```

`baked` 结构与 §5.2 完全一致（逐帧数据、按目标模型的 group id 索引），前端用同一套采样/播放逻辑渲染。

**响应（业务拒绝 — 模型差异过大，无法迁移）**

```json
{ "ok": false, "error": "MODELS_TOO_DIFFERENT", "reason": "目标模型缺少…（人类可读说明）" }
```

HTTP 仍为 200 —— 这是业务结果而非服务器错误，前端应把 `reason` 展示给用户。

**错误**

| HTTP | 含义 |
|------|------|
| 400 | `sourceModel is required` / `targetModel is required` / `sourceAnimation (baked animation or Quick motionPlan object) is required` — 参数缺失 |
| 400 | `Invalid provider: ...` — provider 不合法 |
| 429 | `rate_limited` — 该 provider 被限速 |
| 500 | 迁移烘焙失败（如 LLM 输出无法执行） |

**注意事项**
- 适配是语义级的：源动画的"双臂挥剑斜斩"迁移到持斧模型会变成"持斧斜斩"；骨骼 id、身体比例、武器类型均可不同。
- `{ ok: false, error: "EMPTY_ANIMATION" }` 表示源动画没有任何运动数据（所有 group 静止），同样返回 200。
- 耗时与 Pro 动画生成同级（一次 LLM 调用 + 烘焙），前端按 Pro 动画的加载体验处理即可。

---

### 5.4 动画合并 `/api/combine/animations`

把多个**同一模型**的 baked 动画按顺序拼接成一个更长的动画。纯几何/数值运算，不调用 LLM。

**请求**：

```json
POST /api/combine/animations
Content-Type: application/json

{
  "animations": [ baked, baked, ... ],
  "loop": true,
  "crossfade": 0.2,
  "tailBlend": 0.5,
  "fps": 60
}
```

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `animations` | `baked[]` | 必填 | 按播放顺序排列（≥1 个）。接受三种包装：bare baked `{fps,duration,loop,animation}`、编辑器动画 `{codeAnim}`、游戏剪辑 `{_baked}` |
| `loop` | `boolean` | `true` | 结果是否循环。循环时自动把结尾 `tailBlend` 秒平滑过渡回首帧姿态（无缝循环） |
| `crossfade` | `number` | `0.2` | 段落接缝两侧的平滑过渡秒数：上一段结尾朝下一段开场姿态过渡、下一段开头从上一段结尾姿态淡入 |
| `tailBlend` | `number` | `0.5` | 循环闭合的尾部过渡秒数（仅 `loop:true`） |
| `fps` | `number` | `60` | 输出帧率。各段按此帧率线性重采样（quaternion 用 slerp） |
| `smooth` | `boolean` | `true` | 逐帧平滑：限制相邻帧角速度（上限 0.45 rad/帧），把旧片段自带的单帧瞬移拉平成连续快动作 |

**行为细节**：

- **总时长 = 各段时长之和**（接缝过渡不缩短时长）。
- **组取并集**：某段没有的组在该段时间里保持 rest（单位四元数/零欧拉），并在接缝处平滑进出——"这段没驱动这个部位"。
- **四元数轨道一致性**：某组只在部分片段带 quat 轨道时，该组整体降级为欧拉轨道（保证帧数对齐），并在 `warnings` 里说明。
- `warnings` 数组列出接缝/旧片段残留的逐帧跳变与降级行为；为空即完全平滑。

**响应**：

```json
{ "ok": true, "baked": { "fps": 60, "duration": 14.83, "loop": true, "animation": { ... } }, "warnings": [] }
```

`baked` 格式与 `/api/generate/animation`、`/api/transfer/animation` 的输出一致，可直接用于播放、编辑器保存或再迁移。

---

## 6. 模板模块 (Runtime)

### `GET /api/templates/module.js`

返回一个 ES Module，是前端的运行时核心。几何参数 schema 单独 serve 在 `GET /api/templates/geometry-schema.js`，module.js 会相对 import 它——无需 bundler，浏览器原生 ESM。

**THREE 注入（推荐）**——不必污染全局 `window.THREE`：
```js
import * as THREE from 'three';
const mod = await import(`${API}/api/templates/module.js`);
const runtime = mod.create({ THREE });   // 绑定 THREE 实例
```

**向后兼容**：不调 `create()` 时回退到全局 `THREE`；`mod.voxelStudioRuntime` 也仍导出。

### Runtime API

```js
const rt = mod.create({ THREE });

// ═══ 动画 ═══

// 列出所有动画模板（slider UI 用）
rt.listAnimationTemplates()
// → [{ key:'bounce', label:'Bounce', params:[{key:'amplitude',type:'float',min:-1,max:1,default:0.2,curve:2.5},...], isLooping:true }, ...]

// ⚠️ emit 模板的 params 使用扁平 key（如 velDirX, colorStartR），与 plan 中的嵌套 emit config 不同。
// 用下面的 flattenEmitConfig / unflattenEmitConfig 在 flat ↔ nested 之间转换。

// 评估完整 Motion Plan（仅旧版 plan 存档回放/编辑器用；新响应为 baked 数值轨道）— v2: (plan, duration, t, lookups?)
//   lookups = { getPart(id), getChildren(id) }，解耦具体 model 表示；
//   wave/tilt 等需要结构信息的模板从 lookups 取，无则安全降级。
rt.evaluateMotion(plan, duration, t, lookups)
// → { groupId: { position:[dx,dy,dz], rotation:[rx,ry,rz], scale:[sx,sy,sz]|null } }
//   ⚠️ 返回值是增量（delta），需叠加到基础姿态

// 评估单个模板（Canvas 曲线预览用）
rt.evaluateTemplate(name, params, t, duration)
// → { position:[x,y,z] } 或 { rotation:[rx,ry,rz] } 或 { scale:[sx,sy,sz] }

// ═══ 粒子 ═══

// 将 plan 中的嵌套 emit config 转为扁平 key（slider UI 用）
rt.flattenEmitConfig(nestedConfig)
// nested:  { rate:20, velocity:{dir:[0,1,0],speed:[1,3],spread:0.3}, acceleration:[0,-2,0], ... }
// flat:    { rate:20, velDirX:0, velDirY:1, velDirZ:0, velSpeedMin:1, velSpeedMax:3, ... }

// 将扁平 slider key 还原为嵌套 emit config（写入 plan / 传给粒子系统）
rt.unflattenEmitConfig(flatConfig)
// flat → nested（结构与上面相反）

// ═══ 几何 ═══

// 列出所有已知几何类型
rt.listGeometryTypes()
// → ['box','sphere','cylinder','cone','torus','wedge','tri','patch','icosahedron','dodecahedron','octahedron']

// 构建 Three.js geometry
rt.buildGeometry(type, params)
// → THREE.BoxGeometry / THREE.BufferGeometry / ...
// 类型不存在时 throw Error
```

### `evaluateMotion` 返回值

每个 group 返回的是**增量（delta）**，不是绝对位姿：

```js
{
  position: [dx, dy, dz],  // 位移增量
  rotation: [rx, ry, rz],  // 旋转增量（弧度）
  scale: null | [sx,sy,sz] // 缩放，null 表示不变
}
```

> **⚠️ 关键**：必须将 delta **叠加**到 group 的基础姿态上（加/乘），不可直接赋值替换。见 §8 集成示例。

### `buildGeometry` 参数

每种 type 的 `geometry` 参数（括号内为默认值）：

| type | geometry 参数 |
|------|---------------|
| `box` | `width`(1), `height`(1), `depth`(1) |
| `sphere` | `radius`(1), `widthSegments`(8), `heightSegments`(6) |
| `cylinder` | `radiusTop`(1), `radiusBottom`(1), `height`(1), `radialSegments`(8) |
| `cone` | `radius`(1), `height`(1), `radialSegments`(8) |
| `torus` | `radius`(1), `tube`(0.3), `radialSegments`(8), `tubularSegments`(12) |
| `icosahedron` / `dodecahedron` / `octahedron` | `radius`(1), `detail`(0) |
| `wedge` | `width`(1), `height`(1), `depth`(1) |
| `tri` | `a`[x,y,z], `b`[x,y,z], `c`[x,y,z], `d`(0；>0 时为有厚度的三角棱柱) |
| `patch` | `vertices`[x1,y1,z1,...]（每 3 顶点一个三角形）, `d`(0；>0 时双面偏移成带厚薄片) |

> **朝向提醒**：`cylinder`/`cone` 默认轴是 +Y，斜向件的朝向由 mesh 的 `quaternion` 给出（见 §3.2）。`buildGeometry` 只返回裸几何，**不应用 `quaternion`**——前端创建 Mesh 后自行 `mesh.quaternion.set(...)`。
>
> **材质提醒**：`buildGeometry` 不含材质。用 mesh 的 `color` 或 `material` 字段创建 `MeshStandardMaterial`，lowpoly 风格建议 `flatShading:true`。`tri`/`patch` 当 `d==0`（零厚度薄片）时材质需 `side: THREE.DoubleSide` 才能双面可见。

---

## 7. 粒子系统

当 `emitParticles: true` 时，响应 `baked.emit` 可能携带粒子配置：`{ [groupId]: { emit: { ... } } }`。emit 不产生 transform 增量，而是配置一个粒子发射器——前端需自行实现粒子渲染。

### 6.1 emit 配置格式

每个 group 的 emit 以**嵌套结构**存储在 `baked.emit[gid].emit` 中：

```json
{
  "rightHand": {
    "swing": { "axis": "y", "amplitude": 0.8, "frequency": 1.5 },
    "emit": {
      "emitMode": "point",
      "mesh": "sphere",
      "meshSize": 0.4,
      "rate": 25,
      "lifetime": [0.4, 0.8],
      "velocity": { "dir": [0, 1, 0], "speed": [1, 2], "spread": 0.4 },
      "acceleration": [0, -3, 0],
      "offset": [0, 0, 0],
      "colorStart": [1, 0.8, 0.2],
      "colorEnd": [0.5, 0, 0],
      "scaleStart": 1.0,
      "scaleEnd": 0.3
    }
  }
}
```

> **注意**：emit 使用嵌套结构。UI slider 开发时，用 `rt.flattenEmitConfig()` / `rt.unflattenEmitConfig()` 在 flat ↔ nested 之间转换。粒子渲染时直接读取嵌套格式。

### 6.2 参数说明

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `emitMode` | string | `"point"` | 发射模式：`"point"`—从 group 世界坐标中心 + offset 发射；`"volume"`—从 group 的 AABB 体积内随机点发射 |
| `mesh` | string | `"sphere"` | 粒子形状：`"box"` 或 `"sphere"` |
| `meshSize` | number | 0.4 | 粒子基础尺寸（世界单位），乘以 scaleStart/scaleEnd 得实际大小 |
| `rate` | number | 15 | 每秒发射粒子数 |
| `lifetime` | [min, max] | [0.5, 1.5] | 粒子寿命范围（秒），每个粒子在范围内随机取值 |
| `velocity.dir` | [x,y,z] | [0,1,0] | 发射主方向（无需归一化，内部会归一化） |
| `velocity.speed` | [min,max] | [1,3] | 初速范围（世界单位/秒），每个粒子在范围内随机取值 |
| `velocity.spread` | number | 0.3 | 散布角度（0=平行发射，1=半球散布） |
| `acceleration` | [x,y,z] | [0,0,0] | 加速度（世界单位/s²）。重力效果用负 Y：`[0,-5,0]`；上升烟雾用正 Y |
| `offset` | [x,y,z] | [0,0,0] | 发射点偏移（相对 group 世界坐标，仅 `emitMode:"point"` 有效） |
| `colorStart` | [r,g,b] | [1,0.8,0.2] | 粒子出生颜色（0~1 RGB） |
| `colorEnd` | [r,g,b] | [0.5,0,0] | 粒子死亡颜色（0~1 RGB） |
| `scaleStart` | number | 1.0 | 出生时尺寸倍数（× meshSize） |
| `scaleEnd` | number | 0.3 | 死亡时尺寸倍数（× meshSize） |

### 6.3 渲染实现指南

粒子渲染核心流程：**spawn → simulate → interpolate → render**。

#### 1. 发射器初始化

遍历 `baked.emit` 的所有 group，为每个创建发射器。推荐使用 **THREE.InstancedMesh**（单 draw call 高效渲染数百粒子）：

```js
// 最大粒子数 = rate × maxLifetime（向上取整，建议上限 500）
const maxCount = Math.min(500, Math.ceil(rate * maxLifetime + 5));
const geometry = mesh === 'box'
  ? new THREE.BoxGeometry(1, 1, 1)
  : new THREE.IcosahedronGeometry(0.5, 0); // sphere
const material = new THREE.MeshStandardMaterial({
  flatShading: true, transparent: true, opacity: 0.9,
});
const im = new THREE.InstancedMesh(geometry, material, maxCount);
im.count = 0;
im.castShadow = false;
im.frustumCulled = false;  // 粒子可能飞离视锥边界
scene.add(im);
```

#### 2. 每帧更新

```
for each emitter:
  1. 获取 group 的世界位置 (group.getWorldPosition)
  2. 若 emitMode === 'volume'：计算 group 的世界 AABB
     - 遍历 group 所有子 mesh
     - geometry.computeBoundingBox() → applyMatrix4(mesh.matrixWorld)
     - Box3.union() 合并所有子 mesh 的包围盒
     - 若 AABB 为空，回退为 point 模式
  3. 按 rate 生成新粒子 (accumulator += rate × dt)
     - point 模式：pos = worldPos + offset
     - volume 模式：pos = randomPointInAABB(min, max)
  4. 模拟已有粒子：pos += vel × dt; vel += accel × dt; life -= dt
  5. 移除死亡粒子 (life ≤ 0)
  6. 同步 InstancedMesh：为每个存活粒子设置 matrix + color
```

#### 3. 颜色/尺寸插值

每个粒子在 lifetime 内从起始值线性过渡到终止值。使用 `t = 1 - life / maxLife`（0=出生, 1=死亡）：

```js
// 尺寸插值
const s = meshSize * (scaleStart + (scaleEnd - scaleStart) * t);
// 颜色插值
const r = colorStart[0] + (colorEnd[0] - colorStart[0]) * t;
const g = colorStart[1] + (colorEnd[1] - colorStart[1]) * t;
const b = colorStart[2] + (colorEnd[2] - colorStart[2]) * t;

// 更新 InstancedMesh
dummy.position.set(px, py, pz);
dummy.scale.set(s, s, s);
dummy.updateMatrix();
im.setMatrixAt(i, dummy.matrix);
im.setColorAt(i, new THREE.Color(r, g, b));
im.instanceMatrix.needsUpdate = true;
im.instanceColor.needsUpdate = true;
```

#### 4. 速度生成

```js
// 方向 + 随机散布
let vx = dir[0] + (Math.random() - 0.5) * spread * 2;
let vy = dir[1] + (Math.random() - 0.5) * spread * 2;
let vz = dir[2] + (Math.random() - 0.5) * spread * 2;
const len = Math.sqrt(vx*vx + vy*vy + vz*vz) || 1;
// 随机速度
const speed = speedMin + Math.random() * (speedMax - speedMin);
// 最终速度 = 归一化方向 × 速度标量
vel = [(vx/len)*speed, (vy/len)*speed, (vz/len)*speed];
```

#### 5. AABB 体积发射

```js
// 计算 group 的世界 AABB
const aabb = new THREE.Box3().makeEmpty();
group.traverse(child => {
  if (child.isMesh && child.geometry) {
    child.geometry.computeBoundingBox();
    const childBox = child.geometry.boundingBox.clone();
    childBox.applyMatrix4(child.matrixWorld);
    aabb.union(childBox);
  }
});
// 体积模式：在 AABB 中随机取点
const pos = new THREE.Vector3(
  aabb.min.x + Math.random() * (aabb.max.x - aabb.min.x),
  aabb.min.y + Math.random() * (aabb.max.y - aabb.min.y),
  aabb.min.z + Math.random() * (aabb.max.z - aabb.min.z)
);
```

#### 6. 生命周期管理

- **播放开始**：为每个 emit group 创建发射器
- **动画自然结束**（非循环，t ≥ duration）：销毁所有发射器，移除 InstancedMesh
- **动画停止/切换**：销毁所有发射器
- **循环动画**：粒子持续运行，无需处理

### 6.4 UI 开发注意事项

- `listAnimationTemplates()` 中 emit 的 `params` 使用**扁平 key**（如 `velDirX`、`colorStartR`）；`baked.emit[gid].emit` 为嵌套格式
- Slider 读取 emit 参数：`rt.flattenEmitConfig(baked.emit[gid].emit)` → 得扁平对象
- Slider 写入 emit 参数：从 slider 收集扁平值 → `rt.unflattenEmitConfig(flat)` → 写回 emit 配置
- 粒子效果在 slider 调整时需实时重建发射器以预览变化

---

## 7.5 动画触发 VFX（词汇表驱动）

> 新系统（与 §7 legacy emit 并存）。前端在动画请求里传 `vfxTags` 词表 JSON，启用词汇表驱动的粒子效果。

### 启用方式

Quick / Pro / Multiphase 端点都接受可选 `vfxTags` 字段（结构同 `materialTags`）。省略 → 不启用，AI 输出零 VFX 字样。

### Quick / Pro 模式：`baked.vfx` 字段

Quick 与 Pro 的 VFX 统一经 `baked.vfx` 返回（Quick 的持续效果转换为目标 group 列表）：

```json
{
  "continuous": [
    { "target": "rightFoot", "preset": "hit_debris", "params": { "power": 0.6 } },
    { "target": "head", "preset": "flame", "anchor": { "offset": [0, -0.4, 0.6] }, "dir": [0, 0, 1], "params": { "scale": 1.0 } }
  ],
  "events": []
}
```

### Pro 模式：api.vfx / api.emit

```js
// 持续效果（动画开始挂上，结束销毁）
api.vfx('head', {
  preset: 'flame',
  anchor: { offset: [0, -0.4, 0.6] },
  dir: [0, 0, 1],
  params: { scale: 1.0 }
});

// 事件触发（按帧检测）
if (footJustLand) api.emit('footstep', { target: 'rightFoot', power: 0.6 });
if (swingAtPeak)  api.emit('attack_peak', { target: 'sword_tip', power: 1.0 });
```

### Pro 烘焙响应（baked.vfx 字段）

Pro 模式返回的 `baked` 对象在有 VFX 声明时多一个 `vfx` 字段：

```json
{
  "fps": 60,
  "duration": 1.5,
  "loop": false,
  "animation": { ... },
  "vfx": {
    "continuous": [
      {
        "target": "head",
        "preset": "flame",
        "anchor": { "offset": [0, -0.4, 0.6] },
        "dir": [0, 0, 1],
        "params": { "scale": 1.0 }
      }
    ],
    "events": [
      { "t": 0.12, "name": "footstep", "target": "rightFoot", "payload": {"power": 0.6} },
      { "t": 0.35, "name": "attack_peak", "target": "sword_tip", "payload": {"power": 1.0} }
    ]
  }
}
```

省略 `vfxTags` 的请求 → `baked.vfx` 不存在（向后兼容）。

### 锚点与朝向（anchor / dir）

| 字段 | 写法 | 含义 |
|------|------|------|
| `anchor` 省略 | — | 用 group 原点（适合末端 group：手、脚、剑尖） |
| `anchor.offset` | `[x,y,z]` | 相对 group 局部坐标的偏移（推荐：嘴/胸口/眼） |
| `anchor.worldPos` | `[x,y,z]` | 世界绝对坐标（Pro 用 `api.groupPos()` 算） |
| `dir` 省略 | — | 用 group 的 `worldFacing` |
| `dir` 数组 | `[x,y,z]` | 世界方向向量（+Z 前 / +Y 上 / +X 右） |
| `dir.meshId` | `{ "meshId": "mXX" }` | 用某 mesh 的主轴（武器刃方向） |

### 前端词表（前端职责）

词表 JSON 结构同后端 `vfx-tags-v1.json`，前端持有并发送。词表内容：
- `README`：AI 输出格式 + 规则 + 预算
- `presets`：封闭预设集（`flame`/`smoke`/`hit_spark`/`hit_debris`/`charge_motes`/`sparkle`/`slash_trail`/`embers`），每条带 `description` / `params` schema / `trigger` (`continuous` \| `event`) / `runtime.particlePreset`（指向 `ParticlePresets.js` 真实预设名）
- `events`：封闭事件集（`footstep`/`land`/`attack_peak`/`impact`/`cast`），每条带 `payload_schema` 和 `default_preset`

前端运行时按 `baked.vfx.continuous` 挂持续效果、按 `baked.vfx.events` 在对应帧触发一次性效果。`runtime.particlePreset` 字段映射到 `ParticleCompanion.createParticleEffect({ attachTo }, { preset, overrides })` 的入口。

---

## 8. 简单 LLM 对话

### `POST /api/chat`

用于标题生成、剧情创作等辅助功能。默认 SSE 流式返回（`text/event-stream`）。

**请求**
```json
{
  "messages": [
    { "role": "system", "content": "you are a game writer" },
    { "role": "user", "content": "generate a quest title" }
  ],
  "temperature": 0.7,
  "maxTokens": 1024,
  "provider": "gpt",
  "stream": true,
  "thinking": true
}
```

| 字段 | 默认 | 说明 |
|------|------|------|
| `provider` | `gpt` | AI provider：`gpt`（默认）或 `deepseek`（thinking 固定关闭）。省略时默认 `gpt`；旧值 `glm`/`fireworks` 已停止维护，勿传 |
| `stream` | `true` | SSE 流式；传 `false` 走旧版一次性 JSON（见本节末尾） |
| `thinking` | `true` | 是否回传思考数据。开启后会有 `thinking_start`/`thinking_done` 事件、`done.reasoning` 携带思考内容；关闭则只有正文。注意：provider=gpt 时返回的是**思考摘要**（模型自己生成的推理概要），不是完整思维链；简单问题可能没有摘要（`reasoning` 为空串）。关闭可降低延迟。`provider=deepseek` 时思考固定关闭，`done.reasoning` 恒为空字符串，`thinking` 字段不生效 |

**SSE 事件类型**：
- `thinking_start` / `thinking_done` — 模型思考中 / 思考结束，可用于 UI 加载动画
- `text` — 正文增量片段，`text` 字段是本次追加的文本（按序拼接即完整回复）
- `done` — 流结束。`content` 是完整回复（后端已拼接好），`reasoning` 是思考内容（provider=gpt 时为思考摘要；未产生则为空字符串）
- `error` — 失败（如限速时 `error` 为 `"429"`），事件后流即关闭

```jsonc
event: thinking_start
data: {"stage":"thinking_start"}

event: text
data: {"stage":"text","text":"The Dragon"}

event: text
data: {"stage":"text","text":"'s Awakening"}

event: done
data: {"stage":"done","content":"The Dragon's Awakening","reasoning":""}
```

**前端解析示例**：
```js
async function llmChat(messages, { temperature, maxTokens, provider } = {}) {
  const resp = await fetch(`${API}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, temperature, maxTokens, provider }),
  });
  const text = await resp.text();
  let content = '';
  for (const block of text.trim().split(/\n\n/)) {
    const lines = block.split(/\r?\n/);
    const event = lines.find(l => l.startsWith('event:'))?.slice(6).trim();
    const data = JSON.parse(lines.find(l => l.startsWith('data:')).slice(5).trim());
    if (event === 'error') throw new Error(data.error);
    if (event === 'text') content += data.text;          // 增量拼接
    if (event === 'done') content = data.content;         // 或直接用后端拼好的完整回复
  }
  return content;
}
```

**旧版一次性 JSON**（`stream:false` 时返回）：
```json
{
  "ok": true,
  "content": "The Dragon's Awakening",
  "reasoning": ""
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `content` | `string` | 模型正式回复内容 |
| `reasoning` | `string` | 模型的思考过程（thinking）。模型未输出思考内容时为空字符串 |

---

## 9. 完整集成示例

### 最小化的前端应用

```js
import * as THREE from 'three';

// 两个线上端点互为备份，任选其一：
const API = 'https://voxelstudio.site';                    // 主（自定义域名，Vercel）
// const API = 'https://voxel-studio-backend.zeabur.app';  // 备（Zeabur）

// 1. 加载 runtime（THREE 注入）
const mod = await import(`${API}/api/templates/module.js`);
const runtime = mod.create({ THREE });

// 2. 生成模型
async function genModel(desc) {
  const resp = await fetch(`${API}/api/generate/model`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description: desc, provider: 'gpt', mode: 'standard' }),
  });
  const text = await resp.text();
  let modelJson = null;
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const e = JSON.parse(line.slice(5).trim());
    if (e.done) { modelJson = e.modelJson; break; }
    if (e.stage === 'error') throw new Error(e.error);
  }
  return modelJson;
}

// 3. 构建 Three.js 场景 — v2 扁平 nodes（局部坐标，parent 表达层级）
function buildScene(modelJson) {
  const scene = new THREE.Scene();

  function makeMaterial(mesh) {
    const mat = mesh.material || {};
    const color = mat.color ?? mesh.color ?? 0x888888;
    const zeroThick = (mesh.type === 'tri' || mesh.type === 'patch') && ((mesh.params?.d ?? 0) <= 0);
    return new THREE.MeshStandardMaterial({
      color,
      roughness: mat.roughness ?? 0.5,
      metalness: mat.metalness ?? 0.05,
      transparent: mat.transparent === true,
      opacity: mat.opacity ?? 1,
      flatShading: mat.flatShading !== false,
      side: zeroThick ? THREE.DoubleSide : THREE.FrontSide,
    });
  }

  // 两遍式：先按 node 建 Object3D，再按 parent 挂载
  const objs = new Map();
  for (const n of (modelJson.nodes || [])) {
    const obj = n.mesh
      ? new THREE.Mesh(runtime.buildGeometry(n.mesh.type, n.mesh.params || {}), makeMaterial(n.mesh))
      : new THREE.Group();
    obj.name = n.id;
    const t = n.transform || {};
    const p = t.pos || [0, 0, 0];
    obj.position.set(p[0], p[1], p[2]);
    if (t.quat) obj.quaternion.set(t.quat[0], t.quat[1], t.quat[2], t.quat[3]);
    if (t.scale && t.scale[0] > 0 && t.scale[1] > 0 && t.scale[2] > 0) {
      obj.scale.set(t.scale[0], t.scale[1], t.scale[2]);
    }
    objs.set(n.id, obj);
  }
  for (const n of (modelJson.nodes || [])) {
    const obj = objs.get(n.id);
    if (n.parent && objs.has(n.parent)) objs.get(n.parent).add(obj);
    else scene.add(obj);
  }
  return { scene, objs };
}

// 4. 存储基础姿态（动画停止时恢复用）
function saveBasePose(objs) {
  const base = new Map();
  for (const [id, obj] of objs) {
    base.set(id, {
      position: obj.position.clone(),
      rotation: obj.rotation.clone().toArray(),
      scale: obj.scale.clone(),
    });
  }
  return base;
}

// 5. 生成动画 — 返回 baked 数值轨道（60fps 逐帧增量）
async function genAnimation(modelJson, desc, emitParticles = false) {
  const resp = await fetch(`${API}/api/generate/animation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'quick', modelJson, description: desc, provider: 'gpt', emitParticles }),
  });
  const { baked } = await resp.json();
  return baked;
}

// 6. 播放动画 — ⚠️ 轨道值是增量（delta），必须叠加到基础姿态
function playAnimation(baked, objs) {
  const frameCount = Math.max(...Object.values(baked.animation).map(tr => tr.rotX.length));
  const basePose = saveBasePose(objs);
  const start = performance.now();
  let done = false;

  function loop() {
    const t = (performance.now() - start) / 1000;
    const ct = baked.loop ? t % baked.duration : Math.min(t, baked.duration);
    const f = Math.max(0, Math.min(frameCount - 1, Math.round(ct * baked.fps)));

    // 叠加增量到每个 group
    for (const [gid, tr] of Object.entries(baked.animation)) {
      const obj = objs.get(gid);
      const base = basePose.get(gid);
      if (!obj || !base) continue;
      // 位置 = 基础 + 增量
      obj.position.set(
        base.position.x + tr.posX[f],
        base.position.y + tr.posY[f],
        base.position.z + tr.posZ[f]
      );
      // 旋转 = 基础 + 增量（Euler XYZ；生产环境建议转 Quaternion）
      obj.rotation.set(
        base.rotation[0] + tr.rotX[f],
        base.rotation[1] + tr.rotY[f],
        base.rotation[2] + tr.rotZ[f]
      );
    }

    if (!baked.loop && ct >= baked.duration && !done) {
      done = true;
      for (const [partId, base] of basePose) {
        const obj = objs.get(partId);
        if (obj) {
          obj.position.copy(base.position);
          obj.rotation.set(base.rotation[0], base.rotation[1], base.rotation[2]);
        }
      }
      return; // 停止循环
    }
    if (!done) requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

// ═══ 启动 ═══
const modelJson = await genModel('a lowpoly dragon');
const { scene, objs } = buildScene(modelJson);
const baked = await genAnimation(modelJson, 'flying loop');
playAnimation(baked, objs);
```

---

## 10. 错误处理

| HTTP 状态 | 含义 | 处理 |
|-----------|------|------|
| `200` SSE 含 `errorCode=GENERATION_FAILED` | AI 生成失败 | 展示通用失败提示，可安全重试 |
| `429` | 请求被限速 | 稍等后重试 |
| `500` | 请求未完成 | 展示通用失败提示 |

**Provider**：当前提供 `gpt`（默认）和 `deepseek`（thinking 固定关闭）两个 provider，所有端点通用，前端无需实现 provider 选择逻辑。

---

## 11. 注意事项

1. **不要硬编码模板名或几何类型名**。所有类型信息从 `runtime.listAnimationTemplates()` 和 `runtime.listGeometryTypes()` 动态获取。

2. **不要硬编码 geometry 参数名**。用 `runtime.buildGeometry(type, params)` 构建几何——参数名由模板定义，前端只负责传递 modelJson 中的 `mesh.params`。

3. **播放动画必须叠加增量**。动画端点返回的 `baked` 轨道值是**增量（delta）**，不是绝对位姿。必须叠加到基础姿态上——见 §8 完整示例的 `playAnimation` 函数。（`runtime.evaluateMotion` 仅用于旧版 plan 存档的回放/编辑，新响应不含 plan。）

4. **动画 Canvas 预览用 `runtime.evaluateTemplate`**。传入单个模板名、参数、时间、duration，得到单个模板的增量。

5. **模型生成是 SSE 流式**。`POST /api/generate/model` 返回 `text/event-stream`，按 `\n\n` 分隔事件。

6. **批量生成默认是 SSE 流式**。`POST /api/generate/batch` 会先返回 `start`，随后逐条返回 `item`，最后返回 `done`；需要旧版普通 JSON 时传 `stream:false`。

7. **粒子需独立渲染**。`baked.emit` 不产生 transform 轨道。前端需自行实现 InstancedMesh 粒子系统——见 §7 完整指南。

8. **粒子 slider UI 需要 flat ↔ nested 转换**。`listAnimationTemplates()` 中 emit 的 params 是**扁平 key**。从 `baked.emit` 读取 emit 参数时用 `rt.flattenEmitConfig()`，写回时用 `rt.unflattenEmitConfig()`。

9. **Health check**：`GET /health` 返回 `{"ok":true}`，可用于启动时验证后端可用。

10. **CORS**：后端已配置 `Access-Control-Allow-Origin`，本地开发不需要代理。

11. **`duration` 字段已废弃**（2026-08）。所有动画端点的 `duration` 仍接受（向后兼容），但**不再传给 AI**——动画时长由 AI 根据动作内容自动决定。前端可保留 `duration` 字段以兼容旧后端，新前端无需提供。

12. **Pro 动画推荐用 unified 入口** `/api/generate/animation` + `mode:"pro"`。单 `description` 是日常用法（后端自动检测攻击核心并给 `_speedSegments` 建议），`phases` 数组是高级用法（前端要分阶段 UI 标签时用）。

13. **`_speedSegments` 是赠品字段**。后端响应里包含变速建议，前端可选实现；不实现就按线性时间播放，动画照常工作。

14. **API 文档可通过 `GET /api/docs/api-reference` 拉取**。后端从 `docs/api-reference.md` 实时读取（无缓存），第三方前端可在运行时拉取最新版。
