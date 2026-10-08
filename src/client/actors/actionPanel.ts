import type { Actor } from "../../shared/contracts";
import {
  validateAction,
  validateDocument,
  validatePoints,
  validateAnimationReferences,
  promptText,
  type ActionPoint,
  type PromptPart,
  type MotionContext,
  type MotionPlan,
  type SavedAction,
} from "../../shared/motion";
import { resources } from "../services/resources";
import { planMotion } from "../services/motionPlanner";
import type { MotionPort } from "../services/motionPort";
import type { Viewport } from "../rendering/viewport";
import { escape, select } from "../ui";
import { ScenePoints, POINT_MIME } from "./scenePoints";
import { PointPrompt } from "./pointPrompt";
import { ActionTimeline } from "./actionTimeline";
import {
  editAnimation,
  clearAnimation,
  appendAnimation,
  type AnimationEdit,
} from "../motion/editing";
import type { MotionOrigin } from "../motion/runtime";
import { createActionTemplate } from "../../shared/actionTemplates";
import { mountActionTemplatePanel } from "./actionTemplatePanel";

interface State {
  actionId: string;
  document: PromptPart[];
  points: ActionPoint[];
  selected: string;
  plan: MotionPlan | null;
  dirty: boolean;
  error: string;
  busy: boolean;
  origin: MotionOrigin | null;
  modified: boolean;
}
const empty = (): State => ({
  actionId: "",
  document: [],
  points: [],
  selected: "",
  plan: null,
  dirty: false,
  error: "",
  busy: false,
  origin: null,
  modified: false,
});
export class ActionPanel {
  private actor: Actor | null = null;
  private revision = "";
  private key = "";
  private ready = false;
  private states = new Map<string, State>();
  private state = empty();
  private controller: AbortController | null = null;
  private scene: ScenePoints;
  private composer: PointPrompt | null = null;
  private visible = false;
  private active = true;
  private timeline: ActionTimeline;
  private playbackDuration = 0;
  get playback() {
    return {
      selected: this.visible,
      ready:
        this.visible &&
        this.ready &&
        !!this.state.plan &&
        !this.state.dirty &&
        !this.state.busy &&
        this.playbackDuration > 0,
      duration: this.playbackDuration,
    };
  }
  togglePlayback(): void {
    const state = this.port.getExecutionState();
    if (state?.status === "running")
      this.port.pauseExecution(state.executionId);
    else if (state?.status === "paused")
      this.port.resumeExecution(state.executionId);
    else this.preview();
  }
  seekPlayback(seconds: number): void {
    if (!this.port.getExecutionState()) {
      this.preview();
      const state = this.port.getExecutionState()!;
      this.port.pauseExecution(state.executionId);
    }
    this.view.seek(seconds);
  }
  constructor(
    private library: HTMLElement,
    private editor: HTMLElement,
    private enter: () => void,
    private port: MotionPort,
    private notify: (text: string) => void,
    canvas: HTMLCanvasElement,
    private view: Viewport,
    timelineHost: HTMLElement,
  ) {
    this.timeline = new ActionTimeline(
      timelineHost,
      (step, layer, edit) => this.editSegment(step, layer, edit),
      () => this.run(() => this.preview()),
      () => {
        const s = this.port.getExecutionState();
        if (s?.status === "running") this.port.pauseExecution(s.executionId);
      },
      (stepId, clipId, layer) => this.changeSlot(stepId, clipId, layer),
    );
    this.scene = new ScenePoints(
      canvas,
      view,
      (id, point) => {
        const p = this.state.points.find((p) => p.id === id);
        if (!p) return;
        Object.assign(p, point);
        this.state.selected = id;
        this.state.error = "";
        this.render();
      },
      (id) => {
        this.state.selected = id;
        this.render();
      },
    );
  }
  context(actor: Actor | null, revision: string, ready = false): void {
    const key = `${actor?.id}/${revision}`;
    if (this.key !== key) this.abort();
    this.actor = actor;
    this.revision = revision;
    this.ready = ready;
    if (ready) this.view.setActorSurfaceId(`${actor?.id}:${revision}`);
    this.key = key;
    this.state = this.states.get(key) ?? empty();
    this.states.set(key, this.state);
    this.render();
  }
  setVisible(value: boolean): void {
    this.visible = value;
    this.scene.show(value && this.active && this.ready);
    this.timeline.show(false);
  }
  setActive(value: boolean): void {
    this.active = value;
    this.scene.show(value && this.visible && this.ready);
    this.timeline.show(false);
  }
  private ctx(legacy = true): MotionContext {
    if (!this.actor) throw new Error("请先选择演员");
    const pool =
      legacy && this.state.plan?.schemaVersion === 1
        ? (this.actor.pools ?? this.actor.actions)?.find(
            (p) => p.id === this.state.plan?.poolId,
          )
        : undefined;
    return {
      actor: this.actor,
      modelRevisionId: this.revision,
      points: this.state.points,
      pool,
    };
  }
  private bind(): void {
    this.port.bind(
      this.ready ? this.ctx() : null,
      `${this.actor?.id}:${this.revision}`,
    );
  }
  private abort(): void {
    this.controller?.abort();
    this.controller = null;
  }
  private run(work: () => void | Promise<void>): void {
    const state = this.state;
    Promise.resolve()
      .then(work)
      .catch((e) => {
        state.error = e instanceof Error ? e.message : String(e);
        this.notify(state.error);
        if (this.state === state) this.render();
      });
  }
  private on(query: string, work: () => void | Promise<void>): void {
    select<HTMLButtonElement>(this.editor, query).onclick = () =>
      this.run(work);
  }
  private snapshot(st = this.state): string {
    return JSON.stringify({
      document: st.document,
      points: st.points,
      actionId: st.actionId,
      plan: st.plan,
    });
  }
  private render(): void {
    this.bind();
    const st = this.state;
    this.scene.set(st.points, st.selected);
    this.scene.show(this.visible && this.active && this.ready);
    const actions = (this.actor?.motionActions ?? [])
      .filter((a) => a.modelRevisionId === this.revision)
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt);
    this.library.innerHTML = `<div class="panel-heading"><h2><button class="library-title" data-open>动作库</button></h2><button class="small" data-new ${!this.revision ? "disabled" : ""}>＋ 新建</button></div><div class="clip-list library-scroll">${actions.map((a) => `<button class="clip-item ${st.actionId === a.id ? "active" : ""}" data-action="${escape(a.id)}"><b>${escape(a.name)}</b><small>${a.plan.steps.length} 个步骤</small></button>`).join("") || '<p class="empty-state">用文字和地图标点创建动作。</p>'}</div>`;
    select<HTMLButtonElement>(this.library, "[data-open]").onclick = () =>
      this.enter();
    select<HTMLButtonElement>(this.library, "[data-new]").onclick = () => {
      this.abort();
      this.port.invalidateAction();
      this.state = empty();
      this.states.set(this.key, this.state);
      this.enter();
      this.render();
    };
    this.library.querySelectorAll<HTMLButtonElement>("[data-action]").forEach(
      (b) =>
        (b.onclick = () => {
          this.abort();
          this.port.invalidateAction();
          const a = actions.find((a) => a.id === b.dataset.action)!;
          this.state = {
            ...empty(),
            actionId: a.id,
            document: structuredClone(
              a.document ?? [{ type: "text", text: a.prompt }],
            ),
            points: structuredClone(a.points ?? []),
            plan: structuredClone(a.plan),
          };
          // Old parameter defaults become editable markers, without modifying saved files on read.
          const plan = this.state.plan!;
          for (const [name, param] of Object.entries(plan.parameters ?? {})) {
            if (!param.default) continue;
            const id = crypto.randomUUID(),
              [x, y, z] = param.default;
            this.state.points.push({
              id,
              name: `p${this.state.points.length + 1}`,
              ground: [x, 0, z],
              height: y,
            });
            const replace = (target: any) =>
              target && !Array.isArray(target) && target.parameter === name
                ? { point: id }
                : target;
            if (plan.start) plan.start = replace(plan.start);
            for (const step of plan.steps)
              if (step.type === "moveTo") {
                step.destination = replace(step.destination);
                if (step.path?.via) step.path.via = step.path.via.map(replace);
              }
            delete plan.parameters![name];
          }
          this.states.set(this.key, this.state);
          this.enter();
          this.render();
        }),
    );
    const hasAnimations = !!this.actor?.animations.some(
      (c) => c.modelRevisionId === this.revision,
    );
    this.editor.innerHTML = `
      <section class="action-authoring-section"><label id="action-prompt-label">文本指导</label>
        <div data-prompt class="point-prompt" role="textbox" aria-labelledby="action-prompt-label" aria-multiline="true" contenteditable="true" data-placeholder="拖入动画和标点，例如：从 p1 用行走到 p2，再播放后空翻。输入 @ 引用标点。"></div>
        <p class="lifetime-help">蓝色为标点，紫色为动画。可直接从左侧动画库拖入。</p>
      </section>
      <section class="action-authoring-section"><div class="panel-heading"><h3>地图标点</h3><button data-add-point class="small" aria-label="添加地图标点" ${!this.ready || st.points.length >= 20 ? "disabled" : ""}>＋</button></div>
        <p class="lifetime-help">拖到模型表面或地面定位，拖入文字引用。选中后拖动 ↑ 调高，靠近上表面会吸附；按住 Alt 自由调高。</p>
        <div class="point-list">${st.points.map((p) => `<div class="point-row ${st.selected === p.id ? "selected" : ""}" data-point="${p.id}"><button class="point-token point-drag" draggable="true" data-drag="${p.id}" title="拖入预览放置，或拖入文本引用">${escape(p.name)}</button><label>${p.offsetMode === "normal" ? "离面距离" : "向上高度"}<input type="number" min="0" max="100" step="0.1" data-height="${p.id}" aria-label="${p.name} 偏移距离" value="${p.height}"/></label><button class="small" data-place="${p.id}">${p.ground ? "重新放置" : "放置"}</button><button class="small" data-insert="${p.id}">插入</button><button class="point-delete" data-delete="${p.id}" aria-label="删除 ${p.name}">×</button><small>${p.ground ? (p.surface ? "已吸附模型表面" : "地面 / 空间点") : "未放置 · 拖到预览中"}</small>${p.surface && st.selected === p.id ? `<select data-offset="${p.id}" aria-label="${p.name} 偏移方向"><option value="up" ${p.offsetMode !== "normal" ? "selected" : ""}>向上高度</option><option value="normal" ${p.offsetMode === "normal" ? "selected" : ""}>离面距离</option></select>` : ""}</div>`).join("") || '<p class="empty-state">点击 ＋ 添加 p1，然后拖入预览画面。</p>'}</div>
      </section>
      <div class="toolbar-actions"><button data-generate class="lifetime-primary" ${!hasAnimations || !this.ready || st.busy ? "disabled" : ""}>${st.busy ? "正在生成…" : "生成动作"}</button>${st.busy ? '<button data-cancel class="small">取消</button>' : ""}</div>
      <div data-action-template></div>
      ${!hasAnimations ? '<p class="lifetime-help">先在动画库中生成当前模型可用的动画。</p>' : ""}
      <p class="action-summary" data-summary>${escape(st.dirty ? "文本已修改，请重新生成动作。" : this.summary())}</p>
      ${st.plan ? `<label class="lifetime-field"><span>动作名称</span><input data-action-name aria-label="演员动作名称" value="${escape(st.plan.name)}" maxlength="100"/></label>` : ""}
      ${st.modified ? '<p class="lifetime-help">动作修改尚未保存。重新生成会覆盖这些修改。</p>' : ""}
      <div class="toolbar-actions"><button data-preview class="lifetime-primary" ${!st.plan || st.dirty || !this.ready || st.busy ? "disabled" : ""}>预览</button><button data-save ${!st.plan || st.dirty || st.busy ? "disabled" : ""}>保存动作</button></div>
      <p class="action-error" role="status">${escape(st.error)}</p><p class="lifetime-help" data-execution></p>`;
    this.composer = new PointPrompt(
      select(this.editor, "[data-prompt]"),
      st.document,
      st.points,
      (doc) => {
        st.document = doc;
        st.dirty = !!st.plan;
        select<HTMLButtonElement>(this.editor, "[data-preview]").disabled =
          true;
        select<HTMLButtonElement>(this.editor, "[data-save]").disabled = true;
        select(this.editor, "[data-summary]").textContent = st.dirty
          ? "文本已修改，请重新生成动作。"
          : "";
        this.renderTimeline();
      },
      this.actor?.animations.filter(
        (c) => c.modelRevisionId === this.revision,
      ) ?? [],
      (message) => {
        st.error = message;
        this.notify(message);
        select(this.editor, ".action-error").textContent = message;
      },
    );
    this.editor
      .querySelectorAll<HTMLSelectElement>("[data-offset]")
      .forEach((input) => {
        input.onchange = () =>
          this.run(() => {
            const p = st.points.find((p) => p.id === input.dataset.offset)!;
            const next = {
              ...this.view.resolvePoint(p),
              offsetMode: input.value as "up" | "normal",
            };
            validatePoints([next]);
            Object.assign(p, next);
            this.render();
          });
      });
    this.on("[data-add-point]", () => {
      let n = 1;
      while (st.points.some((p) => p.name === `p${n}`)) n++;
      const p: ActionPoint = {
        id: crypto.randomUUID(),
        name: `p${n}`,
        ground: null,
        height: 0,
      };
      st.points.push(p);
      st.selected = p.id;
      this.render();
      this.scene.arm(p.id);
    });
    this.editor
      .querySelectorAll<HTMLButtonElement>("[data-drag]")
      .forEach((b) => {
        b.ondragstart = (e) => {
          e.dataTransfer?.setData(POINT_MIME, b.dataset.drag!);
          if (e.dataTransfer) e.dataTransfer.effectAllowed = "copyMove";
          this.scene.beginDrag(b.dataset.drag!);
        };
        b.onclick = () => {
          st.selected = b.dataset.drag!;
          this.render();
        };
      });
    this.editor.querySelectorAll<HTMLInputElement>("[data-height]").forEach(
      (input) =>
        (input.onchange = () =>
          this.run(() => {
            const p = st.points.find((p) => p.id === input.dataset.height)!;
            const height = Number(input.value);
            const next = { ...this.view.resolvePoint(p), height };
            validatePoints([next]);
            Object.assign(p, next);
            st.selected = p.id;
            this.render();
          })),
    );
    this.editor
      .querySelectorAll<HTMLButtonElement>("[data-insert]")
      .forEach(
        (b) => (b.onclick = () => this.composer?.insert(b.dataset.insert!)),
      );
    this.editor.querySelectorAll<HTMLButtonElement>("[data-place]").forEach(
      (b) =>
        (b.onclick = () => {
          st.selected = b.dataset.place!;
          this.render();
          this.scene.arm(st.selected);
        }),
    );
    this.editor.querySelectorAll<HTMLButtonElement>("[data-delete]").forEach(
      (b) =>
        (b.onclick = () =>
          this.run(() => {
            const id = b.dataset.delete!;
            if (st.document.some((p) => p.type === "point" && p.pointId === id))
              throw new Error("这个标点仍在文本中使用，请先移除文本中的引用。");
            if (st.plan && JSON.stringify(st.plan).includes(id)) {
              st.plan = null;
              st.dirty = false;
            }
            st.points = st.points.filter((p) => p.id !== id);
            st.error = "";
            this.render();
          })),
    );
    this.on("[data-generate]", () => this.generate());
    if (st.busy) this.on("[data-cancel]", () => this.abort());
    this.on("[data-preview]", () => this.preview());
    this.on("[data-save]", () => this.save());
    const actionName =
      this.editor.querySelector<HTMLInputElement>("[data-action-name]");
    if (actionName)
      actionName.onchange = () =>
        this.run(() => {
          const name = actionName.value.trim();
          if (!name) throw new Error("请填写动作名称");
          st.plan!.name = name;
          st.modified = true;
          this.port.invalidateAction();
          this.render();
        });
    if (hasAnimations && this.ready && !st.busy)
      mountActionTemplatePanel(
        select(this.editor, "[data-action-template]"),
        this.actor!,
        this.revision,
        (kind, move, performances) =>
          this.run(() => {
            const draft = createActionTemplate(
              this.actor!,
              this.revision,
              kind,
              move,
              performances,
              st.points,
            );
            this.abort();
            this.port.invalidateAction();
            this.state = {
              ...empty(),
              ...draft,
              selected: draft.points[0]?.id ?? "",
            };
            this.states.set(this.key, this.state);
            this.render();
          }),
      );
    this.renderTimeline();
    this.status();
  }
  private origin(): MotionOrigin {
    return (this.state.origin ??= this.port.getOrigin());
  }
  private renderTimeline(): void {
    const st = this.state;
    this.playbackDuration = 0;
    this.timeline.show(false);
    if (!this.ready) {
      this.timeline.set(null, null, [], false);
      return;
    }
    let timings: ReturnType<MotionPort["inspectAction"]> = [],
      error = "";
    try {
      if (st.plan) timings = this.port.inspectAction(st.plan, this.origin());
      if (!st.dirty && !st.busy)
        this.playbackDuration = timings.at(-1)?.end ?? 0;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    this.timeline.set(
      st.plan,
      this.ctx(),
      timings,
      (!st.plan || !st.dirty) && !st.busy,
      st.dirty ? "文本已修改，请重新生成后编辑片段。" : error,
    );
  }
  private changeSlot(
    stepId: string | null,
    clipId: string | null,
    layer: number,
  ): void {
    const st = this.state;
    if (!this.ready || st.busy || (st.plan && st.dirty))
      throw new Error("请先完成当前动作生成，再编辑卡槽");
    const ctx = this.ctx();
    const plan: MotionPlan = st.plan ?? {
      schemaVersion: 2,
      name: "自定义动作",
      modelRevisionId: this.revision,
      steps: [],
    };
    let next;
    if (!stepId) {
      if (!clipId) throw new Error("请选择动画");
      next = appendAnimation(
        plan,
        st.document,
        ctx,
        clipId,
        crypto.randomUUID(),
      );
    } else if (!clipId) {
      const duration = this.port
        .inspectAction(plan, this.origin())
        .find((t) => t.stepId === stepId)?.duration;
      if (duration === undefined) throw new Error("卡槽不存在");
      next = clearAnimation(plan, st.document, ctx, stepId, layer, duration);
    } else {
      const clip = this.actor!.animations.find(
        (c) => c.id === clipId && c.modelRevisionId === this.revision,
      );
      if (!clip) throw new Error("请选择当前模型版本的动画");
      const step = plan.steps.find((s) => s.id === stepId);
      if (!step || (step.type !== "moveTo" && step.type !== "playClip"))
        throw new Error("这个指令不支持放入动画");
      const old = layer === -1 ? step.animation : step.layers?.[layer];
      next = editAnimation(plan, st.document, ctx, stepId, layer, {
        clipId,
        rate: old?.rate ?? 1,
        start: 0,
        end: clip.duration,
        repeat: 1,
        ...(step.type === "moveTo"
          ? {
              sync:
                step.sync === "fitClip"
                  ? ("fitClip" as const)
                  : ("independent" as const),
              speed: step.speed,
            }
          : {}),
      });
    }
    this.commitEdit(next);
  }
  private commitEdit(next: { plan: MotionPlan; document: PromptPart[] }): void {
    this.port.validateAction(next.plan, {}, this.origin());
    Object.assign(this.state, {
      plan: next.plan,
      document: next.document,
      modified: true,
      dirty: false,
      error: "",
    });
    this.port.invalidateAction();
    this.render();
  }
  private editSegment(
    stepId: string,
    layer: number,
    edit: AnimationEdit,
  ): void {
    const st = this.state;
    if (!st.plan || !this.ready || st.dirty || st.busy)
      throw new Error("请先完成动作生成，再编辑片段");
    const next = editAnimation(
      st.plan,
      st.document,
      this.ctx(),
      stepId,
      layer,
      edit,
    );
    this.commitEdit(next);
  }
  private preview(): void {
    this.checkDraft();
    this.bind();
    const origin = this.origin();
    const plan = this.port.validateAction(this.state.plan!, {}, origin);
    this.port.executeAction(
      plan,
      this.port.getCapabilities().actorInstanceId,
      {},
      { replace: true, origin },
    );
    this.state.error = "";
    this.status();
  }
  private checkDraft(): void {
    validateDocument(this.state.document, this.state.points, this.ctx());
    if (this.state.plan)
      validateAnimationReferences(
        this.state.document,
        this.state.plan,
        this.ctx(),
      );
    if (this.state.dirty) throw new Error("文本已修改，请重新生成动作");
    if (this.state.points.some((p) => !p.ground))
      throw new Error("请先将所有标点放置到场景");
  }
  private summary(): string {
    const p = this.state.plan;
    if (!p) return "";
    const target = (t: any): string =>
      Array.isArray(t)
        ? "指定位置"
        : t.point
          ? (this.state.points.find((p) => p.id === t.point)?.name ??
            "失效标点")
          : t.context
            ? "动作起点"
            : "目标点";
    const clipName = (use: any) =>
      this.actor?.animations.find((c) => c.id === use?.clipId)?.name ??
      this.ctx().pool?.entries?.find((e) => e.slot === use?.slot)?.slot ??
      use?.slot ??
      "动画";
    return [
      ...(p.start ? [`起点 ${target(p.start)}`] : []),
      ...p.steps.map((s) =>
        s.type === "moveTo"
          ? `${s.animation ? clipName(s.animation) : "移动"}至 ${target(s.destination)}`
          : s.type === "playClip"
            ? s.animation
              ? `${clipName(s.animation)}${s.animation.repeat && s.animation.repeat !== 1 ? ` × ${s.animation.repeat}` : "一次"}`
              : `空卡槽 ${s.seconds?.toFixed(2)} 秒`
            : s.type === "wait"
              ? `等待 ${s.seconds} 秒`
              : "转向",
      ),
    ].join(" → ");
  }
  status(): void {
    const box = this.editor.querySelector("[data-execution]");
    if (!box) return;
    const s = this.port.getExecutionState();
    this.timeline.status(s);
    const names = {
      running: "执行中",
      paused: "已暂停",
      completed: "已完成",
      cancelled: "已停止",
      failed: "执行失败",
    };
    box.textContent = s
      ? `${names[s.status]} · ${s.elapsed.toFixed(1)} / ${s.duration.toFixed(1)} 秒`
      : "";
  }
  private async generate(): Promise<void> {
    const st = this.state;
    validateDocument(st.document, st.points, this.ctx(false));
    if (st.points.some((p) => !p.ground))
      throw new Error("请先将所有标点拖入预览，放置到场景");
    const prompt = promptText(st.document, st.points, this.ctx(false));
    if (!prompt.trim()) throw new Error("请填写文本指导");
    const ctx = structuredClone(
        this.view.resolveMotionContext(this.ctx(false)),
      ),
      origin = this.state.origin ?? this.port.getOrigin(),
      snapshot = this.snapshot(st),
      controller = new AbortController();
    this.abort();
    this.controller = controller;
    st.busy = true;
    st.error = "";
    this.render();
    try {
      const plan = await planMotion(prompt, ctx, {
        signal: controller.signal,
        document: structuredClone(st.document),
      });
      if (controller.signal.aborted || this.state !== st) return;
      if (snapshot !== this.snapshot(st)) {
        st.error = "指导或标点已修改，请重新生成动作。";
        return;
      }
      // Preflight the same movement constraints used by preview before accepting a plan.
      this.port.bind(ctx, `${ctx.actor.id}:${this.revision}`);
      st.origin = origin;
      this.port.validateAction(plan, {}, st.origin);
      st.plan = plan;
      st.dirty = false;
      st.modified = false;
      this.port.invalidateAction();
    } catch (e) {
      st.error = controller.signal.aborted
        ? "已取消生成"
        : e instanceof Error
          ? e.message
          : String(e);
    } finally {
      st.busy = false;
      if (this.controller === controller) this.controller = null;
      if (this.state === st) this.render();
    }
  }
  private async save(): Promise<void> {
    this.checkDraft();
    const st = this.state,
      ctx = this.ctx(),
      plan = this.port.validateAction(st.plan!, {}, this.origin());
    const snapshot = this.snapshot(st);
    st.busy = true;
    this.render();
    try {
      const saved: SavedAction = {
        id: st.actionId || crypto.randomUUID(),
        name: plan.name,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        modelRevisionId: plan.modelRevisionId,
        prompt: promptText(st.document, st.points, this.ctx(false)),
        document: structuredClone(st.document),
        points: structuredClone(this.view.resolveMotionContext(ctx).points),
        plan,
      };
      const result = await resources.saveMotionAction(ctx.actor.id, saved);
      ctx.actor.motionActions = result.motionActions;
      if (snapshot === this.snapshot(st)) {
        st.actionId = saved.id;
        st.modified = false;
      }
      this.notify("动作已保存到动作库");
    } finally {
      st.busy = false;
      if (this.state === st) this.render();
    }
  }
  dispose(): void {
    this.abort();
    this.scene.dispose();
  }
}
