# 复用来源

- 地图查看、渲染与数据兼容模块：原 Lifetime / WorldForge 衍生仓库，快照提交 `ad66afde3036ce97c53dec0df4c446c01d256c3a`，仓库 `https://github.com/yafo7/CGCreator`；原 WorldForge 仓库为 `https://github.com/linkq-q/worldforge-studio`。
- 本地 `voxel-render-runtime`：随上述快照提供的 Voxel Studio 渲染依赖。Lifetime 按实际依赖裁剪，去掉 AI 调色请求，仅保留静态颜色 LUT；保留源码中的作者注释和已有来源信息。
- 本地 `voxel-motion-runtime`：上述快照收录的官方模板模块及相对依赖，原下载日期 2026-09-23，来源 `https://voxel-studio-backend.zeabur.app/api/templates/module.js`。Lifetime 补充了几何构造函数的 TypeScript 声明。
- Three.js、fflate 及其他 npm 依赖：版本锁定于 `package-lock.json`，许可随各 npm 包保留。

文件级提取清单在 `docs/reused-sources.json`。业务入口、资源服务器、生成客户端和工作区状态管理在本项目独立实现。此文件记录来源，不为上游源码新增或重新授予许可。
