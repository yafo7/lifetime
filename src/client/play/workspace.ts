import { SceneMotionPort } from "../services/sceneMotionPort";
import { SceneBindingPanel } from "./sceneBindingPanel";
import { CharacterMachinePanel } from "./characterMachinePanel";
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

export class PlayWorkspace {
  private view: Viewport;
  readonly motion: SceneMotionPort;
  private actionPanel: SceneBindingPanel;
  private machinePanel: CharacterMachinePanel;
  private map: MapResource | null = null;
  private draft: Performance | null = null;
  private drafts = new Map<string, Performance>();
  private actors = new Map<string, Actor>();
  private libraryActor: Actor | null = null;
  private selectedId: string | null = null;
  private loading = false;
  private libraryVersion = 0;
  private dirtyDrafts = new Set<string>();
  get dirty(): boolean {
    return this.dirtyDrafts.size > 0;
  }
  constructor(
    private host: HTMLElement,
    private notify: (text: string) => void,
  ) {
    host.innerHTML = /* HTML */ `<div class="workspace-head">
        <div>
          <span class="eyebrow">PERFORMANCE WORKSPACE</span>
          <h1>演出区域</h1>
          <p>打开地图，绑定演员动作，设置角色状态之间的关系。</p>
        </div>
        <span class="lifetime-status-pill" data-map-status>尚未打开地图</span>
      </div>
      <div class="play-layout">
        <aside class="lifetime-panel play-map-panel">
          <div class="panel-heading">
            <h2>地图库</h2>
            <button data-import class="secondary small">导入</button>
          </div>
          <input data-file type="file" accept=".json,.zip" hidden />
          <p class="lifetime-help">
            支持地图 JSON、渲染方案 JSON 和完整场景 ZIP。
          </p>
          <div data-maps class="play-map-list"></div>
          <div class="panel-heading saved-heading"><h2>已保存演出</h2></div>
          <div data-performances class="clip-list"></div>
        </aside>
        <section class="actor-preview-column">
          <div class="play-preview-card">
            <div class="actor-preview-toolbar">
              <span data-map-name>地图预览</span>
              <div class="toolbar-actions">
                <button data-world-play class="secondary small">
                  ▶ 播放全部角色
                </button>
                <button data-world-pause class="secondary small">
                  暂停全部
                </button>
                <button data-world-stop class="secondary small">
                  停止全部
                </button>
                <button data-fit class="secondary small">重置视角</button
                ><a data-export class="button secondary small" hidden
                  >导出地图</a
                >
              </div>
            </div>
            <div class="actor-preview-stage play-scene">
              <canvas data-canvas aria-label="演出三维预览"></canvas>
              <div data-placeholder class="preview-placeholder">
                从左侧导入或打开一张地图
              </div>
            </div>
            <div class="actor-preview-navigation">
              左键旋转 · 右键平移 · 滚轮缩放 · 点击演员选择实例
            </div>
            <div class="playback-strip">
              <button data-play disabled>▶ 播放</button
              ><button data-stop>停止</button
              ><input
                data-seek
                type="range"
                min="0"
                max="1"
                step="any"
                value="0"
                aria-label="演出进度"
                disabled
              /><span data-time>0.00 / 0.00 秒</span>
            </div>
          </div>
        </section>
        <aside class="lifetime-panel play-cast-panel">
          <div class="panel-heading">
            <h2>演出演员</h2>
            <span class="muted" data-count>0</span>
          </div>
          <label class="lifetime-field"
            ><span>演员</span
            ><select data-actor aria-label="添加到演出的演员"></select></label
          ><label class="lifetime-field"
            ><span>模型版本</span
            ><select data-model aria-label="添加演员模型版本"></select></label
          ><button data-add class="lifetime-primary" disabled>
            ＋ 加入演出
          </button>
          <div data-instances class="clip-list instance-list"></div>
          <details data-inspector hidden>
            <summary>实例位置与尺寸</summary>
            <div class="transform-grid">
              ${["x", "y", "z", "rotation", "scale"].map((key, i) => `<label class="lifetime-field"><span>${["位置 X", "位置 Y", "位置 Z", "朝向（°）", "缩放"][i]}</span><input data-transform="${key}" type="number" step="${key === "rotation" ? "5" : "0.1"}" ${key === "scale" ? 'min="0.01"' : ""} aria-label="${["位置 X", "位置 Y", "位置 Z", "朝向", "缩放"][i]}"></label>`).join("")}
            </div>
            <button data-remove class="secondary small">移除此实例</button>
          </details>
          <div data-character-machine class="scene-action-panel" hidden></div>
          <div data-scene-action-panel class="scene-action-panel" hidden></div>
          <div class="draft-save">
            <label class="lifetime-field"
              ><span>演出名称</span
              ><input
                data-draft-name
                placeholder="未命名演出"
                aria-label="演出名称" /></label
            ><button data-save class="lifetime-primary" disabled>
              保存演出</button
            ><span data-dirty class="lifetime-help"></span>
          </div>
        </aside>
      </div>`;
    this.view = new Viewport(select(host, "[data-canvas]"));
    this.motion = new SceneMotionPort(this.view);
    window.lifetimeSceneMotion = this.motion;
    this.actionPanel = new SceneBindingPanel(
      select(host, "[data-scene-action-panel]"),
      select(host, "[data-canvas]"),
      this.view,
      this.motion,
      () => this.markDirty(),
      (text) => this.notify(text),
    );
    this.machinePanel = new CharacterMachinePanel(
      select(host, "[data-character-machine]"),
      this.motion,
      (text) => this.notify(text),
    );
    this.motion.onChange = () => {
      this.actionPanel.status();
      this.machinePanel.status();
      this.renderInstanceStatus();
    };
    this.motion.onConfigurationChange = () => {
      this.markDirty();
      this.renderInstances();
    };
    this.view.onPlayback = (time, duration, playing) => {
      const actionState = this.selectedId
        ? this.motion.getExecutionState(this.selectedId)
        : null;
      const instance = this.draft?.instances.find(
        (i) => i.id === this.selectedId,
      );
      const selectedAction = instance?.sceneMotion?.actions.some(
        (a) => a.id === instance.sceneMotion?.selectedActionId,
      );
      const machine = this.selectedId
        ? this.motion.getMachineState(this.selectedId)
        : null;
      const machineEnabled = !!instance?.sceneMotion?.machine?.enabled;
      if ((selectedAction || machineEnabled) && !actionState) {
        time = 0;
        duration = machineEnabled ? 0 : this.actionPanel.duration;
        playing = false;
      }
      if (actionState) {
        time = actionState.elapsed;
        duration = actionState.duration;
        playing = actionState.status === "running";
      }
      if (machine)
        playing = ["running", "waiting", "starting"].includes(machine.status);
      const slider = select<HTMLInputElement>(host, "[data-seek]");
      slider.max = String(duration || 1);
      slider.value = String(time);
      slider.disabled = !duration || (!!selectedAction && !actionState);
      select(host, "[data-time]").textContent =
        `${time.toFixed(2)} / ${duration.toFixed(2)} 秒`;
      const b = select<HTMLButtonElement>(host, "[data-play]");
      select<HTMLElement>(host, "[data-stop]").hidden =
        !!selectedAction || machineEnabled;
      b.disabled =
        this.loading || (!selectedAction && !machineEnabled && !duration);
      b.textContent = playing ? "Ⅱ 暂停" : "▶ 播放";
    };
    this.view.onSelect = (id) => {
      this.selectedId = id;
      this.renderInstances();
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
    on("[data-world-play]", () => this.exclusive(() => this.motion.playAll()));
    on("[data-world-pause]", () => this.motion.pauseAll());
    on("[data-world-stop]", () => this.motion.cancelAll());
    on("[data-play]", () =>
      this.exclusive(async () => {
        const i = this.draft?.instances.find((i) => i.id === this.selectedId);
        if (i?.sceneMotion?.machine?.enabled) {
          const state = this.motion.getMachineState(i.id);
          if (
            state &&
            ["running", "waiting", "starting"].includes(state.status)
          )
            this.motion.pauseExecution(i.id);
          else if (state?.status === "paused")
            this.motion.resumeExecution(i.id);
          else await this.motion.startStateMachine(i.id);
        } else if (i?.sceneMotion?.selectedActionId) {
          const state = this.motion.getExecutionState(i.id);
          if (state?.status === "running") this.motion.pauseExecution(i.id);
          else if (state?.status === "paused")
            this.motion.resumeExecution(i.id);
          else await this.actionPanel.preview();
        } else this.view.toggle();
      }),
    );
    on("[data-stop]", () => {
      this.motion.cancelAll();
      this.view.stop();
    });
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
          "未命名演出";
        this.draft = await resources.savePerformance(this.draft);
        this.motion.bind(this.map!, this.actors, this.draft.instances);
        this.renderInstances();
        this.dirtyDrafts.delete(this.draft.id);
        this.updateDirty();
        await this.refreshPerformances();
        this.notify("演出已保存");
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
    }
  }
  private async refreshMaps(): Promise<void> {
    const maps = await resources.list("maps");
    select(this.host, "[data-maps]").innerHTML = maps.length
      ? maps
          .map(
            (m) =>
              `<button class="play-map-item" data-map-id="${escape(m.id)}"><span class="map-thumb">◇</span><span><b>${escape(m.name)}</b><small>已保存地图</small></span><span>›</span></button>`,
          )
          .join("")
      : '<div class="empty-state">暂无地图<br>导入一张地图开始演出</div>';
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
    const list = await resources.list("performances");
    select(this.host, "[data-performances]").innerHTML = list.length
      ? list
          .map(
            (p) =>
              `<button class="clip-item" data-performance-id="${escape(p.id)}"><b>${escape(p.name)}</b><small>打开演出</small></button>`,
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
    if (this.draft)
      this.drafts.set(this.draft.mapId, structuredClone(this.draft));
    const map = await resources.map(id);
    const draft = saved ??
      this.drafts.get(id) ?? {
        id: crypto.randomUUID(),
        name: `${map.name} · 演出`,
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
    await this.refreshActors();
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
    const instances = this.draft?.instances ?? [];
    select(this.host, "[data-count]").textContent = String(instances.length);
    select(this.host, "[data-instances]").innerHTML = instances
      .map(
        (i, n) =>
          `<button class="clip-item ${i.id === this.selectedId ? "active" : ""}" data-instance-id="${i.id}"><b>${escape(this.actors.get(i.actorId)?.name)} · ${n + 1}</b><small data-instance-status="${i.id}"></small></button>`,
      )
      .join("");
    this.host.querySelectorAll<HTMLButtonElement>("[data-instance-id]").forEach(
      (b) =>
        (b.onclick = () => {
          this.selectedId = b.dataset.instanceId!;
          this.renderInstances();
        }),
    );
    const instance = instances.find((i) => i.id === this.selectedId);
    select<HTMLElement>(this.host, "[data-inspector]").hidden = !instance;
    this.actionPanel.set(
      this.map,
      instance ?? null,
      instance ? (this.actors.get(instance.actorId) ?? null) : null,
    );
    this.machinePanel.set(instance ?? null);
    this.renderInstanceStatus();
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
  private renderInstanceStatus() {
    for (const i of this.draft?.instances ?? []) {
      const node = this.host.querySelector<HTMLElement>(
        `[data-instance-status="${i.id}"]`,
      );
      if (!node) continue;
      const state = this.motion.getMachineState(i.id),
        rules = i.sceneMotion?.machine;
      const name =
        rules?.states.find((s) => s.id === state?.stateId)?.name ?? "";
      node.textContent = state
        ? `${name} · ${{ starting: "准备中", running: "执行中", waiting: "等待中", paused: "已暂停", completed: "已完成", stopped: "已停止", failed: "失败" }[state.status]}`
        : rules?.enabled
          ? "状态机待播放"
          : i.clipId
            ? "动画已选择"
            : "静态模型";
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
    if (this.draft) this.dirtyDrafts.add(this.draft.id);
    this.updateDirty();
  }
  private updateDirty(): void {
    select(this.host, "[data-dirty]").textContent =
      this.draft && this.dirtyDrafts.has(this.draft.id)
        ? "有未保存的演出更改"
        : "演出已保存";
  }
  setActive(active: boolean): void {
    if (!active) this.motion.pauseAll();
    this.actionPanel.setActive(active);
    this.view.setActive(active);
    if (active)
      void this.resourcesChanged().catch((e) => this.notify(message(e)));
  }
  async resourcesChanged(): Promise<void> {
    await this.refreshActors();
    for (const id of this.actors.keys())
      this.actors.set(id, await resources.actor(id));
    this.renderInstances();
  }
  dispose(): void {
    this.actionPanel.dispose();
    this.motion.dispose();
    this.view.dispose();
  }
}
