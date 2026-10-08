import type { Actor, ActorInstance } from "../../shared/contracts";
import type { MapResource } from "../../shared/maps";
import type { SceneMotion } from "../../shared/sceneMotion";
import {
  actionInputs,
  actorAction,
  promoteLegacyAction,
  type BoundAction,
} from "../../shared/actionBinding";
import { pointPosition } from "../../shared/motion";
import { ScenePoints, POINT_MIME } from "../actors/scenePoints";
import type { Viewport } from "../rendering/viewport";
import type {
  PreparedSceneAction,
  SceneMotionPort,
} from "../services/sceneMotionPort";
import { resources } from "../services/resources";
import { escape, select } from "../ui";

/** Play places actor actions in a map. It never authors animation steps. */
export class SceneBindingPanel {
  private instance: ActorInstance | null = null;
  private actor: Actor | null = null;
  private map: MapResource | null = null;
  private pointId = "";
  private prepared: PreparedSceneAction | null = null;
  private version = 0;
  private key = "";
  private active = false;
  private busy = false;
  private markers: ScenePoints;
  get duration() {
    return this.prepared?.timings.at(-1)?.end ?? 0;
  }
  constructor(
    private host: HTMLElement,
    canvas: HTMLCanvasElement,
    private view: Viewport,
    private port: SceneMotionPort,
    private dirty: () => void,
    private notify: (text: string) => void,
  ) {
    this.markers = new ScenePoints(
      canvas,
      view,
      (id, point) =>
        this.edit((c) => {
          c.points[c.points.findIndex((p) => p.id === id)] = point;
        }),
      (id) => {
        this.pointId = id;
        this.render();
      },
    );
  }
  set(
    map: MapResource | null,
    instance: ActorInstance | null,
    actor: Actor | null,
  ) {
    if (this.instance !== instance || this.map?.id !== map?.id) {
      this.version++;
      this.prepared = null;
      this.pointId = "";
    }
    this.instance = instance;
    this.map = map;
    this.actor = actor;
    if (instance && !instance.sceneMotion) {
      const size = this.view.instanceSize(instance.id);
      instance.sceneMotion = {
        schemaVersion: 2,
        points: [],
        actions: [],
        selectedActionId: null,
        startPointId: null,
        navigation: {
          radius: Math.max(0.1, Math.hypot(size[0], size[2]) / 2 + 0.05),
          height: Math.max(0.2, size[1]),
          climb: 0.3,
          slope: 35,
        },
      };
      this.dirty();
    }
    const key = JSON.stringify([instance, actor?.updatedAt]);
    if (key !== this.key) {
      this.version++;
      this.prepared = null;
      this.key = key;
    }
    this.render();
    if (instance)
      void this.port.getGeometry().catch((e) => this.notify(String(e)));
  }
  setActive(active: boolean) {
    this.active = active;
    this.markers.show(active && !!this.instance);
  }
  private edit(update: (config: SceneMotion) => void) {
    if (!this.instance) return;
    try {
      this.port.updateConfiguration(this.instance.id, (i) =>
        update(i.sceneMotion!),
      );
      this.prepared = null;
      this.version++;
      this.dirty();
      this.render();
    } catch (error) {
      this.notify(error instanceof Error ? error.message : String(error));
    }
  }
  private render() {
    this.host.hidden = !this.instance;
    if (!this.instance || !this.actor) {
      this.host.replaceChildren();
      this.markers.set([], "");
      this.markers.show(false);
      return;
    }
    const c = this.instance.sceneMotion!,
      legacy = c.schemaVersion === 1 && c.actions.length > 0;
    if (!c.points.some((p) => p.id === this.pointId))
      this.pointId = c.points[0]?.id ?? "";
    const point = c.points.find((p) => p.id === this.pointId);
    const pointOptions =
      '<option value="">选择地图点</option>' +
      c.points
        .map(
          (p) =>
            `<option value="${escape(p.id)}">${escape(p.name)}${p.ground ? "" : "（待放置）"}</option>`,
        )
        .join("");
    const selected = c.actions.find((a) => a.id === c.selectedActionId);
    const binding = selected && !("plan" in selected) ? selected : null;
    let source = null,
      error = "";
    try {
      if (binding)
        source = actorAction(
          this.actor,
          binding,
          this.instance.modelRevisionId,
          false,
        );
    } catch (e) {
      error = String(e);
    }
    const library = (this.actor.motionActions ?? [])
      .filter((a) => a.modelRevisionId === this.instance!.modelRevisionId)
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt);
    this.host.innerHTML = `<div class="panel-heading"><h3>地图与动作绑定</h3><button data-focus class="secondary small">聚焦演员</button></div>
      <div class="panel-heading"><b>地图标点</b><button data-point-add class="secondary small" ${c.points.length >= 20 ? "disabled" : ""}>＋ 添加点</button></div>
      <div class="scene-point-list">${c.points.map((p) => `<button data-point="${escape(p.id)}" class="secondary small ${p.id === this.pointId ? "active" : ""}" draggable="true">${escape(p.name)}</button>`).join("")}</div>
      ${
        point
          ? `<div class="toolbar-actions"><button data-place class="secondary small">放置 ${escape(point.name)}</button><button data-point-delete class="secondary small">删除点</button></div><p class="lifetime-help">${
              point.ground
                ? pointPosition(point)
                    .map((n) => n.toFixed(2))
                    .join("，")
                : "点击放置后点击地图，或拖入地图表面。"
            }</p><label class="lifetime-field"><span>离面高度</span><input data-offset type="number" min="0" step=".1" value="${point.height}" aria-label="场景标点离面高度"/></label>`
          : ""
      }
      <label class="lifetime-field"><span>角色初始站位</span><select data-origin aria-label="动作起始站位"><option value="">演员设计位置</option>${c.points
        .filter((p) => p.ground)
        .map(
          (p) => `<option value="${escape(p.id)}">${escape(p.name)}</option>`,
        )
        .join("")}</select></label>
      ${legacy ? `<p class="lifetime-help">旧演出仍可播放。先将内嵌动作归入演员层，再编辑地图绑定；原动作顺序与状态引用保留。</p><button data-promote class="secondary" ${this.busy ? "disabled" : ""}>${this.busy ? "迁移中…" : "将旧动作归入演员库"}</button>` : `<label class="lifetime-field"><span>演员层动作库</span><select data-source-action aria-label="选择演员层动作"><option value="">选择完整动作</option>${library.map((a) => `<option value="${escape(a.id)}">${escape(a.name)}</option>`).join("")}</select></label><button data-bind-add class="secondary small">＋ 加入地图动作</button><p class="lifetime-help">动画与动作在 Actors 制作，这里只绑定地图位置。</p>`}
      <label class="lifetime-field"><span>地图动作</span><select data-action aria-label="地图动作选择"><option value="">未选择</option>${c.actions.map((a) => `<option value="${escape(a.id)}">${escape(a.name)}</option>`).join("")}</select></label>
      ${
        binding
          ? `<label class="lifetime-field"><span>地图动作名称</span><input data-binding-name aria-label="地图动作名称" value="${escape(binding.name)}"/></label><p class="lifetime-help">来源：${escape(source?.name ?? "缺失动作")}。${source ? source.plan.steps.length + " 个内部步骤，由演员层定义。" : escape(error)}</p>
      ${
        source
          ? `<p class="lifetime-help">${escape(source.prompt.slice(0, 240))}</p>${source.updatedAt !== binding.actorActionUpdatedAt ? '<p class="action-error">演员动作已修改，请更新引用并检查绑定。</p><button data-binding-refresh class="secondary small">更新动作引用</button>' : ""}${
              actionInputs(source)
                .map(
                  (slot) =>
                    `<label class="lifetime-field"><span>${escape(slot.name)} → 地图点</span><select data-binding="${escape(slot.id)}" aria-label="动作输入 ${escape(slot.name)}">${pointOptions}</select></label>`,
                )
                .join("") ||
              '<p class="lifetime-help">此动作无需位置输入，在当前站位执行。</p>'
            }`
          : ""
      }<button data-binding-delete class="secondary small">移除此地图动作</button>`
          : ""
      }
      <details><summary>角色通行尺寸</summary><div class="transform-grid">${(["radius", "height", "climb", "slope"] as const).map((key, index) => `<label class="lifetime-field"><span>${["半径", "高度", "台阶高度", "最大坡度"][index]}</span><input data-nav="${key}" aria-label="导航 ${key}" type="number" step=".05" value="${c.navigation[key]}"/></label>`).join("")}</div><button data-nav-apply class="secondary small">应用通行参数</button></details>
      <div class="toolbar-actions"><button data-route class="secondary">检查路线</button><button data-preview class="secondary">预览所选动作</button><button data-reset class="secondary small">停止复位</button></div><p data-scene-status class="lifetime-help" role="status"></p>`;
    const on = (query: string, work: () => void | Promise<void>) => {
      const b = this.host.querySelector<HTMLElement>(query);
      if (b)
        b.onclick = () => {
          Promise.resolve()
            .then(work)
            .catch((e) =>
              this.notify(e instanceof Error ? e.message : String(e)),
            );
        };
    };
    on("[data-focus]", () => this.view.focusInstance(this.instance!.id));
    on("[data-point-add]", () => {
      const id = crypto.randomUUID();
      this.pointId = id;
      this.edit((c) => {
        let n = 1;
        while (c.points.some((p) => p.name === "p" + n)) n++;
        c.points.push({ id, name: "p" + n, ground: null, height: 0 });
      });
      this.markers.arm(id);
    });
    this.host
      .querySelectorAll<HTMLButtonElement>("[data-point]")
      .forEach((b) => {
        b.onclick = () => {
          this.pointId = b.dataset.point!;
          this.render();
        };
        b.ondragstart = (e) => {
          e.dataTransfer?.setData(POINT_MIME, b.dataset.point!);
          this.markers.beginDrag(b.dataset.point!);
        };
      });
    on("[data-place]", () => this.markers.arm(this.pointId));
    on("[data-point-delete]", () =>
      this.edit((c) => {
        if (
          c.startPointId === this.pointId ||
          c.actions.some((a) =>
            "plan" in a
              ? JSON.stringify(a.plan).includes(this.pointId)
              : Object.values(a.bindings).includes(this.pointId),
          )
        )
          throw new Error("此点被站位或动作绑定引用，请先调整绑定");
        c.points = c.points.filter((p) => p.id !== this.pointId);
      }),
    );
    const offset = this.host.querySelector<HTMLInputElement>("[data-offset]");
    if (offset)
      offset.onchange = () =>
        this.edit((c) => {
          c.points.find((p) => p.id === this.pointId)!.height =
            offset.valueAsNumber;
        });
    const origin = select<HTMLSelectElement>(this.host, "[data-origin]");
    origin.value = c.startPointId ?? "";
    origin.onchange = () =>
      this.edit((c) => {
        c.startPointId = origin.value || null;
      });
    const action = select<HTMLSelectElement>(this.host, "[data-action]");
    action.value = c.selectedActionId ?? "";
    action.onchange = () =>
      this.edit((c) => {
        c.selectedActionId = action.value || null;
      });
    on("[data-bind-add]", () => {
      const id = select<HTMLSelectElement>(
          this.host,
          "[data-source-action]",
        ).value,
        source = library.find((a) => a.id === id);
      if (!source) throw new Error("请选择演员层已经保存的完整动作");
      this.port.bindAction(this.instance!.id, source.id);
    });
    const name = this.host.querySelector<HTMLInputElement>(
      "[data-binding-name]",
    );
    if (name)
      name.onchange = () =>
        this.edit((c) => {
          c.actions.find((a) => a.id === binding!.id)!.name = name.value.trim();
        });
    this.host
      .querySelectorAll<HTMLSelectElement>("[data-binding]")
      .forEach((input) => {
        input.value = binding!.bindings[input.dataset.binding!] ?? "";
        input.onchange = () =>
          this.edit((c) => {
            const a = c.actions.find(
              (a) => a.id === binding!.id,
            )! as BoundAction;
            if (input.value) a.bindings[input.dataset.binding!] = input.value;
            else delete a.bindings[input.dataset.binding!];
          });
      });
    on("[data-binding-refresh]", () =>
      this.edit((c) => {
        const a = c.actions.find((a) => a.id === binding!.id)! as BoundAction;
        const valid = new Set(actionInputs(source!).map((s) => s.id));
        a.bindings = Object.fromEntries(
          Object.entries(a.bindings).filter(([k]) => valid.has(k)),
        );
        a.actorActionUpdatedAt = source!.updatedAt;
      }),
    );
    on("[data-binding-delete]", () =>
      this.edit((c) => {
        if (c.machine?.states.some((s) => s.actionId === binding!.id))
          throw new Error("请先移除或调整引用该动作的状态");
        c.actions = c.actions.filter((a) => a.id !== binding!.id);
        c.selectedActionId = c.actions[0]?.id ?? null;
      }),
    );
    on("[data-nav-apply]", () =>
      this.edit((c) => {
        for (const key of ["radius", "height", "climb", "slope"] as const)
          c.navigation[key] = select<HTMLInputElement>(
            this.host,
            `[data-nav="${key}"]`,
          ).valueAsNumber;
      }),
    );
    on("[data-route]", async () => {
      const p = await this.prepare();
      if (p) this.view.showSceneGuide(p.instanceId, p.runtime.getTrajectory());
    });
    on("[data-preview]", () => this.preview());
    on("[data-reset]", () => this.port.cancelExecution(this.instance!.id));
    on("[data-promote]", () => this.promote());
    this.markers.set(c.points, this.pointId);
    this.markers.show(this.active);
    this.status();
  }
  private async prepare() {
    if (!this.instance) throw new Error("请选择角色");
    const version = this.version,
      id = this.instance.id,
      p = await this.port.prepareAction(id);
    if (version !== this.version || this.instance?.id !== id) return null;
    this.prepared = p;
    this.status();
    return p;
  }
  async preview() {
    const p = await this.prepare();
    if (p) this.port.startPrepared(p);
  }
  private async promote() {
    if (!this.instance || !this.actor || this.busy) return;
    const id = this.instance.id,
      original = this.port.getConfiguration(id).sceneMotion!,
      key = JSON.stringify(original);
    const config = structuredClone(original);
    let actor = this.actor;
    this.busy = true;
    this.render();
    try {
      const migrated: BoundAction[] = [];
      for (const a of config.actions) {
        if (!("plan" in a)) {
          migrated.push(a);
          continue;
        }
        const converted = promoteLegacyAction(a, config.points);
        actor = await resources.saveMotionAction(actor.id, converted.source);
        converted.binding.actorActionUpdatedAt = actor.motionActions!.find(
          (a) => a.id === converted.source.id,
        )!.updatedAt;
        migrated.push(converted.binding);
        config.points = converted.points;
      }
      this.port.updateActor(actor);
      this.actor = actor;
      if (JSON.stringify(this.port.getConfiguration(id).sceneMotion) !== key)
        throw new Error("地图配置已修改；演员动作已保存，请重新迁移");
      config.schemaVersion = 2;
      config.actions = migrated;
      this.port.setConfiguration(id, config);
      this.notify("旧动作已归入演员层，请保存演出以保留地图绑定");
    } finally {
      this.busy = false;
      this.render();
    }
  }
  status() {
    const node = this.host.querySelector<HTMLElement>("[data-scene-status]");
    if (!node || !this.instance) return;
    const state = this.port.getExecutionState(this.instance.id);
    node.textContent = state
      ? `${state.status === "running" ? "播放中" : state.status === "paused" ? "已暂停" : state.status === "completed" ? "已完成" : "已停止"} · ${state.elapsed.toFixed(2)} / ${state.duration.toFixed(2)} 秒`
      : this.prepared
        ? `路线已检查 · ${this.duration.toFixed(2)} 秒`
        : "绑定地图点后可以检查路线或直接播放。";
  }
  dispose() {
    this.version++;
    this.markers.dispose();
  }
}
