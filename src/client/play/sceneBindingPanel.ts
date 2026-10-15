import type { Actor, ActorInstance } from "../../shared/contracts";
import type { MapResource } from "../../shared/maps";
import type { SceneMotion } from "../../shared/sceneMotion";
import {
  actionInputs,
  actorAction,
  promoteLegacyAction,
  type BoundAction,
} from "../../shared/actionBinding";
import { ScenePoints, POINT_MIME } from "../actors/scenePoints";
import type { Viewport } from "../rendering/viewport";
import type { SceneMotionPort } from "../services/sceneMotionPort";
import { resources } from "../services/resources";
import { escape, select } from "../ui";
import type { ActionPoint } from "../../shared/motion";

/** Play places actor actions in a map. It never authors animation steps. */
export class SceneBindingPanel {
  private instance: ActorInstance | null = null;
  private actor: Actor | null = null;
  private map: MapResource | null = null;
  private pointId = "";
  private active = false;
  private mode: "position" | "behavior" = "behavior";
  private editingBindings = false;
  private addingAction = false;
  private editingNavigation = false;
  private busy = false;
  private selectedActionId: string | null = null;
  private configuredActionId: string | null = null;
  private markers: ScenePoints;
  private pathDraft: {
    points: ActionPoint[];
    visible: boolean;
    place: (id: string, point: ActionPoint) => void;
    invalid?: Set<string>;
    selected?: string;
    choose?: (id: string) => void;
    remove?: (id: string) => void;
  } | null = null;
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
      (id, point) => {
        if (this.pathDraft) {
          this.pathDraft.place(id, point);
          return;
        }
        this.edit((c) => {
          c.points[c.points.findIndex((p) => p.id === id)] = point;
        });
      },
      (id) => {
        this.pointId = id;
        if (this.pathDraft) {
          this.pathDraft.choose?.(id);
          this.syncMarkers();
          return;
        }
        this.render();
      },
    );
  }
  set(
    map: MapResource | null,
    instance: ActorInstance | null,
    actor: Actor | null,
  ) {
    if (this.instance?.id !== instance?.id || this.map?.id !== map?.id) {
      this.pointId = "";
      this.editingBindings = this.addingAction = this.editingNavigation = false;
      this.selectedActionId = null;
      this.configuredActionId = null;
    }
    if (
      this.configuredActionId !==
      (instance?.sceneMotion?.selectedActionId ?? null)
    ) {
      this.selectedActionId = instance?.sceneMotion?.selectedActionId ?? null;
      this.configuredActionId = this.selectedActionId;
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
    this.render();
    if (instance)
      void this.port.getGeometry().catch((e) => this.notify(String(e)));
  }
  setActive(active: boolean) {
    this.active = active;
    this.syncMarkers();
  }
  setPathDraft(value: typeof this.pathDraft) {
    this.pathDraft = value;
    this.syncMarkers();
  }
  armPathPoint(id: string) {
    this.markers.arm(id);
  }
  private syncMarkers() {
    this.markers.setRemovalHandler(
      this.pathDraft?.remove
        ? (id) => {
            if (!this.pathDraft?.visible) return;
            try {
              this.pathDraft.remove?.(id);
            } catch (error) {
              this.notify(
                error instanceof Error ? error.message : String(error),
              );
            }
          }
        : undefined,
    );
    const points =
      this.pathDraft?.points ?? this.instance?.sceneMotion?.points ?? [];
    if (!points.some((point) => point.id === this.pointId))
      this.pointId = points[0]?.id ?? "";
    this.markers.set(
      points,
      this.pathDraft?.selected ?? this.pointId,
      this.pathDraft?.invalid,
    );
    this.markers.show(
      this.active &&
        (!!this.instance || !!this.pathDraft) &&
        (this.pathDraft ? this.pathDraft.visible : this.mode === "position"),
    );
  }
  setMode(mode: "position" | "behavior") {
    if (this.mode === mode) return;
    this.mode = mode;
    this.render();
  }
  selectAction(id: string) {
    if (!this.instance?.sceneMotion?.actions.some((action) => action.id === id))
      return;
    this.selectedActionId = id;
    this.render();
  }
  private edit(update: (config: SceneMotion) => void) {
    if (!this.instance) return;
    try {
      this.port.updateConfiguration(this.instance.id, (i) =>
        update(i.sceneMotion!),
      );
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
    if (!c.actions.some((action) => action.id === this.selectedActionId))
      this.selectedActionId = c.selectedActionId;
    const selected = c.actions.find((a) => a.id === this.selectedActionId);
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
    this.host.innerHTML = `<section data-binding-position ${this.mode !== "position" ? "hidden" : ""}>
      <div class="panel-heading"><h3>地图标点</h3><button data-point-add aria-label="添加地图标点" class="secondary small" ${c.points.length >= 20 ? "disabled" : ""}>＋</button></div>
      <div class="scene-point-list">${c.points.map((p) => `<button data-point="${escape(p.id)}" class="secondary small ${p.id === this.pointId ? "active" : ""}" draggable="true">${escape(p.name)}</button>`).join("")}</div>
      ${point ? `<div class="point-detail"><label class="lifetime-field"><span>${escape(point.name)} · 向上高度</span><input data-offset type="number" min="0" step=".1" value="${point.height}" aria-label="场景标点离面高度"/></label><div class="toolbar-actions"><button data-place class="secondary small">重新定位</button><button data-point-delete class="secondary small">删除点</button></div></div>` : "<p class='lifetime-help'>添加点后，点击地图表面定位。</p>"}
      <label class="lifetime-field"><span>初始站位</span><select data-origin aria-label="动作起始站位"><option value="">角色位置</option>${c.points
        .filter((p) => p.ground)
        .map(
          (p) => `<option value="${escape(p.id)}">${escape(p.name)}</option>`,
        )
        .join("")}</select></label>
    </section>
    <section data-binding-behavior ${this.mode !== "behavior" ? "hidden" : ""}>
      <div class="panel-heading"><h3>完整动作</h3><button data-toggle-add-action aria-label="添加完整动作" class="secondary small">＋</button></div>
      ${legacy ? `<button data-promote class="secondary">${this.busy ? "整理中…" : "将旧动作归入演员库"}</button>` : ""}
      <div data-add-action-form ${this.addingAction ? "" : "hidden"}><label class="lifetime-field"><span>从演员动作库添加</span><select data-source-action aria-label="选择演员层动作"><option value="">选择完整动作</option>${library.map((a) => `<option value="${escape(a.id)}">${escape(a.name)}</option>`).join("")}</select></label><button data-bind-add class="secondary small">添加动作</button></div>
      <label class="lifetime-field"><span>所选动作</span><b class="inspected-action-name">${escape(selected?.name ?? "在左侧选择动作")}</b><select data-action aria-label="地图动作选择" hidden><option value="">选择动作</option>${c.actions.map((a) => `<option value="${escape(a.id)}">${escape(a.name)}</option>`).join("")}</select></label>
      ${
        binding
          ? `<div class="toolbar-actions"><button data-edit-bindings class="secondary small">${this.editingBindings ? "收起位置绑定" : "调整位置绑定"}</button></div><div data-bindings-form ${this.editingBindings ? "" : "hidden"}>
      <input data-binding-name aria-label="地图动作名称" value="${escape(binding.name)}"/>
      ${
        source
          ? actionInputs(source)
              .map(
                (slot) =>
                  `<label class="lifetime-field"><span>${escape(slot.name)} 的位置</span><select data-binding="${escape(slot.id)}" aria-label="动作输入 ${escape(slot.name)}">${pointOptions}</select></label>`,
              )
              .join("")
          : ""
      }
      <button data-binding-delete class="secondary small">移除此动作</button></div>
      ${!source ? `<p class="action-error">${escape(error)}</p>` : source.updatedAt !== binding.actorActionUpdatedAt ? '<p class="action-error">源动作已更新</p><button data-binding-refresh class="secondary small">更新动作引用</button>' : ""}`
          : ""
      }
    </section>
    <label class="lifetime-field"><span>移动能力</span><select data-traversal-mode aria-label="NPC 移动能力"><option value="ground" ${c.traversal?.fly ? "" : "selected"}>行走与跳跃</option><option value="fly" ${c.traversal?.fly ? "selected" : ""}>行走、跳跃与飞行</option></select></label>
    <p class="lifetime-help">先寻路，必要时跳跃；允许飞行后可到达空间点。播放时自动补齐缺少的导航动画并存入演员库。</p>
    <button data-toggle-nav class="secondary small" ${this.mode !== "position" ? "hidden" : ""}>调整通行能力</button>
    <div data-navigation-form ${this.editingNavigation && this.mode === "position" ? "" : "hidden"}><div class="transform-grid">${(["radius", "height", "climb", "slope"] as const).map((key, i) => `<label class="lifetime-field"><span>${["半径", "高度", "台阶高度", "最大坡度"][i]}</span><input data-nav="${key}" aria-label="导航 ${key}" type="number" step=".05" value="${c.navigation[key]}"/></label>`).join("")}</div><button data-nav-apply class="secondary small">应用</button></div><p data-scene-status class="lifetime-help" role="status" hidden></p>`;
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
    const traversal = select<HTMLSelectElement>(
      this.host,
      "[data-traversal-mode]",
    );
    traversal.onchange = () =>
      this.edit((config) => {
        config.traversal = {
          ...config.traversal,
          fly: traversal.value === "fly",
        };
      });
    on("[data-toggle-add-action]", () => {
      this.addingAction = !this.addingAction;
      this.render();
    });
    on("[data-edit-bindings]", () => {
      this.editingBindings = !this.editingBindings;
      this.render();
    });
    on("[data-toggle-nav]", () => {
      this.editingNavigation = !this.editingNavigation;
      this.render();
    });
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
    action.value = this.selectedActionId ?? "";
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
      this.addingAction = false;
      this.editingBindings = true;
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
            if (input.value && a.excludedRouteInputs)
              a.excludedRouteInputs = a.excludedRouteInputs.filter(
                (id) => id !== input.dataset.binding,
              );
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
        delete a.excludedRouteInputs;
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
    on("[data-promote]", () => this.promote());
    this.syncMarkers();
    this.status();
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
      : "";
    node.hidden = !node.textContent;
  }
  dispose() {
    this.markers.dispose();
  }
}
