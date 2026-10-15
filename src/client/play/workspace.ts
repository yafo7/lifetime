import { SceneMotionPort } from "../services/sceneMotionPort";
import { SceneBindingPanel } from "./sceneBindingPanel";
import { CharacterMachinePanel } from "./characterMachinePanel";
import { NpcBehaviorPanel } from "./npcBehaviorPanel";
import {
  sampleTerrainHeight,
  getSpawnPoints,
} from "../rendering/map/shared/map";
import type { Actor, ActorInstance, Performance } from "../../shared/contracts";
import type { MapResource } from "../../shared/maps";
import { resources } from "../services/resources";
import { Viewport } from "../rendering/viewport";
import { escape, select, button } from "../ui";
import { message } from "../services/jobs";
import { SceneBuildCoordinator } from "../scene/buildCoordinator";
import { GenerationCoordinator } from "../scene/generationCoordinator";
import type { AssetTask } from "../../shared/sceneBuild";
import { AssemblyRepairPanel } from "./assemblyRepairPanel";
import { pointPosition } from "../../shared/motion";
import { SceneRequestPanel } from "./sceneRequestPanel";
import { sceneCatalogue, type SceneCatalogue } from "../../shared/scenePlan";
import { buildSemanticIndex } from "../navigation/semanticIndex";
import type { ActionPoint } from "../../shared/motion";
import { playerAssets } from "./playerAssets";
import { calculateModelVisualBounds } from "../rendering/map/shared/modelBounds";
import { getPlayerSpawnYaw } from "../rendering/map/shared/map";
import type { Vec3 } from "../../shared/motion";
import type { SceneMotion } from "../../shared/sceneMotion";
import { removeScenePathPoint } from "../../shared/scenePathEditing";
import { TraversalAssets } from "../services/traversalAssets";
import { TraversalClearance } from "../navigation/traversalClearance";
import { TraversalPlanner, jumpArc } from "../navigation/traversalPlanner";
import { bodiesOverlap } from "../navigation/characterCollision";

declare global {
  interface Window {
    lifetimeSceneBuilder: {
      getCatalogue(): Promise<SceneCatalogue>;
      generate(request: string): Promise<void>;
      build(plan: unknown, request?: string): Promise<void>;
      buildBlueprint(plan: unknown, request?: string): Promise<void>;
      getBuildState(): ReturnType<PlayWorkspace["buildState"]>;
      cancel(): void;
    };
  }
}

export class PlayWorkspace {
  private view: Viewport;
  readonly motion: SceneMotionPort;
  private actionPanel: SceneBindingPanel;
  private machinePanel: CharacterMachinePanel;
  private npcPanel: NpcBehaviorPanel;
  private map: MapResource | null = null;
  private draft: Performance | null = null;
  private drafts = new Map<string, Performance>();
  private actors = new Map<string, Actor>();
  private libraryActor: Actor | null = null;
  private selectedId: string | null = null;
  private loading = false;
  private libraryVersion = 0;
  private sideTab: "scene" | "roles" = "scene";
  private roleTab: "behavior" | "position" = "behavior";
  private active = false;
  private worldPlaying = false;
  private playerPreparing = false;
  private dirtyDrafts = new Set<string>();
  private sceneCoordinator = new SceneBuildCoordinator();
  private generation = new GenerationCoordinator();
  private previewView: Viewport | null = null;
  private observer: ReturnType<typeof setInterval>;
  private sceneRequest: SceneRequestPanel;
  private repairPanel: AssemblyRepairPanel;
  private repairVisuals = new Map<string, ActorInstance>();
  private repairActors = new Map<string, Actor>();
  private repairVersion = 0;
  private repairRouteVersion = 0;
  private pathDraft: {
    instanceId: string;
    points: ActionPoint[];
    actions: SceneMotion["actions"];
    visible: boolean;
  } | null = null;
  private pathRouteVersion = 0;
  private traversalAssets = new TraversalAssets();
  private pathRouteTimer: ReturnType<typeof setTimeout> | null = null;
  buildState() {
    return structuredClone(
      this.generation.record ?? this.sceneCoordinator.record,
    );
  }
  get busy() {
    return this.generation.busy || this.sceneCoordinator.busy;
  }
  get dirty(): boolean {
    return (
      this.dirtyDrafts.size > 0 ||
      !!this.repairPanel?.dirty ||
      !!this.generation.unsavedAssembly
    );
  }
  constructor(
    private host: HTMLElement,
    private notify: (text: string) => void,
  ) {
    host.innerHTML = `<div class="workspace-head actor-context-bar play-context-bar"><details class="map-switcher"><summary aria-label="选择地图"><strong data-current-map>选择地图</strong><span> 切换地图 ⌄</span></summary>
      <aside class="lifetime-panel map-library-panel"><div class="panel-heading"><h2>地图</h2><button data-import class="secondary small">导入</button></div><input data-file type="file" accept=".json,.zip" hidden/><div data-maps class="play-map-list"></div><a data-export class="button secondary small map-export" hidden>导出当前地图</a><details data-scene-versions class="scene-versions" hidden><summary>历史版本</summary><div data-performances class="clip-list"></div></details></aside>
    </details></div><div class="play-layout npc-play-layout">
      <aside class="lifetime-panel play-npc-panel">
        <section class="npc-library-section"><div class="panel-heading"><h2>NPCs <span data-count class="muted">0</span></h2><details data-add-role class="add-role npc-add-role"><summary aria-label="添加 NPC">＋</summary><div class="npc-add-form"><label class="lifetime-field"><span>演员</span><select data-actor aria-label="添加到演出的演员"></select></label><label class="lifetime-field"><span>模型</span><select data-model aria-label="添加演员模型版本"></select></label><button data-add class="secondary" disabled>加入场景</button></div></details></div>
        <div data-instances class="clip-list instance-list"></div><p data-role-empty class="empty-state">选择地图，查看其中的 NPC。</p></section>
        <div data-npc-outline class="npc-outline" hidden></div><div data-build-npcs hidden></div>
      </aside>
      <section class="actor-preview-column">
        <div class="play-preview-card">
          <div class="actor-preview-toolbar">
            <div class="scene-title"><input data-draft-name aria-label="场景名称" placeholder="先选择地图" disabled/><small data-map-name>地图预览</small></div>
            <div class="scene-view-tools"><button data-enter class="lifetime-primary small" disabled>进入</button><button data-fit class="secondary small" title="重置视角">↺ 视角</button></div>
          </div>
          <div class="actor-preview-stage play-scene"><canvas data-canvas aria-label="演出三维预览"></canvas><div data-placeholder class="preview-placeholder">选择或导入一张地图</div><div data-player-hud class="player-hud" hidden><strong>钢铁侠鸭子</strong><span data-player-state>站立</span><span>WASD 移动 · 空格跳跃 · 拖动鼠标转视角 · 滚轮缩放 · Esc 退出</span></div></div>
          <div class="playback-strip world-playback"><button data-world-play class="lifetime-primary" disabled>▶ 播放</button><button data-world-stop class="secondary small" disabled>复位</button><span data-world-status class="muted"></span><button data-save class="secondary small" hidden>保存修改</button><span data-dirty hidden></span></div>
          <div data-traversal-assets class="traversal-asset-status" role="status" hidden></div>
          <div data-action-playback class="playback-strip action-progress npc-action-progress" hidden><span data-progress-npc></span><input data-seek type="range" min="0" max="1" step="any" value="0" aria-label="当前角色动作进度" disabled/><span data-time></span></div>
        </div>
      </section>
      <aside class="lifetime-panel play-cast-panel">
        <div class="panel-tabs workspace-tabs"><button data-side-tab="scene" class="active">场景要求</button><button data-side-tab="roles">NPC 设置</button></div>
        <section data-side-pane="scene"><div data-scene-request-panel class="scene-request-panel"></div><div data-build-repair hidden></div></section>
        <section data-side-pane="roles" hidden>
          <h3 data-selected-npc class="selected-npc-title">在左侧选择 NPC</h3>
          <div data-role-detail hidden>
            <div class="role-tools"><button data-role-focus class="secondary small">聚焦</button><button data-remove class="secondary small">移除角色</button></div>
            <div class="panel-tabs"><button data-role-tab="behavior" class="active">行为</button><button data-role-tab="position">位置</button></div>
            <section data-role-pane="behavior"><div data-character-machine class="scene-action-panel"></div></section>
            <section data-role-pane="position" hidden>
              <details data-inspector><summary>角色站位与尺寸</summary><div class="transform-grid">
                ${["x", "y", "z", "rotation", "scale"].map((key, i) => `<label class="lifetime-field"><span>${["位置 X", "位置 Y", "位置 Z", "朝向（°）", "缩放"][i]}</span><input data-transform="${key}" type="number" step="${key === "rotation" ? "5" : "0.1"}" ${key === "scale" ? 'min="0.01"' : ""} aria-label="${["位置 X", "位置 Y", "位置 Z", "朝向", "缩放"][i]}"></label>`).join("")}
              </div></details>
            </section>
            <div data-scene-action-panel class="scene-action-panel"></div>
          </div>
        </section>
      </aside>
      <span data-map-status hidden>尚未打开地图</span>
    </div>`;
    this.view = new Viewport(select(host, "[data-canvas]"));
    this.motion = new SceneMotionPort(this.view);
    this.traversalAssets.onChange = () => this.renderTraversalAssets();
    this.motion.onTraversalAssets = async (instanceId, kinds) => {
      if (!this.draft) throw new Error("场景已关闭");
      return this.traversalAssets.ensure(
        structuredClone(this.draft),
        instanceId,
        kinds,
      );
    };
    window.lifetimeSceneMotion = this.motion;
    this.sceneRequest = new SceneRequestPanel(
      select(host, "[data-scene-request-panel]"),
      this.generation,
      (request, climb, retry) => this.generateScene(request, climb, retry),
      this.notify,
      (task) => this.previewAsset(task),
      async (id) => {
        const result = await resources.performance(id);
        this.closeAssetPreview();
        await this.exclusive(async () => {
          await this.open(result.mapId, result);
          await this.toggleWorld();
        });
      },
      () => this.openBuildRepair(),
      async (id) => {
        if (this.repairPanel?.dirty) throw new Error("请先保存或取消当前调整");
        this.closeBuildRepair();
        await this.generation.select(id);
      },
    );
    this.sceneCoordinator.onChange = () => this.sceneRequest.render();
    this.generation.onChange = () => this.sceneRequest.render();
    this.generation.onReady = () => {
      const run = this.generation.record;
      if (
        run &&
        this.active &&
        !this.view.playerState &&
        this.map?.id === run.mapId &&
        JSON.stringify(this.draft) === JSON.stringify(run.base)
      )
        void this.generateScene(run.request, run.climb, true).catch((e) =>
          this.notify(message(e)),
        );
    };
    this.observer = setInterval(() => {
      void this.generation.observe().catch(() => {});
      void this.traversalAssets.observe().catch(() => {});
    }, 2000);
    window.lifetimeSceneBuilder = {
      getCatalogue: () => this.getSceneCatalogue(),
      generate: (request) => this.generateScene(request),
      build: (plan, request = "结构化场景计划") =>
        this.generateScene(request, 0.3, false, plan),
      buildBlueprint: (plan, request = "结构化场景指导文档") =>
        this.generateScene(request, 0.3, false, undefined, plan),
      getBuildState: () => this.buildState(),
      cancel: () => {
        this.sceneCoordinator.cancel();
        void this.generation.cancel().catch((e) => this.notify(message(e)));
      },
    };
    this.actionPanel = new SceneBindingPanel(
      select(host, "[data-scene-action-panel]"),
      select(host, "[data-canvas]"),
      this.view,
      this.motion,
      () => this.markDirty(),
      (text) => this.notify(text),
    );
    this.repairPanel = new AssemblyRepairPanel(
      select(host, "[data-build-repair]"),
      select(host, "[data-build-npcs]"),
      {
        changed: () => this.updateBuildRepair(),
        place: (id) => this.actionPanel.armPathPoint(id),
        save: (draft) => this.generation.saveDraft(draft),
        check: () => this.checkBuildRepair(),
        publish: async () => {
          const run = this.generation.record!;
          this.closeBuildRepair();
          await this.generateScene(run.request, run.climb, true);
        },
        preview: (key) => this.previewBuildAction(key),
        close: () => this.closeBuildRepair(),
        discard: () => {
          this.generation.unsavedAssembly = null;
        },
        notify: this.notify,
      },
    );
    this.machinePanel = new CharacterMachinePanel(
      select(host, "[data-character-machine]"),
      this.motion,
      (text) => this.notify(text),
    );
    this.npcPanel = new NpcBehaviorPanel(
      select(host, "[data-npc-outline]"),
      this.motion,
      (actionId, stateId) => {
        this.roleTab = "behavior";
        this.showSide("roles");
        this.actionPanel.selectAction(actionId);
        this.machinePanel.selectState(stateId);
        this.updatePathMarkers();
      },
      (operation) => {
        if (operation === "save")
          void this.exclusive(() => this.savePath()).catch((error) =>
            this.notify(message(error)),
          );
        else if (operation === "cancel") this.cancelPath();
        else this.togglePath();
      },
    );
    this.motion.onChange = () => {
      this.actionPanel.status();
      this.machinePanel.status();
      this.npcPanel.status();
      this.renderInstanceStatus();
      this.updateWorldPlayback();
    };
    this.motion.onConfigurationChange = () => {
      this.markDirty();
      this.renderInstances();
    };
    this.view.onPlayback = (_time, _duration, playing) => {
      this.updateWorldPlayback(playing);
      const state = this.selectedId
        ? this.motion.getExecutionState(this.selectedId)
        : null;
      const slider = select<HTMLInputElement>(host, "[data-seek]");
      slider.max = String(state?.duration || 1);
      slider.value = String(state?.elapsed || 0);
      slider.disabled = !state;
      select(host, "[data-time]").textContent = state
        ? `${state.elapsed.toFixed(1)} / ${state.duration.toFixed(1)} 秒`
        : "";
      select<HTMLElement>(host, "[data-action-playback]").hidden = !state;
    };
    this.view.onSelect = (id) => {
      if (this.repairPanel.draft) return;
      this.selectedId = id;
      if (id) this.showSide("roles");
      this.renderInstances();
    };
    this.view.onPlayerFrame = (frame) => {
      const hud = select<HTMLElement>(host, "[data-player-hud]");
      hud.hidden = !frame;
      if (frame) {
        select(host, "[data-player-state]").textContent = frame.airborne
          ? "跳跃"
          : frame.moving
            ? "奔跑"
            : "站立";
        hud.dataset.position = JSON.stringify(frame.position);
        hud.dataset.airborne = String(frame.airborne);
      }
    };
    const on = (query: string, cb: () => void | Promise<void>) =>
      button(host, query, cb, (e) => this.notify(message(e)));
    on("[data-import]", () =>
      select<HTMLInputElement>(host, "[data-file]").click(),
    );
    select<HTMLInputElement>(host, "[data-file]").onchange = () => {
      const input = select<HTMLInputElement>(host, "[data-file]"),
        file = input.files?.[0];
      input.value = "";
      if (file)
        void this.exclusive(async () => {
          const map = await resources.importMap(file, this.map?.id);
          await this.refreshMaps();
          await this.open(map.id);
          this.notify("地图已导入并保存");
        }).catch((e) => this.notify(message(e)));
    };
    on("[data-fit]", () => this.view.fit());
    on("[data-enter]", async () => {
      if (this.view.playerState) {
        this.leavePlayer();
        return;
      }
      this.playerPreparing = true;
      try {
        await this.exclusive(() => this.enterPlayer());
      } finally {
        this.playerPreparing = false;
        this.updateRoleMode();
        this.updateWorldPlayback();
      }
    });
    on("[data-world-play]", () => this.exclusive(() => this.toggleWorld()));
    on("[data-world-stop]", () => {
      this.motion.cancelAll();
      this.view.stop();
      this.updateWorldPlayback(false);
    });
    on("[data-role-focus]", () => {
      if (this.selectedId) this.view.focusInstance(this.selectedId);
    });
    host
      .querySelectorAll<HTMLButtonElement>("[data-side-tab]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            this.showSide(b.dataset.sideTab as "scene" | "roles")),
      );
    host.querySelectorAll<HTMLButtonElement>("[data-role-tab]").forEach(
      (b) =>
        (b.onclick = () => {
          this.roleTab = b.dataset.roleTab as "behavior" | "position";
          this.updateRoleMode();
        }),
    );
    select<HTMLCanvasElement>(host, "[data-canvas]").ondblclick = () => {
      if (this.selectedId) this.view.focusInstance(this.selectedId);
    };
    select<HTMLInputElement>(host, "[data-seek]").oninput = (e) => {
      try {
        const time = Number((e.target as HTMLInputElement).value);
        if (this.selectedId && this.motion.getExecutionState(this.selectedId))
          this.motion.seekExecution(this.selectedId, time);
        else this.view.seek(time);
      } catch (e) {
        this.notify(message(e));
      }
    };
    on("[data-add]", () => this.exclusive(() => this.addActor()));
    on("[data-remove]", () => this.removeActor());
    on("[data-save]", () =>
      this.exclusive(async () => {
        if (!this.draft) return;
        this.draft.name =
          select<HTMLInputElement>(host, "[data-draft-name]").value.trim() ||
          "未命名场景";
        this.draft = await resources.savePerformance(this.draft);
        this.motion.bind(this.map!, this.actors, this.draft.instances);
        this.renderInstances();
        this.dirtyDrafts.delete(this.draft.id);
        this.updateDirty();
        await this.refreshPerformances();
        this.notify("场景已保存");
      }),
    );
    select<HTMLInputElement>(host, "[data-draft-name]").oninput = () => {
      if (this.draft) {
        this.draft.name = select<HTMLInputElement>(
          host,
          "[data-draft-name]",
        ).value;
        this.markDirty();
      }
    };
    select<HTMLSelectElement>(host, "[data-actor]").onchange = () =>
      void this.loadLibraryActor().catch((e) => this.notify(message(e)));
    host
      .querySelectorAll<HTMLInputElement>("[data-transform]")
      .forEach((input) => (input.onchange = () => this.editInstance()));
  }
  async start(): Promise<void> {
    await Promise.all([
      this.refreshMaps(),
      this.refreshPerformances(),
      this.refreshActors(),
    ]);
    const maps = await resources.list("maps");
    const initial =
      maps.find((map) => /^中式园林\s*9/.test(map.name)) ??
      maps.find((map) => map.name.includes("园林")) ??
      maps[0];
    if (initial && !this.map && !this.loading)
      await this.exclusive(() => this.open(initial.id));
  }
  private async exclusive(work: () => Promise<void>): Promise<void> {
    if (this.loading) throw new Error("正在载入资源，请稍候");
    this.loading = true;
    this.host.classList.add("loading");
    this.host.setAttribute("aria-busy", "true");
    try {
      await work();
    } finally {
      this.loading = false;
      this.host.classList.remove("loading");
      this.host.removeAttribute("aria-busy");
      this.updateWorldPlayback();
    }
  }
  private async refreshMaps(): Promise<void> {
    const maps = await resources.list("maps");
    select(this.host, "[data-maps]").innerHTML = maps.length
      ? maps
          .map(
            (m) =>
              `<button class="play-map-item ${m.id === this.map?.id ? "active" : ""}" data-map-id="${escape(m.id)}"><span class="map-thumb">◇</span><span><b>${escape(m.name)}</b></span><span>›</span></button>`,
          )
          .join("")
      : '<div class="empty-state">暂无地图<br>导入一张地图开始</div>';
    this.host
      .querySelectorAll<HTMLButtonElement>("[data-map-id]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            void this.exclusive(() => this.open(b.dataset.mapId!)).catch((e) =>
              this.notify(message(e)),
            )),
      );
  }
  private async refreshPerformances(): Promise<void> {
    const all = await resources.list("performances");
    const list = this.map ? all.filter((p) => p.mapId === this.map!.id) : [];
    select<HTMLElement>(this.host, "[data-scene-versions]").hidden =
      !list.length;
    select(this.host, "[data-performances]").innerHTML = list.length
      ? list
          .map(
            (p) =>
              `<button class="clip-item ${this.draft?.id === p.id ? "active" : ""}" data-performance-id="${escape(p.id)}"><b>${escape(p.name)}</b></button>`,
          )
          .join("")
      : '<p class="empty-state">保存后可在这里重新打开</p>';
    this.host
      .querySelectorAll<HTMLButtonElement>("[data-performance-id]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            void this.exclusive(async () => {
              const draft = await resources.performance(
                b.dataset.performanceId!,
              );
              await this.open(draft.mapId, draft);
            }).catch((e) => this.notify(message(e)))),
      );
  }
  private async refreshActors(): Promise<void> {
    const list = await resources.list("actors"),
      menu = select<HTMLSelectElement>(this.host, "[data-actor]"),
      old = menu.value;
    menu.innerHTML = list.length
      ? list
          .map(
            (a) => `<option value="${escape(a.id)}">${escape(a.name)}</option>`,
          )
          .join("")
      : '<option value="">暂无演员</option>';
    if (list.some((a) => a.id === old)) menu.value = old;
    await this.loadLibraryActor();
  }
  private async loadLibraryActor(): Promise<void> {
    const id = select<HTMLSelectElement>(this.host, "[data-actor]").value,
      version = ++this.libraryVersion;
    const actor = id ? await resources.actor(id) : null;
    if (version !== this.libraryVersion) return;
    this.libraryActor = actor;
    const versions = actor?.modelRevisions ?? [];
    const menu = select<HTMLSelectElement>(this.host, "[data-model]");
    const selectedVersion = menu.value;
    menu.innerHTML = versions.length
      ? versions
          .map(
            (r, i) =>
              `<option value="${escape(r.id)}">版本 ${i + 1} · ${escape(r.mode)}</option>`,
          )
          .join("")
      : '<option value="">演员尚无模型</option>';
    menu.value = versions.some((r) => r.id === selectedVersion)
      ? selectedVersion
      : (versions.at(-1)?.id ?? "");
    select<HTMLButtonElement>(this.host, "[data-add]").disabled =
      !this.map || !versions.length;
  }
  private async open(id: string, saved?: Performance): Promise<void> {
    if (this.repairPanel.dirty) throw new Error("请先保存或取消构建中的调整");
    this.closeBuildRepair();
    this.leavePlayer();
    this.cancelPath();
    this.closeAssetPreview();
    if (this.draft)
      this.drafts.set(this.draft.mapId, structuredClone(this.draft));
    const map = await resources.map(id);
    if (!saved && !this.drafts.has(id)) {
      const latest = (await resources.list("performances"))
        .filter((record) => record.mapId === id)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (latest) saved = await resources.performance(latest.id);
    }
    const draft = saved ??
      this.drafts.get(id) ?? {
        id: crypto.randomUUID(),
        name: `${map.name} · 场景`,
        mapId: id,
        instances: [],
        updatedAt: Date.now(),
      };
    // Resolve references before replacing the current scene.
    const actors = new Map<string, Actor>();
    for (const instance of draft.instances) {
      const actor =
        actors.get(instance.actorId) ??
        (await resources.actor(instance.actorId));
      actors.set(actor.id, actor);
      if (!actor.modelRevisions.some((r) => r.id === instance.modelRevisionId))
        throw new Error("演出引用的模型版本不存在");
    }
    this.motion.unbind();
    this.actionPanel.set(null, null, null);
    await this.view.openMap(map);
    this.map = map;
    this.draft = structuredClone(draft);
    this.actors = actors;
    for (const instance of this.draft.instances) {
      const actor = actors.get(instance.actorId)!;
      await this.view.add(
        instance,
        actor.modelRevisions.find((r) => r.id === instance.modelRevisionId)!
          .modelJson,
        actor.animations.find((c) => c.id === instance.clipId) ?? null,
      );
    }
    this.motion.bind(map, this.actors, this.draft.instances);
    this.selectedId = this.draft.instances[0]?.id ?? null;
    if (saved) this.dirtyDrafts.delete(saved.id);
    select<HTMLElement>(this.host, "[data-placeholder]").hidden = true;
    select(this.host, "[data-map-name]").textContent = map.name;
    select(this.host, "[data-current-map]").textContent = map.name;
    select<HTMLDetailsElement>(this.host, ".map-switcher").open = false;
    this.host
      .querySelectorAll<HTMLElement>("[data-map-id]")
      .forEach((button) =>
        button.classList.toggle("active", button.dataset.mapId === id),
      );
    select(this.host, "[data-map-status]").textContent = "地图已打开";
    select<HTMLInputElement>(this.host, "[data-draft-name]").value =
      this.draft.name;
    const link = select<HTMLAnchorElement>(this.host, "[data-export]");
    link.hidden = false;
    link.href = resources.exportMap(map.id);
    link.download = `${map.name}.lifetime-scene.zip`;
    select<HTMLButtonElement>(this.host, "[data-save]").disabled = false;
    this.renderInstances();
    this.updateDirty();
    select<HTMLInputElement>(this.host, "[data-draft-name]").disabled = false;
    this.showSide("scene");
    this.sceneRequest.setContext(this.map.id, this.draft.instances.length > 0);
    await this.refreshPerformances();
    await this.refreshActors();
    await this.generation.recover(map.id);
    await this.traversalAssets.recover(map.id);
  }
  private async getSceneActors() {
    const summaries = await resources.list("actors");
    return new Map(
      (await Promise.all(summaries.map((s) => resources.actor(s.id)))).map(
        (a) => [a.id, a],
      ),
    );
  }
  private async getSceneCatalogue() {
    if (!this.map || !this.draft) throw new Error("请先打开地图");
    return sceneCatalogue(
      buildSemanticIndex(this.map).summary,
      [...(await this.getSceneActors()).values()],
      this.draft.instances,
    );
  }
  private async generateScene(
    request: string,
    climb = 0.3,
    retry = false,
    plan?: unknown,
    blueprint?: unknown,
  ) {
    if (this.repairPanel.dirty) throw new Error("请先保存或取消构建中的调整");
    this.closeBuildRepair();
    if (this.pathDraft) throw new Error("请先保存或取消路径修改");
    if (!this.map || !this.draft) throw new Error("请先打开地图");
    if (this.loading) throw new Error("正在载入地图，请稍候");
    const map = this.map,
      base = structuredClone(
        retry && this.generation.record
          ? this.generation.record.base
          : this.draft,
      ),
      signature = JSON.stringify(this.draft);
    const current = () =>
      this.map === map && JSON.stringify(this.draft) === signature;
    const actors =
      plan === undefined ? this.actors : await this.getSceneActors();
    if (!current()) throw new Error("演出已修改，请重新提交要求");
    const context = {
      map,
      base,
      actors,
      current,
      climb,
      geometry: () => this.motion.getGeometry(),
      navigation: (p: import("../../shared/sceneMotion").NavigationProfile) =>
        this.motion.getNavigation(p),
    };
    const result =
      plan === undefined
        ? await this.generation.run(request, context, retry, blueprint)
        : await this.sceneCoordinator.run(
            request,
            {
              map,
              base,
              actors,
              current,
              climb,
              geometry: () => this.motion.getGeometry(),
              navigation: (p) => this.motion.getNavigation(p),
            },
            retry,
            plan,
          );
    await this.refreshPerformances();
    const opened = current();
    if (opened) {
      this.closeAssetPreview();
      await this.exclusive(() => this.open(result.mapId, result));
    }
    this.notify(
      opened
        ? "场景已生成并保存，可以播放"
        : "场景新版本已保存，当前草稿保持不变",
    );
  }
  private async previewAsset(task: AssetTask) {
    const run = this.generation.record;
    if (!run || task.state !== "done") return;
    const assets = run.manifest[task.roleKey],
      actor = await resources.actor(assets.actorId),
      model = actor.modelRevisions.find((m) => m.id === assets.modelRevisionId);
    if (!model) throw new Error("模型资源不存在");
    this.closeAssetPreview();
    this.motion.pauseAll();
    this.view.setActive(false);
    const stage = select<HTMLElement>(this.host, ".play-scene"),
      overlay = document.createElement("div");
    overlay.className = "asset-preview";
    overlay.innerHTML = `<div class="actor-preview-toolbar"><b>${escape(actor.name)} · ${escape(task.kind === "model" ? "模型" : task.name)}</b><button data-close-asset class="small">返回地图</button></div><div class="asset-preview-stage"><canvas aria-label="生成素材预览"></canvas></div><div class="playback-strip"><button data-asset-play class="small" ${task.kind === "model" ? "hidden" : ""}>▶ 播放</button><span data-asset-time></span></div>`;
    stage.append(overlay);
    const preview = (this.previewView = new Viewport(
      select(overlay, "canvas"),
    ));
    preview.setActive(this.active);
    select<HTMLButtonElement>(overlay, "[data-close-asset]").onclick = () =>
      this.closeAssetPreview();
    select<HTMLButtonElement>(overlay, "[data-asset-play]").onclick = () =>
      preview.toggle();
    preview.onPlayback = (time, duration, playing) => {
      select(overlay, "[data-asset-time]").textContent = duration
        ? `${time.toFixed(1)} / ${duration.toFixed(1)} 秒`
        : "拖动旋转，滚轮缩放";
      select(overlay, "[data-asset-play]").textContent = playing
        ? "Ⅱ 暂停"
        : "▶ 播放";
    };
    try {
      await preview.model(model.modelJson);
      if (this.previewView !== preview) return;
      if (task.kind === "animation") {
        preview.setClip(
          actor.animations.find(
            (a) => a.id === assets.animations[task.animationKey!],
          )!,
        );
        preview.toggle();
      }
    } catch (e) {
      this.closeAssetPreview();
      throw e;
    }
    this.updateWorldPlayback();
  }
  private async repairContext() {
    const run = this.generation.record,
      map = this.map;
    if (!run?.plan || !map || map.id !== run.mapId)
      throw new Error("请打开构建所属地图");
    const signature = JSON.stringify(this.draft);
    return {
      map,
      base: run.base,
      climb: run.climb,
      actors: await this.getSceneActors(),
      current: () =>
        this.map === map && JSON.stringify(this.draft) === signature,
      geometry: () => this.motion.getGeometry(),
      navigation: (p: import("../../shared/sceneMotion").NavigationProfile) =>
        this.motion.getNavigation(p),
    };
  }
  private async openBuildRepair() {
    if (this.pathDraft) throw new Error("请先保存或取消路径调整");
    if (this.generation.busy) throw new Error("请等待当前构建完成");
    this.leavePlayer();
    this.closeAssetPreview();
    this.motion.pauseAll();
    const unsaved =
      this.generation.unsavedAssembly?.id === this.generation.record?.id
        ? this.generation.unsavedAssembly
        : null;
    if (!this.generation.record?.assembly && !unsaved) {
      await this.checkBuildRepair();
      return;
    }
    this.showSide("scene");
    this.repairActors = await this.getSceneActors();
    this.repairPanel.open(
      unsaved
        ? { ...this.generation.record!, assembly: unsaved.draft }
        : this.generation.record!,
      this.generation.record?.assembly ?? null,
    );
    await this.refreshRepairVisuals();
  }
  private async checkBuildRepair() {
    try {
      await this.generation.check(await this.repairContext());
    } finally {
      const run = this.generation.record;
      const unsaved =
        this.generation.unsavedAssembly?.id === run?.id
          ? this.generation.unsavedAssembly
          : null;
      if (run && (run.assembly || unsaved) && run.mapId === this.map?.id) {
        this.showSide("scene");
        this.repairActors = await this.getSceneActors();
        this.repairPanel.open(
          unsaved ? { ...run, assembly: unsaved.draft } : run,
          run.assembly ?? null,
        );
        await this.refreshRepairVisuals();
      }
    }
  }
  private closeBuildRepair() {
    if (!this.repairPanel?.draft && !this.repairVisuals.size) return;
    ++this.repairVersion;
    ++this.repairRouteVersion;
    for (const instance of this.repairVisuals.values())
      this.view.remove(instance.id);
    this.repairVisuals.clear();
    this.repairActors.clear();
    this.view.clearSceneGuide("build-repair");
    this.repairPanel.close();
    this.generation.unsavedAssembly = null;
    select<HTMLElement>(this.host, "[data-scene-request-panel]").hidden = false;
    this.actionPanel.setPathDraft(null);
    select<HTMLElement>(this.host, ".npc-library-section").hidden = false;
    select<HTMLButtonElement>(this.host, '[data-side-tab="roles"]').disabled =
      false;
    select<HTMLButtonElement>(this.host, "[data-world-stop]").disabled =
      !this.draft?.instances.length;
    select<HTMLInputElement>(this.host, "[data-draft-name]").disabled =
      !this.draft;
    if (this.map && this.draft) {
      this.motion.bind(this.map, this.actors, this.draft.instances);
      for (const instance of this.draft.instances)
        this.view.resetSceneInstance(
          instance,
          this.actors
            .get(instance.actorId)
            ?.animations.find((a) => a.id === instance.clipId) ?? null,
        );
      this.renderInstances();
      this.updateRoleMode();
      this.updateWorldPlayback();
    }
  }
  private async refreshRepairVisuals() {
    const draft = this.repairPanel.draft,
      run = this.repairPanel.run;
    if (!draft || !run?.plan) return;
    const version = ++this.repairVersion;
    this.motion.cancelAll();
    for (const instance of this.repairVisuals.values())
      this.view.remove(instance.id);
    this.repairVisuals.clear();
    for (const role of run.plan.actors) {
      const work = draft.roles[role.key],
        actor = this.repairActors.get(role.actorId);
      const origin = work?.locations[role.origin];
      if (
        !work?.instance ||
        !actor ||
        !origin?.points[0]?.ground ||
        origin.state !== "ready"
      )
        continue;
      const instance = structuredClone(work.instance);
      instance.id = `repair-${run.id}-${role.key}`;
      instance.position = pointPosition(origin.points[0]);
      if (instance.sceneMotion) delete instance.sceneMotion.machine;
      await this.view.add(
        instance,
        actor.modelRevisions.find((m) => m.id === role.modelRevisionId)!
          .modelJson,
        null,
      );
      if (version !== this.repairVersion) {
        this.view.remove(instance.id);
        return;
      }
      this.repairVisuals.set(role.key, instance);
    }
    this.updateBuildRepair();
  }
  private updateBuildRepair() {
    const panel = this.repairPanel;
    if (!panel?.draft) return;
    if (panel.dirty) this.motion.pauseAll();
    select<HTMLElement>(this.host, "[data-scene-request-panel]").hidden = true;
    select<HTMLElement>(this.host, ".npc-library-section").hidden = true;
    select<HTMLElement>(this.host, "[data-npc-outline]").hidden = true;
    select<HTMLButtonElement>(this.host, '[data-side-tab="roles"]').disabled =
      true;
    select<HTMLButtonElement>(this.host, "[data-world-stop]").disabled = true;
    select<HTMLInputElement>(this.host, "[data-draft-name]").disabled = true;
    select<HTMLElement>(this.host, "[data-save]").hidden = true;
    this.actionPanel.setPathDraft({
      points: panel.points,
      visible: panel.visible,
      selected: panel.pointId,
      invalid: new Set(
        Object.values(panel.role?.locations ?? {})
          .filter(
            (l) =>
              l.state !== "ready" ||
              panel.role?.issues.some((i) => i.locationKey === l.intent.key),
          )
          .flatMap((l) => l.points.map((p) => p.id)),
      ),
      place: (id, point) => panel.place(id, point),
      choose: (id) => panel.choosePoint(id),
    });
    this.actionPanel.setActive(this.active && panel.visible);
    this.updateWorldPlayback();
    void this.updateBuildRoutes();
  }
  private async updateBuildRoutes() {
    const version = ++this.repairRouteVersion,
      panel = this.repairPanel,
      work = panel.role;
    this.view.clearSceneGuide("build-repair");
    this.view.setSceneGuideInstance(
      this.active && panel.visible ? "build-repair" : null,
    );
    if (!work?.profile || !panel.run?.plan || !panel.visible || !this.active)
      return;
    const role = panel.run.plan.actors.find((r) => r.key === panel.roleKey)!;
    const action = role.actions.find((a) => a.key === panel.actionKey);
    const start = work.locations[role.origin]?.points[0];
    if (!action || !start?.ground) {
      panel.routeStatus("请先放置角色起点");
      return;
    }
    const paths: Vec3[][] = [];
    let failure = "";
    try {
      const nav = await this.motion.getNavigation(work.profile);
      const clearance = new TraversalClearance(
        await this.motion.getGeometry(),
        this.map!.map,
        work.profile,
      );
      const traversal = new TraversalPlanner(
        nav,
        clearance,
        work.instance?.sceneMotion?.traversal,
      );
      let from = pointPosition(start);
      for (const step of action.steps) {
        if (step.type !== "moveTo" && step.type !== "followRoute") continue;
        const location =
          work.locations[step.type === "moveTo" ? step.target : step.route];
        if (!location?.points.length) throw new Error("该动作有地点待放置");
        const sequence =
          step.type === "moveTo"
            ? [location.points[0]]
            : [
                ...location.points,
                ...(location.closed ? [location.points[0]] : []),
              ];
        for (const point of sequence) {
          if (!point.ground) throw new Error(`${point.name} 待放置`);
          const to = pointPosition(point);
          try {
            paths.push(
              ...traversal
                .route(from, to)
                .map((leg) =>
                  leg.kind === "jump"
                    ? jumpArc(leg.points[0], leg.points.at(-1)!, leg.arc!)
                    : leg.points,
                ),
            );
          } catch (error) {
            throw new Error(`${point.name}：${message(error)}`);
          }
          from = to;
        }
      }
    } catch (error) {
      failure = message(error);
    }
    if (version !== this.repairRouteVersion || !panel.draft) return;
    this.view.showSceneGuide("build-repair", paths);
    panel.routeStatus(
      failure
        ? `已显示可走路段；${failure}`
        : "蓝色路线为 NavMesh 实际寻路结果",
    );
  }
  private async previewBuildAction(key: string) {
    const panel = this.repairPanel,
      role = panel.role;
    const instance = this.repairVisuals.get(panel.roleKey),
      intended = panel.run?.plan?.actors.find((r) => r.key === panel.roleKey);
    if (!role || !instance || !intended || !this.map || panel.dirty)
      throw new Error("请先保存并检查起点与动作");
    const actor = structuredClone(this.repairActors.get(intended.actorId)!);
    const current = structuredClone(instance);
    current.sceneMotion!.points = Object.values(role.locations)
      .flatMap((l) => l.points)
      .filter((p) => p.ground);
    actor.motionActions ??= [];
    for (const action of Object.values(role.actions))
      if (
        action.action &&
        !actor.motionActions.some((a) => a.id === action.action!.id)
      )
        actor.motionActions.push(action.action);
    const actors = new Map(this.actors);
    actors.set(actor.id, actor);
    this.motion.bind(this.map, actors, [...this.draft!.instances, current]);
    await this.motion.executeAction(current.id, role.actions[key].bindingId);
  }
  private closeAssetPreview() {
    this.previewView?.dispose();
    this.previewView = null;
    this.host.querySelector(".asset-preview")?.remove();
    this.view.setActive(this.active);
    this.updateWorldPlayback();
  }
  private async addActor(): Promise<void> {
    if (!this.draft || !this.libraryActor)
      throw new Error("请先打开地图并选择演员");
    const actor = this.libraryActor,
      model = actor.modelRevisions.find(
        (r) =>
          r.id === select<HTMLSelectElement>(this.host, "[data-model]").value,
      );
    if (!model) throw new Error("请选择模型版本");
    const instance: ActorInstance = {
      id: crypto.randomUUID(),
      actorId: actor.id,
      modelRevisionId: model.id,
      clipId: null,
      position: (() => {
        const p = getSpawnPoints(this.map!.map)[0] ?? [0, 0, 0];
        return [p[0], sampleTerrainHeight(this.map!.map, p[0], p[2]), p[2]] as [
          number,
          number,
          number,
        ];
      })(),
      rotation: 0,
      scale: 1,
      loop: false,
    };
    await this.view.add(instance, model.modelJson, null);
    // New instances fit a human-scale courtyard; the resource model stays unchanged.
    const size = this.view.instanceSize(instance.id);
    instance.scale = 2 / Math.max(0.01, size[1]);
    this.view.updateInstance(instance, null);
    this.actors.set(actor.id, actor);
    this.draft.instances.push(instance);
    this.selectedId = instance.id;
    select<HTMLDetailsElement>(this.host, "[data-add-role]").open = false;
    this.showSide("roles");
    this.markDirty();
    this.renderInstances();
  }
  private removeActor(): void {
    if (!this.draft || !this.selectedId) return;
    this.motion.cancelExecution(this.selectedId);
    this.view.remove(this.selectedId);
    const removeIndex = this.draft.instances.findIndex(
      (i) => i.id === this.selectedId,
    );
    this.draft.instances.splice(removeIndex, 1);
    this.selectedId = this.draft.instances[0]?.id ?? null;
    this.markDirty();
    this.renderInstances();
  }
  private renderInstances(): void {
    if (this.repairPanel?.draft) {
      this.updateBuildRepair();
      return;
    }
    if (this.pathDraft && this.pathDraft.instanceId !== this.selectedId)
      this.cancelPath();
    const instances = this.draft?.instances ?? [];
    this.sceneRequest.setContext(this.map?.id ?? null, instances.length > 0);
    select(this.host, "[data-count]").textContent = String(instances.length);
    select(this.host, "[data-instances]").innerHTML = instances
      .map(
        (i, n) =>
          `<button class="clip-item ${i.id === this.selectedId ? "active" : ""}" data-instance-id="${i.id}" aria-pressed="${i.id === this.selectedId}"><b>${escape(this.npcName(i))}${instances.filter((other) => this.npcName(other) === this.npcName(i)).length > 1 ? ` · ${n + 1}` : ""}</b><small data-instance-status="${i.id}"></small></button>`,
      )
      .join("");
    this.host.querySelectorAll<HTMLButtonElement>("[data-instance-id]").forEach(
      (b) =>
        (b.onclick = () => {
          this.selectedId = b.dataset.instanceId!;
          this.showSide("roles");
          this.renderInstances();
        }),
    );
    const instance = instances.find((i) => i.id === this.selectedId);
    select<HTMLElement>(this.host, "[data-role-detail]").hidden = !instance;
    select<HTMLElement>(this.host, "[data-role-empty]").hidden =
      instances.length > 0;
    select(this.host, "[data-role-empty]").textContent = this.map
      ? "这里还没有 NPC，可添加演员或输入场景要求生成。"
      : "选择地图，查看其中的 NPC。";
    select(this.host, "[data-selected-npc]").textContent = instance
      ? this.npcName(instance)
      : "在左侧选择 NPC";
    select(this.host, "[data-progress-npc]").textContent = instance
      ? this.npcName(instance)
      : "";
    this.actionPanel.set(
      this.map,
      instance ?? null,
      instance ? (this.actors.get(instance.actorId) ?? null) : null,
    );
    this.machinePanel.set(instance ?? null);
    this.npcPanel.set(instance ?? null);
    if (this.npcPanel.selectedActionId)
      this.actionPanel.selectAction(this.npcPanel.selectedActionId);
    this.renderInstanceStatus();
    this.updateRoleMode();
    this.updateWorldPlayback();
    if (!instance) return;
    for (const [key, value] of Object.entries({
      x: instance.position[0],
      y: instance.position[1],
      z: instance.position[2],
      rotation: instance.rotation,
      scale: instance.scale,
    }))
      select<HTMLInputElement>(this.host, `[data-transform="${key}"]`).value =
        String(value);
  }
  private npcName(instance: ActorInstance) {
    return (
      this.draft?.sceneDesign?.plan.actors.find(
        (role) => role.instanceId === instance.id,
      )?.name ??
      this.actors.get(instance.actorId)?.name ??
      "未命名 NPC"
    );
  }
  private renderInstanceStatus() {
    for (const i of this.draft?.instances ?? []) {
      const node = this.host.querySelector<HTMLElement>(
        `[data-instance-status="${i.id}"]`,
      );
      if (!node) continue;
      const state = this.motion.getMachineState(i.id),
        rules = i.sceneMotion?.machine;
      const execution = this.motion.getExecutionState(i.id);
      const name =
        rules?.states.find((s) => s.id === state?.stateId)?.name ?? "";
      node.textContent =
        execution?.status === "running" && execution.blocked
          ? `${name ? `${name} · ` : ""}等待前方角色让行`
          : state
            ? `${name} · ${{ starting: "准备中", running: "执行中", waiting: "等待中", paused: "已暂停", completed: "已完成", stopped: "已停止", failed: "失败" }[state.status]}`
            : rules?.enabled
              ? ""
              : i.clipId
                ? ""
                : "";
    }
  }
  private editInstance(): void {
    const instance = this.draft?.instances.find(
      (i) => i.id === this.selectedId,
    );
    if (!instance) return;
    const read = (key: string) =>
      Number(
        select<HTMLInputElement>(this.host, `[data-transform="${key}"]`).value,
      );
    const values = ["x", "y", "z", "rotation", "scale"].map(read);
    if (!values.every(Number.isFinite) || values[4] <= 0) {
      this.notify("请输入有效坐标和大于零的缩放");
      this.renderInstances();
      return;
    }
    this.motion.cancelExecution(instance.id);
    const oldScale = instance.scale;
    instance.position = [values[0], values[1], values[2]];
    instance.rotation = values[3];
    instance.scale = values[4];
    if (instance.sceneMotion && oldScale !== instance.scale) {
      const ratio = instance.scale / oldScale;
      instance.sceneMotion.navigation.radius *= ratio;
      instance.sceneMotion.navigation.height *= ratio;
    }
    const clip =
      this.actors
        .get(instance.actorId)
        ?.animations.find((c) => c.id === instance.clipId) ?? null;
    this.view.updateInstance(instance, clip);
    this.markDirty();
    this.renderInstances();
  }
  private markDirty(): void {
    const design = this.draft?.sceneDesign;
    if (design) {
      // Removing a binding/instance retires only that role's automatic baseline.
      // Position and state edits keep it, allowing the next plan to preserve P edits.
      design.roles = design.roles.filter((r) => {
        const instance = this.draft!.instances.find(
          (i) => i.id === r.instanceId,
        );
        return (
          instance?.sceneMotion &&
          Object.values(r.actions).every((id) =>
            instance.sceneMotion!.actions.some((a) => a.id === id),
          )
        );
      });
      design.plan.actors = design.plan.actors.filter((p) =>
        design.roles.some((r) => r.key === p.key),
      );
      if (!design.roles.length) delete this.draft!.sceneDesign;
    }
    if (this.draft) this.dirtyDrafts.add(this.draft.id);
    this.updateDirty();
  }
  private updateDirty(): void {
    const dirty = !!this.draft && this.dirtyDrafts.has(this.draft.id);
    select<HTMLElement>(this.host, "[data-save]").hidden =
      !dirty || !!this.pathDraft;
    select(this.host, "[data-dirty]").textContent = dirty ? "未保存" : "";
  }
  private showSide(tab: "scene" | "roles") {
    this.sideTab = tab;
    this.host
      .querySelectorAll<HTMLElement>("[data-side-pane]")
      .forEach((p) => (p.hidden = p.dataset.sidePane !== tab));
    this.host
      .querySelectorAll<HTMLElement>("[data-side-tab]")
      .forEach((b) => b.classList.toggle("active", b.dataset.sideTab === tab));
    this.updateRoleMode();
  }
  private updateRoleMode() {
    if (this.repairPanel?.draft) {
      this.updateBuildRepair();
      return;
    }
    this.host
      .querySelectorAll<HTMLElement>("[data-role-pane]")
      .forEach((p) => (p.hidden = p.dataset.rolePane !== this.roleTab));
    this.host
      .querySelectorAll<HTMLElement>("[data-role-tab]")
      .forEach((b) =>
        b.classList.toggle("active", b.dataset.roleTab === this.roleTab),
      );
    const positioning = this.sideTab === "roles" && this.roleTab === "position";
    this.actionPanel.setMode(positioning ? "position" : "behavior");
    this.actionPanel.setActive(
      this.active &&
        !this.view.playerState &&
        !this.playerPreparing &&
        (positioning || !!this.pathDraft),
    );
    select<HTMLElement>(this.host, "[data-role-detail]").inert =
      !!this.pathDraft;
    this.updatePathMarkers();
    this.view.setSceneGuideInstance(
      this.view.playerState || this.playerPreparing
        ? null
        : this.pathDraft
          ? this.active && this.pathDraft.visible
            ? `${this.pathDraft.instanceId}:path-edit`
            : null
          : this.active && positioning
            ? this.selectedId
            : null,
    );
    select<HTMLElement>(this.host, "[data-action-playback]").hidden =
      !this.selectedId || !this.motion.getExecutionState(this.selectedId);
  }
  private updateWorldPlayback(clipPlaying = this.view.isPlaying) {
    const instances = this.draft?.instances ?? [];
    this.worldPlaying =
      clipPlaying ||
      instances.some((i) => {
        const machine = this.motion.getMachineState(i.id);
        return machine
          ? ["running", "waiting", "starting"].includes(machine.status)
          : this.motion.getExecutionState(i.id)?.status === "running";
      });
    const play = select<HTMLButtonElement>(this.host, "[data-world-play]");
    play.disabled =
      !!this.repairPanel?.draft ||
      !!this.pathDraft ||
      !!this.previewView ||
      this.loading ||
      !instances.some(
        (i) =>
          i.clipId ||
          i.sceneMotion?.selectedActionId ||
          i.sceneMotion?.machine?.enabled,
      );
    play.textContent = this.worldPlaying ? "Ⅱ 暂停" : "▶ 播放";
    select<HTMLButtonElement>(this.host, "[data-world-stop]").disabled =
      !instances.length || this.loading;
    select(this.host, "[data-world-status]").textContent = this.worldPlaying
      ? "世界播放中"
      : "";
    const entering = select<HTMLButtonElement>(this.host, "[data-enter]");
    entering.disabled =
      !this.map || this.loading || this.busy || !!this.repairPanel?.draft;
    entering.textContent = this.view.playerState
      ? "退出"
      : this.playerPreparing
        ? "准备中…"
        : "进入";
  }
  private async enterPlayer(): Promise<void> {
    if (!this.map || this.busy)
      throw new Error("请先打开地图并等待生成任务完成");
    const mapId = this.map.id;
    const assets = playerAssets([...(await this.getSceneActors()).values()]);
    this.closeAssetPreview();
    if (this.pathDraft) this.cancelPath();
    const bounds = calculateModelVisualBounds(assets.model.modelJson);
    const scale = 2 / Math.max(0.01, bounds.max[1] - bounds.min[1]);
    const profile = {
      radius: Math.max(
        0.3,
        (Math.min(
          bounds.max[0] - bounds.min[0],
          bounds.max[2] - bounds.min[2],
        ) *
          scale) /
          2,
      ),
      height: 2,
      climb: 0.4,
      slope: 40,
    };
    const [geometry, nav] = await Promise.all([
      this.motion.getGeometry(),
      this.motion.getNavigation(profile),
    ]);
    if (!this.active || this.map?.id !== mapId)
      throw new Error("地图或工作区已切换，请重新进入");
    const map = this.map.map;
    const occupied = this.motion.getCollisionBodies();
    const preferred = getSpawnPoints(map);
    let spawn: Vec3 | null = null;
    const tryPoint = (x: number, z: number) => {
      const p = nav.nearest([x, sampleTerrainHeight(map, x, z), z], 1.5, 0.6);
      if (
        p &&
        occupied.every(
          (o) =>
            !bodiesOverlap(
              { id: "temporary-player", position: p, ...profile },
              o,
            ),
        )
      )
        spawn = p;
    };
    for (const p of preferred) {
      for (let r = 0; r <= 12 && !spawn; r += 2)
        for (let a = 0; a < Math.PI * 2 && !spawn; a += Math.PI / 4)
          tryPoint(p[0] + Math.cos(a) * r, p[2] + Math.sin(a) * r);
    }
    for (
      let z = -map.box.size[2] / 2 + 2;
      z < map.box.size[2] / 2 && !spawn;
      z += 4
    )
      for (
        let x = -map.box.size[0] / 2 + 2;
        x < map.box.size[0] / 2 && !spawn;
        x += 4
      )
        tryPoint(x, z);
    if (!spawn) throw new Error("地图没有适合玩家站立的可通行区域");
    this.host.classList.add("player-mode");
    this.actionPanel.setActive(false);
    this.view.setSceneGuideInstance(null);
    try {
      await this.view.beginPlayer(
        {
          id: `player:${crypto.randomUUID()}`,
          actorId: assets.actor.id,
          modelRevisionId: assets.model.id,
          clipId: null,
          position: spawn,
          rotation: (getPlayerSpawnYaw(map) * 180) / Math.PI,
          scale,
          loop: false,
        },
        assets.model.modelJson,
        assets.run,
        assets.jump,
        nav,
        geometry,
        () => this.leavePlayer(),
      );
    } catch (e) {
      this.leavePlayer();
      throw e;
    }
    this.updateWorldPlayback();
    if (
      !this.worldPlaying &&
      this.draft?.instances.some(
        (i) => i.clipId || i.sceneMotion?.selectedActionId,
      )
    ) {
      try {
        await this.toggleWorld();
      } catch (e) {
        this.notify(`已进入地图；NPC 播放失败：${message(e)}`);
      }
    }
  }
  private leavePlayer(): void {
    this.view.endPlayer();
    this.host.classList.remove("player-mode");
    select<HTMLElement>(this.host, "[data-player-hud]").hidden = true;
    this.updateRoleMode();
    this.updateWorldPlayback();
  }
  private togglePath() {
    if (this.loading || this.busy) {
      this.notify("请等待当前任务完成");
      return;
    }
    const instance = this.draft?.instances.find(
      (item) => item.id === this.selectedId,
    );
    if (!instance?.sceneMotion?.points.length) return;
    if (!this.pathDraft) {
      this.roleTab = "behavior";
      this.motion.pauseAll();
      if (this.view.isPlaying) this.view.toggle();
      this.pathDraft = {
        instanceId: instance.id,
        points: structuredClone(instance.sceneMotion.points),
        actions: structuredClone(instance.sceneMotion.actions),
        visible: true,
      };
    } else this.pathDraft.visible = !this.pathDraft.visible;
    this.npcPanel.setPathEditing(true, this.pathDraft.visible);
    this.updateRoleMode();
    this.updateDirty();
    this.updateWorldPlayback();
  }
  private updatePathMarkers() {
    const draft = this.pathDraft;
    if (!draft) {
      this.actionPanel.setPathDraft(null);
      return;
    }
    const instance = this.draft?.instances.find(
      (item) => item.id === draft.instanceId,
    );
    const action = draft.actions.find(
      (item) => item.id === this.npcPanel.selectedActionId,
    );
    const ids = new Set(
      action && "bindings" in action
        ? Object.values(action.bindings)
        : draft.points
            .filter(
              (point) =>
                action && JSON.stringify(action.plan).includes(point.id),
            )
            .map((point) => point.id),
    );
    if (instance?.sceneMotion?.startPointId)
      ids.add(instance.sceneMotion.startPointId);
    this.actionPanel.setPathDraft({
      points: draft.points.filter((point) => ids.has(point.id)),
      visible: draft.visible,
      place: (id, point) => {
        const index = draft.points.findIndex((item) => item.id === id);
        if (index < 0 || this.pathDraft !== draft) return;
        draft.points[index] = structuredClone(point);
        this.updatePathMarkers();
      },
      remove: (id) => {
        if (this.pathDraft !== draft || !instance?.sceneMotion) return;
        const actor = this.actors.get(instance.actorId);
        if (!actor) throw new Error("演员不存在，请重新打开地图");
        const updated = removeScenePathPoint(
          {
            ...instance.sceneMotion,
            points: draft.points,
            actions: draft.actions,
          },
          id,
          actor,
          instance.modelRevisionId,
        );
        draft.points = updated.points;
        draft.actions = updated.actions;
        this.updatePathMarkers();
      },
    });
    this.updatePathRoute();
  }
  private updatePathRoute() {
    const version = ++this.pathRouteVersion;
    if (this.pathRouteTimer) clearTimeout(this.pathRouteTimer);
    this.pathRouteTimer = null;
    const draft = this.pathDraft,
      actionId = this.npcPanel.selectedActionId;
    if (!draft) return;
    const guideId = `${draft.instanceId}:path-edit`;
    this.view.clearSceneGuide(guideId);
    if (!this.active || !draft.visible || !actionId) return;
    this.view.setSceneGuideInstance(guideId);
    this.npcPanel.setPathStatus("正在计算导航路线…");
    const points = structuredClone(draft.points);
    const actions = structuredClone(draft.actions);
    this.pathRouteTimer = setTimeout(() => {
      this.pathRouteTimer = null;
      void this.motion
        .inspectRoute(draft.instanceId, actionId, points, actions)
        .then((paths) => {
          if (version !== this.pathRouteVersion || this.pathDraft !== draft)
            return;
          this.view.showSceneGuide(guideId, paths);
          this.npcPanel.setPathStatus(
            paths.length
              ? "蓝色路线为 NavMesh 实际寻路结果"
              : "此动作没有移动路线",
          );
        })
        .catch((error) => {
          if (version !== this.pathRouteVersion || this.pathDraft !== draft)
            return;
          this.npcPanel.setPathStatus(`路线不可用：${message(error)}`);
        });
    }, 150);
  }
  private cancelPath() {
    if (!this.pathDraft) return;
    ++this.repairVersion;
    ++this.repairRouteVersion;
    ++this.pathRouteVersion;
    if (this.pathRouteTimer) clearTimeout(this.pathRouteTimer);
    this.pathRouteTimer = null;
    this.view.clearSceneGuide(`${this.pathDraft.instanceId}:path-edit`);
    this.pathDraft = null;
    this.actionPanel.setPathDraft(null);
    this.npcPanel.setPathEditing(false, false);
    this.updateRoleMode();
    this.updateDirty();
    this.updateWorldPlayback();
  }
  private async savePath() {
    const path = this.pathDraft;
    if (!path || !this.draft || !this.map) return;
    const draft = structuredClone(this.draft);
    const instance = draft.instances.find(
      (item) => item.id === path.instanceId,
    );
    if (!instance?.sceneMotion) throw new Error("NPC 已变化，请重新修改路径");
    instance.sceneMotion.points = structuredClone(path.points);
    instance.sceneMotion.actions = structuredClone(path.actions);
    const saved = await resources.savePerformance(draft);
    this.draft = saved;
    this.motion.bind(this.map, this.actors, saved.instances);
    this.cancelPath();
    this.dirtyDrafts.delete(saved.id);
    this.renderInstances();
    this.updateDirty();
    await this.refreshPerformances();
    this.notify("路径已保存，下次播放会重新计算寻路");
  }
  private async toggleWorld() {
    if (this.worldPlaying) {
      this.motion.pauseAll();
      if (this.view.isPlaying) this.view.toggle();
      return;
    }
    const instances = this.draft?.instances ?? [];
    if (instances.some((i) => i.sceneMotion?.machine?.enabled))
      await this.motion.playAll();
    for (const i of instances.filter(
      (i) =>
        !i.sceneMotion?.machine?.enabled && i.sceneMotion?.selectedActionId,
    )) {
      const state = this.motion.getExecutionState(i.id);
      if (state?.status === "paused") this.motion.resumeExecution(i.id);
      else if (state?.status !== "running")
        await this.motion.executeAction(i.id);
    }
    if (instances.some((i) => i.clipId)) this.view.toggle();
  }
  private renderTraversalAssets() {
    const host = select<HTMLElement>(this.host, "[data-traversal-assets]");
    const records = this.traversalAssets.records.filter(
      (r) => r.mapId === this.map?.id,
    );
    host.hidden = !records.length;
    host.innerHTML = records
      .slice(0, 4)
      .map(
        (run) =>
          `<div><strong>${escape(run.status)}</strong>${run.tasks
            .filter((t) => t.kind === "animation")
            .map(
              (task) =>
                `<p>${escape(task.name)} · ${escape(task.status)}${["failed", "save-failed", "uncertain"].includes(task.state) ? ` <button class="secondary small" data-traversal-run="${escape(run.id)}" data-traversal-task="${escape(task.id)}">${task.state === "save-failed" ? "继续保存" : task.state === "uncertain" ? "确认重新生成" : "重试"}</button>` : ""}</p>`,
            )
            .join("")}</div>`,
      )
      .join("");
    host
      .querySelectorAll<HTMLButtonElement>("[data-traversal-task]")
      .forEach((button) => {
        button.onclick = () => {
          button.disabled = true;
          void this.traversalAssets
            .retry(button.dataset.traversalRun!, button.dataset.traversalTask!)
            .catch((error) => this.notify(message(error)))
            .finally(() => {
              button.disabled = false;
            });
        };
      });
  }
  setActive(active: boolean): void {
    if (!active) this.leavePlayer();
    this.active = active;
    if (!active) this.motion.pauseAll();
    this.updateRoleMode();
    this.view.setActive(active && !this.previewView);
    this.previewView?.setActive(active);
    if (active)
      void this.resourcesChanged().catch((e) => this.notify(message(e)));
  }
  async resourcesChanged(): Promise<void> {
    await this.refreshActors();
    for (const id of this.actors.keys())
      this.actors.set(id, await resources.actor(id));
    this.renderInstances();
    await this.refreshPerformances();
  }
  dispose(): void {
    this.leavePlayer();
    ++this.repairVersion;
    ++this.repairRouteVersion;
    ++this.pathRouteVersion;
    if (this.pathRouteTimer) clearTimeout(this.pathRouteTimer);
    clearInterval(this.observer);
    this.generation.dispose();
    this.traversalAssets.dispose();
    this.previewView?.dispose();
    this.sceneCoordinator.cancel();
    this.actionPanel.dispose();
    this.motion.dispose();
    this.view.dispose();
  }
}
