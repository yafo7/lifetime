import type {
  Actor,
  AnimationClip,
  ModelRevision,
  Provider,
} from "../../shared/contracts";
import { decodeAnimation } from "../../shared/animation";
import { validateActorModel } from "../rendering/map/shared/actorModel";
import { Viewport } from "../rendering/viewport";
import { resources } from "../services/resources";
import { generateModel, generateAnimation } from "../services/generation";
import { Jobs, message } from "../services/jobs";
import { escape, select, button } from "../ui";

interface Draft {
  modelPrompt: string;
  animationPrompt: string;
  modelProvider: Provider;
  animationProvider: Provider;
  modelMode: string;
  animationMode: "quick" | "pro";
  revisionId: string;
  clipId: string;
}
const emptyDraft = (): Draft => ({
  modelPrompt: "",
  animationPrompt: "",
  modelProvider: "gpt",
  animationProvider: "gpt",
  modelMode: "voxel-pro",
  animationMode: "quick",
  revisionId: "",
  clipId: "",
});
export class ActorsWorkspace {
  private actor: Actor | null = null;
  private drafts = new Map<string, Draft>();
  private draft = emptyDraft();
  private version = 0;
  private view: Viewport;
  private active = false;
  constructor(
    private host: HTMLElement,
    private jobs: Jobs,
    private notify: (text: string) => void,
  ) {
    host.innerHTML = /* HTML */ ` <div class="workspace-head actor-context-bar">
        <div class="actor-context-controls">
          <details class="actor-switcher">
            <summary>
              <strong data-current-actor>选择演员</strong
              ><span> 切换演员 ⌄</span>
            </summary>
            <aside class="lifetime-panel actor-library-panel">
              <div class="panel-heading">
                <h2>演员库</h2>
                <button data-new-actor class="secondary small">
                  ＋ 新建演员
                </button>
              </div>
              <input data-search placeholder="搜索演员" aria-label="搜索演员" />
              <div data-actors class="actor-list"></div>
            </aside>
          </details>
          <select data-revisions aria-label="模型版本"></select
          ><span class="muted">/ 动画</span>
        </div>
        <span class="lifetime-status-pill" data-status>准备就绪</span>
      </div>
      <div class="actors-layout">
        <aside class="lifetime-panel animation-library">
          <div class="panel-heading">
            <h2>动画库</h2>
            <span data-clip-count class="muted">0</span>
          </div>
          <div data-clips class="clip-list"></div>
        </aside>
        <section class="actor-preview-column">
          <div class="actor-preview-card">
            <div class="actor-preview-toolbar">
              <span>模型预览</span
              ><button data-fit class="secondary small">重置视角</button
              ><span class="preview-chip">MODEL PREVIEW · 自由视角</span>
            </div>
            <div class="actor-preview-stage">
              <canvas data-canvas aria-label="演员三维预览"></canvas>
              <div data-placeholder class="preview-placeholder">
                创建演员，然后生成模型
              </div>
            </div>
            <div class="actor-preview-navigation">
              左键旋转 · 右键平移 · 滚轮缩放
            </div>
            <div class="playback-strip">
              <button data-play aria-label="播放动画" disabled>▶ 播放</button
              ><button data-stop>停止</button
              ><input
                data-seek
                type="range"
                min="0"
                max="1"
                step="0.01"
                value="0"
                aria-label="动画进度"
                disabled
              /><span data-time>0.00 / 0.00 秒</span
              ><label class="check"
                ><input data-loop type="checkbox" />循环</label
              >
            </div>
          </div>
        </section>
        <aside class="lifetime-panel actor-controls-panel">
          <div class="panel-heading"><h2>演员制作</h2></div>
          <div class="name-row">
            <input
              data-name
              aria-label="演员名称"
              placeholder="演员名称"
            /><button data-rename class="secondary small">保存名称</button>
          </div>
          <div class="panel-tabs">
            <button data-tab="model" class="active">模型制作</button
            ><button data-tab="animation">动画制作</button>
          </div>
          <div data-pane="model">
            <label class="lifetime-field"
              ><span>模型描述</span
              ><textarea
                data-model-prompt
                rows="5"
                placeholder="例如：一个穿旅行斗篷、背着小包的低多边形旅行者"
              ></textarea>
            </label>
            <div class="field-grid">
              <label class="lifetime-field"
                ><span>Provider</span
                ><select data-model-provider>
                  <option value="gpt">GPT</option>
                  <option value="deepseek">DeepSeek</option>
                </select></label
              ><label class="lifetime-field"
                ><span>生成模式</span
                ><select data-model-mode>
                  ${["voxel-pro", "voxel", "standard", "lite", "curve", "wire", "math"].map((m) => `<option value="${m}">${m.toUpperCase()}</option>`).join("")}
                </select></label
              >
            </div>
            <button data-generate-model class="lifetime-primary">
              生成模型
            </button>
            <p class="lifetime-help">
              生成结果保存为新版本，已有动画继续绑定原模型。
            </p>
          </div>
          <div data-pane="animation" hidden>
            <label class="lifetime-field"
              ><span>动作描述</span
              ><textarea
                data-animation-prompt
                rows="5"
                placeholder="例如：站在原地，抬起右手挥手"
              ></textarea>
            </label>
            <div class="field-grid">
              <label class="lifetime-field"
                ><span>Provider</span
                ><select data-animation-provider>
                  <option value="gpt">GPT</option>
                  <option value="deepseek">DeepSeek</option>
                </select></label
              ><label class="lifetime-field"
                ><span>动画模式</span
                ><select data-animation-mode>
                  <option value="quick">QUICK</option>
                  <option value="pro">PRO</option>
                </select></label
              >
            </div>
            <button data-generate-animation class="lifetime-primary">
              生成动画
            </button>
            <p class="lifetime-help">
              使用当前模型版本。动画时长由后端决定，生成后可直接播放。
            </p>
          </div>
          <div class="actor-task-detail" data-jobs aria-live="polite"></div>
        </aside>
      </div>`;
    this.view = new Viewport(select(host, "[data-canvas]"));
    this.view.onPlayback = (time, duration, playing) => {
      const slider = select<HTMLInputElement>(host, "[data-seek]");
      slider.max = String(duration || 1);
      slider.value = String(time);
      slider.disabled = !duration;
      select(host, "[data-time]").textContent =
        `${time.toFixed(2)} / ${duration.toFixed(2)} 秒`;
      const play = select<HTMLButtonElement>(host, "[data-play]");
      play.disabled = !duration;
      play.textContent = playing ? "Ⅱ 暂停" : "▶ 播放";
      play.setAttribute("aria-label", playing ? "暂停动画" : "播放动画");
    };
    const on = (query: string, callback: () => void | Promise<void>) =>
      button(host, query, callback, (e) => this.fail(e));
    on("[data-new-actor]", async () => {
      const actor = await resources.createActor("未命名演员");
      await this.loadLibrary();
      await this.chooseActor(actor.id);
    });
    on("[data-rename]", async () => {
      if (!this.actor) return;
      this.actor = await resources.renameActor(
        this.actor.id,
        select<HTMLInputElement>(host, "[data-name]").value,
      );
      await this.loadLibrary();
      select(host, "[data-current-actor]").textContent = this.actor.name;
      this.notify("演员名称已保存");
    });
    on("[data-fit]", () => this.view.fit());
    on("[data-play]", () => this.view.toggle());
    on("[data-stop]", () => this.view.stop());
    on("[data-generate-model]", () => this.generate("model"));
    on("[data-generate-animation]", () => this.generate("animation"));
    select<HTMLInputElement>(host, "[data-seek]").oninput = (e) =>
      this.view.seek(Number((e.target as HTMLInputElement).value));
    select<HTMLInputElement>(host, "[data-loop]").onchange = (e) =>
      this.view.setLoop((e.target as HTMLInputElement).checked);
    select<HTMLSelectElement>(host, "[data-revisions]").onchange = () => {
      this.capture();
      this.draft.clipId = "";
      void this.showModel().catch((e) => this.fail(e));
    };
    host.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach(
      (b) =>
        (b.onclick = () => {
          host
            .querySelectorAll<HTMLElement>("[data-pane]")
            .forEach((p) => (p.hidden = p.dataset.pane !== b.dataset.tab));
          host
            .querySelectorAll("[data-tab]")
            .forEach((t) => t.classList.toggle("active", t === b));
        }),
    );
    select<HTMLInputElement>(host, "[data-search]").oninput = () => {
      const term = select<HTMLInputElement>(
        host,
        "[data-search]",
      ).value.toLowerCase();
      host
        .querySelectorAll<HTMLElement>("[data-actor-id]")
        .forEach(
          (b) => (b.hidden = !b.textContent!.toLowerCase().includes(term)),
        );
    };
    this.renderRevisions();
    this.renderClips();
    this.renderJobs();
  }
  async start(): Promise<void> {
    const actors = await this.loadLibrary();
    if (actors[0]) await this.chooseActor(actors[0].id);
  }
  private fail(e: unknown): void {
    this.notify(message(e));
    select(this.host, "[data-status]").textContent = message(e);
  }
  private async loadLibrary() {
    const list = await resources.list("actors");
    select(this.host, "[data-actors]").innerHTML = list.length
      ? list
          .map(
            (a) =>
              `<button class="actor-list-item" data-actor-id="${escape(a.id)}"><span class="actor-thumb">A</span><b>${escape(a.name)}</b><span>›</span></button>`,
          )
          .join("")
      : '<p class="empty-state">暂无演员，点击新建开始</p>';
    this.host
      .querySelectorAll<HTMLButtonElement>("[data-actor-id]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            void this.chooseActor(b.dataset.actorId!).catch((e) =>
              this.fail(e),
            )),
      );
    return list;
  }
  private capture(): void {
    for (const [key, selector] of Object.entries({
      modelPrompt: "model-prompt",
      animationPrompt: "animation-prompt",
      modelProvider: "model-provider",
      animationProvider: "animation-provider",
      modelMode: "model-mode",
      animationMode: "animation-mode",
      revisionId: "revisions",
    }))
      (this.draft as unknown as Record<string, string>)[key] =
        select<HTMLInputElement>(this.host, `[data-${selector}]`).value;
    if (this.actor) this.drafts.set(this.actor.id, this.draft);
  }
  private async chooseActor(id: string): Promise<void> {
    this.capture();
    const version = ++this.version;
    this.view.clear();
    const actor = await resources.actor(id);
    if (version !== this.version) return;
    this.actor = actor;
    this.draft = this.drafts.get(id) ?? emptyDraft();
    this.drafts.set(id, this.draft);
    select(this.host, "[data-current-actor]").textContent = actor.name;
    select<HTMLInputElement>(this.host, "[data-name]").value = actor.name;
    for (const [key, selector] of Object.entries({
      modelPrompt: "model-prompt",
      animationPrompt: "animation-prompt",
      modelProvider: "model-provider",
      animationProvider: "animation-provider",
      modelMode: "model-mode",
      animationMode: "animation-mode",
    }))
      select<HTMLInputElement>(this.host, `[data-${selector}]`).value = (
        this.draft as unknown as Record<string, string>
      )[key];
    select<HTMLDetailsElement>(this.host, ".actor-switcher").open = false;
    this.renderRevisions();
    await this.showModel();
    this.renderJobs();
  }
  private renderRevisions(): void {
    const revisions = this.actor?.modelRevisions ?? [];
    if (!revisions.some((r) => r.id === this.draft.revisionId))
      this.draft.revisionId = revisions.at(-1)?.id ?? "";
    const menu = select<HTMLSelectElement>(this.host, "[data-revisions]");
    menu.innerHTML = revisions.length
      ? revisions
          .map(
            (r, i) =>
              `<option value="${escape(r.id)}">版本 ${i + 1} · ${escape(r.mode.toUpperCase())}</option>`,
          )
          .join("")
      : '<option value="">尚无模型</option>';
    menu.value = this.draft.revisionId;
  }
  private async showModel(): Promise<void> {
    const model = this.actor?.modelRevisions.find(
      (r) => r.id === this.draft.revisionId,
    );
    const version = ++this.version;
    this.view.clear();
    select<HTMLElement>(this.host, "[data-placeholder]").hidden =
      Boolean(model);
    this.renderClips();
    this.renderJobs();
    if (!model) return;
    await this.view.model(model.modelJson);
    if (version !== this.version) return;
    this.chooseClip(this.draft.clipId, false);
  }
  private renderClips(): void {
    const clips =
      this.actor?.animations.filter(
        (c) => c.modelRevisionId === this.draft.revisionId,
      ) ?? [];
    select(this.host, "[data-clip-count]").textContent = String(clips.length);
    select(this.host, "[data-clips]").innerHTML = clips.length
      ? clips
          .map(
            (c) =>
              `<button class="clip-item ${c.id === this.draft.clipId ? "active" : ""}" data-clip-id="${escape(c.id)}"><b>${escape(c.name)}</b><small>${c.duration.toFixed(2)} 秒 · ${escape(c.mode.toUpperCase())}</small></button>`,
          )
          .join("")
      : '<p class="empty-state">还没有动画。选择模型后，描述你想要的动作。</p>';
    this.host
      .querySelectorAll<HTMLButtonElement>("[data-clip-id]")
      .forEach(
        (b) =>
          (b.onclick = () => this.chooseClip(b.dataset.clipId!, true, true)),
      );
  }
  private chooseClip(id: string, play: boolean, userChoice = false): void {
    if (userChoice) ++this.version;
    const clip =
      this.actor?.animations.find(
        (c) => c.id === id && c.modelRevisionId === this.draft.revisionId,
      ) ?? null;
    this.draft.clipId = clip?.id ?? "";
    this.view.setClip(clip);
    select<HTMLInputElement>(this.host, "[data-loop]").checked = Boolean(
      (clip?.animation as { loop?: boolean })?.loop,
    );
    if (play && this.active) this.view.toggle();
    this.renderClips();
  }
  private async generate(kind: "model" | "animation"): Promise<void> {
    this.capture();
    if (!this.actor) throw new Error("请先创建演员");
    const actorId = this.actor.id,
      draft = { ...this.draft },
      model = this.actor.modelRevisions.find((r) => r.id === draft.revisionId),
      selectedVersion = this.version;
    const prompt = (
      kind === "model" ? draft.modelPrompt : draft.animationPrompt
    ).trim();
    if (!prompt) throw new Error("请填写生成描述");
    if (kind === "animation" && !model)
      throw new Error("请先生成并选择模型版本");
    if (
      this.jobs.items.some(
        (j) =>
          j.actorId === actorId &&
          (j.state === "running" || j.state === "saving"),
      )
    )
      throw new Error("该演员已有进行中的任务");
    await this.jobs.run(
      actorId,
      `${this.actor.name} · ${kind === "model" ? "模型" : "动画"}`,
      async (signal, onStage) => {
        if (kind === "model") {
          const result = await generateModel(
            prompt,
            draft.modelProvider,
            draft.modelMode,
            { signal, onStage },
          );
          validateActorModel(result.modelJson);
          return {
            id: crypto.randomUUID(),
            createdAt: Date.now(),
            prompt,
            provider: draft.modelProvider,
            mode: draft.modelMode,
            modelJson: result.modelJson,
            metadata: result,
          } as ModelRevision;
        }
        const result = await generateAnimation(
          model!.modelJson,
          prompt,
          draft.animationProvider,
          draft.animationMode,
          { signal },
        );
        return {
          id: crypto.randomUUID(),
          createdAt: Date.now(),
          name: prompt.slice(0, 40),
          prompt,
          provider: draft.animationProvider,
          mode: draft.animationMode,
          modelRevisionId: model!.id,
          ...decodeAnimation(result, model!.modelJson),
          metadata: result,
        } as AnimationClip;
      },
      async (value) => {
        const actor =
          kind === "model"
            ? await resources.model(actorId, value as ModelRevision)
            : await resources.clip(actorId, value as AnimationClip);
        try {
          if (this.actor?.id === actorId) {
            this.actor = actor;
            if (this.version === selectedVersion) {
              if (kind === "model") {
                this.draft.revisionId = value.id;
                this.draft.clipId = "";
                this.renderRevisions();
                await this.showModel();
              } else {
                this.renderClips();
                this.chooseClip(value.id, true);
              }
            } else {
              this.renderRevisions();
              this.renderClips();
            }
          }
          await this.loadLibrary();
          this.notify(`${kind === "model" ? "模型" : "动画"}已保存到对应演员`);
        } catch (error) {
          this.fail(`资源已保存，预览刷新失败：${message(error)}`);
        }
      },
    );
  }
  renderJobs(): void {
    const jobs = this.jobs.items
      .filter((j) => j.actorId === this.actor?.id)
      .slice(-4);
    select(this.host, "[data-jobs]").innerHTML = jobs
      .map(
        (j) =>
          `<div class="job"><b>${escape(j.label)}</b><span>${escape(j.status)}${j.state === "running" ? ` · ${Math.floor((Date.now() - j.startedAt) / 1000)} 秒` : ""}</span>${j.state === "running" ? `<button data-cancel-job="${j.id}" class="secondary small">停止等待</button>` : ""}${j.state === "save-failed" ? `<button data-retry-job="${j.id}" class="secondary small">重试保存</button>` : ""}</div>`,
      )
      .join("");
    this.host
      .querySelectorAll<HTMLButtonElement>("[data-cancel-job]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            this.jobs.items
              .find((j) => j.id === b.dataset.cancelJob)
              ?.controller.abort()),
      );
    this.host
      .querySelectorAll<HTMLButtonElement>("[data-retry-job]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            void this.jobs.items
              .find((j) => j.id === b.dataset.retryJob)
              ?.retry?.()),
      );
    const busy = jobs.some(
      (j) => j.state === "running" || j.state === "saving",
    );
    select<HTMLButtonElement>(this.host, "[data-generate-model]").disabled =
      !this.actor || busy;
    select<HTMLButtonElement>(this.host, "[data-generate-animation]").disabled =
      !this.actor || !this.draft.revisionId || busy;
  }
  setActive(active: boolean): void {
    this.active = active;
    this.view.setActive(active);
  }
  dispose(): void {
    this.view.dispose();
  }
}
