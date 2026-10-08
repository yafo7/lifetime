import {
  resolveClip,
  type MotionContext,
  type MotionPlan,
} from "../../shared/motion";
import type { ActionTiming, ExecutionState } from "../motion/runtime";
import type { AnimationEdit } from "../motion/editing";
import { escape, select } from "../ui";
import { ANIMATION_MIME } from "./pointPrompt";

/** Edits existing steps; does not generate animations or own the playback clock. */
export class ActionTimeline {
  private plan: MotionPlan | null = null;
  private ctx: MotionContext | null = null;
  private timings: ActionTiming[] = [];
  private selected = "";
  private layer = -1;
  private enabled = false;
  private reason = "";
  private visible = false;
  constructor(
    private host: HTMLElement,
    private apply: (stepId: string, layer: number, edit: AnimationEdit) => void,
    private preview: () => void,
    private pause: () => void,
    private slot: (
      stepId: string | null,
      clipId: string | null,
      layer: number,
    ) => void,
  ) {}

  show(value: boolean): void {
    this.visible = value;
    this.host.hidden = !value || !this.ctx;
  }
  set(
    plan: MotionPlan | null,
    ctx: MotionContext | null,
    timings: ActionTiming[],
    enabled: boolean,
    reason = "",
  ): void {
    this.plan = plan;
    this.ctx = ctx;
    this.timings = timings;
    this.enabled = enabled && (!plan || plan.schemaVersion === 2);
    this.reason = reason;
    if (!plan?.steps.some((s) => s.id === this.selected)) {
      this.selected = plan?.steps[0]?.id ?? "";
      this.layer = -1;
    }
    this.show(this.visible);
    this.render();
  }
  private render(): void {
    const plan = this.plan,
      ctx = this.ctx;
    if (!ctx) {
      this.host.replaceChildren();
      return;
    }
    const clips = ctx.actor.animations.filter(
      (c) => c.modelRevisionId === ctx.modelRevisionId,
    );
    const step = plan?.steps.find((s) => s.id === this.selected);
    const animated = step?.type === "moveTo" || step?.type === "playClip";
    if (!animated || !step.layers?.[this.layer]) this.layer = -1;
    const timing = this.timings.find((t) => t.stepId === step?.id);
    const label = (id?: string) =>
      clips.find((c) => c.id === id)?.name ?? "动画";
    const scrollLeft =
      this.host.querySelector(".action-segments")?.scrollLeft ?? 0;
    this.host.innerHTML = `<div class="panel-heading"><h3>动画卡槽</h3><small>${this.timings.length ? "总长 " + this.timings.at(-1)!.end.toFixed(2) + " 秒" : plan ? "待校验" : "拖入动画开始"}</small></div>
      <div class="action-segments" role="group" aria-label="动画卡槽">${(
        plan?.steps ?? []
      )
        .map((s, i) => {
          const t = this.timings.find((t) => t.stepId === s.id);
          const name =
            s.type === "wait"
              ? "等待"
              : s.type === "turnTo"
                ? "转向"
                : s.animation
                  ? label(t?.clipId ?? s.animation.clipId)
                  : "空卡槽";
          const range = t
            ? `${t.start.toFixed(2)}–${t.end.toFixed(2)} 秒`
            : "时长待校验";
          return `<div class="animation-slot" data-drop-slot="${escape(s.id)}"><button class="action-segment ${s.id === this.selected ? "selected" : ""}" data-segment="${escape(s.id)}" aria-pressed="${s.id === this.selected}"><b>${i + 1}. ${escape(name)}</b><small>${range}${t?.rate ? ` · ${t.rate.toFixed(2)}×` : ""}</small><span class="slot-hint">${s.type === "moveTo" ? "移动路线" : s.type === "playClip" ? "原地播放" : "控制指令"}</span></button>${(s.type === "moveTo" || s.type === "playClip") && s.animation ? `<button class="slot-remove" data-remove="${escape(s.id)}" aria-label="移除第 ${i + 1} 个卡槽的动画" ${!this.enabled ? "disabled" : ""}>×</button>` : ""}${(s.type === "moveTo" || s.type === "playClip") && s.animation ? `<label class="slot-rate">速率 <output>${(t?.rate ?? s.animation.rate ?? 1).toFixed(2)}×</output><input type="range" data-slot-rate="${escape(s.id)}" aria-label="第 ${i + 1} 个卡槽播放速率" min="0.25" max="3" step="0.05" value="${t?.rate ?? s.animation.rate ?? 1}" ${!this.enabled ? "disabled" : ""}/></label>` : ""}</div>`;
        })
        .join(
          "",
        )}<div class="animation-slot slot-add" data-drop-slot=""><span>＋ 拖入动画</span><small>添加到末尾</small><select data-append aria-label="添加动画卡槽" ${!this.enabled ? "disabled" : ""}><option value="">或选择动画…</option>${clips.map((c) => `<option value="${escape(c.id)}">${escape(c.name)}</option>`).join("")}</select></div></div>
      <p class="lifetime-help">从动画库拖入卡槽即可使用或替换。× 仅移除动画，保留路线或空槽时长。</p>
      <div data-segment-editor></div><p class="action-error" data-segment-error role="status">${escape(this.reason)}</p>`;
    select(this.host, ".action-segments").scrollLeft = scrollLeft;
    this.host
      .querySelectorAll<HTMLInputElement>("[data-slot-rate]")
      .forEach((input) => {
        input.oninput = () => {
          input.parentElement!.querySelector("output")!.textContent =
            `${Number(input.value).toFixed(2)}×`;
        };
        input.onchange = () => {
          try {
            const source = plan!.steps.find(
              (s) => s.id === input.dataset.slotRate,
            )!;
            if (
              (source.type !== "moveTo" && source.type !== "playClip") ||
              !source.animation
            )
              return;
            const use = resolveClip(source.animation, ctx);
            this.apply(source.id, -1, {
              clipId: use.clip.id,
              rate: Number(input.value),
              start: use.start,
              end: use.end,
              repeat: typeof use.repeat === "number" ? use.repeat : 1,
              ...(source.type === "moveTo"
                ? {
                    sync:
                      source.sync === "fitClip"
                        ? ("fitClip" as const)
                        : ("independent" as const),
                    speed: source.speed,
                  }
                : {}),
            });
            this.host
              .querySelectorAll<HTMLInputElement>("[data-slot-rate]")
              .forEach((next) => {
                if (next.dataset.slotRate === source.id)
                  next.focus({ preventScroll: true });
              });
          } catch (e) {
            input.value = input.defaultValue;
            input.parentElement!.querySelector("output")!.textContent =
              `${Number(input.value).toFixed(2)}×`;
            select(this.host, "[data-segment-error]").textContent =
              e instanceof Error ? e.message : String(e);
          }
        };
      });
    this.host.querySelectorAll<HTMLButtonElement>("[data-segment]").forEach(
      (b) =>
        (b.onclick = () => {
          this.pause();
          this.selected = b.dataset.segment!;
          this.layer = -1;
          this.render();
        }),
    );
    const changeSlot = (
      id: string | null,
      clipId: string | null,
      layer = -1,
    ) => {
      try {
        this.slot(id, clipId, layer);
        this.selected = id ?? this.plan?.steps.at(-1)?.id ?? "";
        this.layer = -1;
        this.render();
      } catch (e) {
        select(this.host, "[data-segment-error]").textContent =
          e instanceof Error ? e.message : String(e);
      }
    };
    this.host
      .querySelectorAll<HTMLElement>("[data-drop-slot]")
      .forEach((target) => {
        const id = target.dataset.dropSlot || null;
        const source = plan?.steps.find((s) => s.id === id);
        const allowed =
          this.enabled &&
          (!id || source?.type === "moveTo" || source?.type === "playClip");
        target.ondragenter = target.ondragover = (e) => {
          if (allowed && e.dataTransfer?.types.includes(ANIMATION_MIME)) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            target.classList.add("drag-over");
          }
        };
        target.ondragleave = (e) => {
          if (!target.contains(e.relatedTarget as Node | null))
            target.classList.remove("drag-over");
        };
        target.ondrop = (e) => {
          target.classList.remove("drag-over");
          if (!allowed) return;
          e.preventDefault();
          try {
            const data = JSON.parse(
              e.dataTransfer?.getData(ANIMATION_MIME) || "null",
            );
            if (
              !clips.some(
                (c) =>
                  c.id === data?.clipId &&
                  c.modelRevisionId === data?.modelRevisionId,
              )
            )
              throw new Error("请拖入当前模型版本的动画");
            changeSlot(id, data.clipId);
          } catch (err) {
            select(this.host, "[data-segment-error]").textContent =
              err instanceof Error ? err.message : "动画引用无效";
          }
        };
      });
    this.host
      .querySelectorAll<HTMLButtonElement>("[data-remove]")
      .forEach((b) => (b.onclick = () => changeSlot(b.dataset.remove!, null)));
    select<HTMLSelectElement>(this.host, "[data-append]").onchange = (e) => {
      const value = (e.target as HTMLSelectElement).value;
      if (value) changeSlot(null, value);
    };
    const box = select(this.host, "[data-segment-editor]");
    if (!step || !plan) return;

    if (!animated) {
      box.textContent =
        step.type === "wait"
          ? `等待 ${step.seconds} 秒，此段没有动画。`
          : "此段仅控制朝向，没有动画。";
      return;
    }
    if (plan.schemaVersion !== 2) {
      box.textContent = "旧版动作请重新生成后编辑片段。";
      return;
    }
    const use = this.layer === -1 ? step.animation : step.layers![this.layer];
    if (!use) {
      box.innerHTML = `<div class="slot-empty">${step.layers?.length ? `<label>动画层<select data-empty-layer aria-label="编辑动画层"><option value="-1">主动画（空）</option>${step.layers.map((_, i) => `<option value="${i}">叠加动画 ${i + 1}</option>`).join("")}</select></label>` : ""}<p>空卡槽 · ${step.type === "moveTo" ? "按原路线和移动速度到达目标点" : `保持静止 ${step.seconds?.toFixed(2)} 秒`}</p><label>放入动画<select data-fill aria-label="空卡槽动画" ${!this.enabled ? "disabled" : ""}><option value="">从动画库拖入，或在这里选择…</option>${clips.map((c) => `<option value="${escape(c.id)}">${escape(c.name)}</option>`).join("")}</select></label></div>`;
      const layerSelect =
        box.querySelector<HTMLSelectElement>("[data-empty-layer]");
      if (layerSelect)
        layerSelect.onchange = () => {
          this.layer = Number(layerSelect.value);
          this.render();
        };
      select<HTMLSelectElement>(box, "[data-fill]").onchange = (e) => {
        const value = (e.target as HTMLSelectElement).value;
        if (value) changeSlot(step.id, value);
      };
      return;
    }
    let resolved;
    try {
      resolved = resolveClip(use, ctx);
    } catch (e) {
      box.textContent = String(e);
      return;
    }
    const moving = step.type === "moveTo" && this.layer === -1;
    box.innerHTML = `<fieldset class="segment-fields" ${!this.enabled ? "disabled" : ""}>
      <legend>第 ${plan.steps.indexOf(step) + 1} 段${timing ? ` · ${timing.start.toFixed(2)}–${timing.end.toFixed(2)} 秒` : ""}</legend>
      ${step.layers?.length ? `<label>动画层<select data-layer aria-label="编辑动画层"><option value="-1">主动画</option>${step.layers.map((_, i) => `<option value="${i}">叠加动画 ${i + 1}</option>`).join("")}</select></label>` : ""}
      <label>动画<select data-animation aria-label="片段动画">${clips.map((c) => `<option value="${escape(c.id)}" ${c.id === resolved.clip.id ? "selected" : ""}>${escape(c.name)} · ${c.duration.toFixed(2)} 秒</option>`).join("")}</select></label>
      ${this.layer >= 0 ? `<label class="rate-slider">播放速率 <output data-rate-value>${resolved.rate.toFixed(2)}×</output><input data-rate aria-label="片段播放倍率" type="range" min="0.25" max="3" step="0.05" value="${resolved.rate}"/><small>0.25× — 3× · 松开滑条即应用</small></label>` : ""}
      ${moving ? `<label>移动方式<select data-sync aria-label="片段移动同步方式"><option value="independent">保持移动速度</option><option value="fitClip">动画结束时到达</option></select></label><label>移动速度（单位/秒）<input data-speed aria-label="片段移动速度" type="number" min="0.01" max="100" step="0.1" value="${step.speed}"/></label>` : `<label>播放次数<input data-repeat aria-label="片段播放次数" type="number" min="1" max="100" step="1" value="${typeof use.repeat === "number" ? use.repeat : 1}"/></label>`}
      <details class="segment-trim"><summary>动画取段</summary><div><label>原动画起点（秒）<input data-start aria-label="片段原动画起点" type="number" min="0" max="${resolved.clip.duration}" step="0.01" value="${resolved.start}"/></label><label>原动画终点（秒）<input data-end aria-label="片段原动画终点" type="number" min="0" max="${resolved.clip.duration}" step="0.01" value="${resolved.end}"/></label></div></details>
      <p class="lifetime-help segment-help" data-sync-help></p>
      <div class="toolbar-actions segment-buttons">${this.layer >= 0 ? `<button data-remove-layer>移除叠加动画</button>` : ""}<button data-apply class="lifetime-primary">应用片段修改</button><button data-preview-segments type="button">应用并从头预览</button></div>
      </fieldset>`;
    const removeLayer = box.querySelector<HTMLButtonElement>(
      "[data-remove-layer]",
    );
    if (removeLayer)
      removeLayer.onclick = () => changeSlot(step.id, null, this.layer);
    const animation = select<HTMLSelectElement>(box, "[data-animation]");
    const sync = box.querySelector<HTMLSelectElement>("[data-sync]");
    if (sync)
      sync.value =
        step.type === "moveTo" && step.sync === "fitClip"
          ? "fitClip"
          : "independent";
    const updateHelp = () => {
      const c = clips.find((c) => c.id === animation.value)!;
      const loop = Boolean((c.animation as { loop?: boolean })?.loop);
      const speed = box.querySelector<HTMLInputElement>("[data-speed]");
      const repeat = box.querySelector<HTMLInputElement>("[data-repeat]");
      if (speed) speed.disabled = sync?.value === "fitClip";
      if (repeat) {
        repeat.disabled = !loop;
        if (!loop) repeat.value = "1";
      }
      select(box, "[data-sync-help]").textContent = moving
        ? sync?.value === "fitClip"
          ? "动画单次结束时到达；调快倍率会缩短此段，并改变实际移动速度。"
          : loop
            ? "动画循环到达目的地。倍率只改变动画快慢；移动速度决定此段时长。"
            : "此动画未声明可循环，仅播放一次；若时长不足，请放慢动画、提高移动速度或选择动画结束时到达。"
        : this.layer === -1
          ? "倍率只作用于这一段。2× 表示双倍播放速度，所需时间减半，后续片段自动顺延。"
          : "只调整这个叠加层的动画，保留节点范围；主动画决定本段总时长，超出部分会截断。";
    };
    updateHelp();
    if (sync) sync.onchange = updateHelp;
    animation.onchange = () => {
      const c = clips.find((c) => c.id === animation.value)!;
      select<HTMLInputElement>(box, "[data-start]").value = "0";
      select<HTMLInputElement>(box, "[data-end]").value = String(c.duration);
      select<HTMLInputElement>(box, "[data-end]").max = String(c.duration);
      select<HTMLInputElement>(box, "[data-start]").max = String(c.duration);
      updateHelp();
    };
    const layer = box.querySelector<HTMLSelectElement>("[data-layer]");
    if (layer) {
      layer.value = String(this.layer);
      layer.onchange = () => {
        this.layer = Number(layer.value);
        this.render();
      };
    }
    const number = (query: string, fallback = 1) => {
      const input = box.querySelector<HTMLInputElement>(query);
      return input ? input.valueAsNumber : fallback;
    };
    const submit = (preview: boolean) => {
      try {
        this.apply(step.id, this.layer, {
          clipId: animation.value,
          // Main-slot rate is already committed by the card slider.
          rate: this.layer === -1 ? resolved.rate : number("[data-rate]"),
          start: number("[data-start]"),
          end: number("[data-end]"),
          repeat: number("[data-repeat]"),
          ...(moving
            ? {
                sync: sync!.value as "independent" | "fitClip",
                speed: number("[data-speed]"),
              }
            : {}),
        });
        if (preview) this.preview();
      } catch (e) {
        select(this.host, "[data-segment-error]").textContent =
          e instanceof Error ? e.message : String(e);
      }
    };
    const rate = box.querySelector<HTMLInputElement>("[data-rate]");
    if (rate) {
      rate.oninput = () => {
        select(box, "[data-rate-value]").textContent =
          `${Number(rate.value).toFixed(2)}×`;
      };
      rate.onchange = () => {
        submit(false);
        this.host
          .querySelector<HTMLInputElement>("[data-rate]")
          ?.focus({ preventScroll: true });
      };
    }
    select<HTMLButtonElement>(box, "[data-apply]").onclick = () =>
      submit(false);
    select<HTMLButtonElement>(box, "[data-preview-segments]").onclick = () =>
      submit(true);
  }
  status(state: ExecutionState | null): void {
    this.host.querySelectorAll<HTMLElement>("[data-segment]").forEach((b) => {
      const t = this.timings.find((t) => t.stepId === b.dataset.segment);
      b.classList.toggle(
        "playing",
        !!state && state.stepId === b.dataset.segment,
      );
      b.style.setProperty(
        "--segment-progress",
        `${state && t ? Math.min(100, Math.max(0, ((state.elapsed - t.start) / t.duration) * 100)) : 0}%`,
      );
    });
  }
}
