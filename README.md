# Lifetime

独立的演员制作与演出预览工具。只有 Actors 和 Play，沿用原 Lifetime 的深色三栏界面。

## 启动

需要 Node.js 22.12+ 或 24+。

```sh
npm ci
npm run dev
```

打开 http://127.0.0.1:5190。资源服务自动运行在 5191。

```sh
npm test
npm run build
npm start
```

构建后，`npm start` 在 http://127.0.0.1:5191 同时提供页面和资源接口。不需要 WorldForge、Voxel Studio 或其他兄弟项目。

## 使用

- **Actors**：左上角展开演员切换器，新建演员；生成模型后，进入动画制作，生成并播放动画。模型重新生成后形成新版本，已有动画保留原版本绑定。支持暂停、停止、进度拖动和循环。
- **Play**：导入地图 JSON、渲染方案 JSON 或场景 ZIP。打开地图，选择演员及模型版本，加入演出；设置实例的位置、朝向、缩放和动画，然后保存演出。点击左侧已保存演出可恢复。
- 导入独立渲染方案时，先打开目标地图；会保存为新的地图资源，不覆盖旧地图。含外部资源引用的地图应从原 WorldForge 导出完整场景 ZIP。缺少模型或 HDRI 的包会明确报错。
- 地图导出为可重新导入的 `.lifetime-scene.zip`，包含地图、渲染方案及嵌入的 HDRI；演员实例另存于演出草稿。
- 工作区切换保留当前数据与任务，只让活动工作区持续渲染。保存失败可重试保存已有生成结果；取消请求只是停止等待，后端任务可能继续执行。

生成接口通过浏览器直接访问后端。需要更换地址时，复制 `.env.example` 为 `.env`，设置 `VITE_GENERATION_API` 后重启开发服务；发布构建需重新 build。该变量不是密钥存储位置。

运行数据位于本项目 `data/actors`、`data/maps`、`data/performances`，不提交 Git。当前任务状态和未保存草稿保存在浏览器内存中；刷新前应完成保存。

不包含地图生成/编辑、Stage、长动画编排、融入环境或相关 agent。当前动画播放器处理骨骼姿态，不提供粒子/VFX 动画制作；不支持的数据明确报错。

开发规则见 [AGENTS.md](AGENTS.md)，架构见 [docs/architecture.md](docs/architecture.md)，验证记录见 [docs/verification.md](docs/verification.md)。
