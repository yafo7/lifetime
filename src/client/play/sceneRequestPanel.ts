import type { GenerationCoordinator } from "../scene/generationCoordinator";
import type { AssetTask } from "../../shared/sceneBuild";
import { escape, select } from "../ui";

export class SceneRequestPanel {
  private mapId: string | null = null;
  private editing = false;
  private recordId = "";
  private openDetails = new Set<string>();
  constructor(
    private host: HTMLElement,
    private coordinator: GenerationCoordinator,
    generate: (request: string, climb: number, retry: boolean) => Promise<void>,
    private notify: (text: string) => void,
    private preview: (task: AssetTask) => Promise<void>,
    private play: (id: string) => Promise<void>,
    private repair: () => Promise<void>,
    private selectBuild: (id: string) => Promise<void>,
  ) {
    host.innerHTML = `<label class="lifetime-field"><span>你希望这里发生什么？</span><textarea data-scene-request aria-label="场景要求" rows="6" placeholder="让穿钢铁侠装甲的鸭子绕池塘跑步，再去桥中央翻三个跟头并返回。"></textarea></label><p class="lifetime-help">自动准备角色与动画，再制作地图中的行为。</p><div class="toolbar-actions"><button data-scene-generate class="lifetime-primary">生成场景</button><button data-scene-cancel class="secondary small" hidden>停止后续任务</button><button data-scene-retry class="secondary small" hidden>继续原构建</button></div><p data-scene-build-status class="lifetime-help" role="status"></p><div data-scene-build-details></div><button data-scene-result class="lifetime-primary" hidden>播放场景</button><details data-generation-navigation hidden><summary>调整新角色通行能力</summary><label class="lifetime-field"><span>允许台阶高度</span><input data-scene-climb aria-label="新角色台阶高度" type="number" min="0" max="5" step=".1" value=".3"/></label></details>`;
    const attempt = (work: () => Promise<unknown>) => {
      void work().catch((e) =>
        notify(e instanceof Error ? e.message : String(e)),
      );
    };
    const run = (retry: boolean) => {
      const climb = select<HTMLInputElement>(
        host,
        "[data-scene-climb]",
      ).valueAsNumber;
      if (!Number.isFinite(climb) || climb < 0 || climb > 5) {
        notify("台阶高度必须在0–5之间");
        return;
      }
      attempt(() =>
        generate(
          select<HTMLTextAreaElement>(host, "[data-scene-request]").value,
          climb,
          retry,
        ),
      );
    };
    select<HTMLButtonElement>(host, "[data-scene-generate]").onclick = () =>
      run(false);
    select<HTMLButtonElement>(host, "[data-scene-retry]").onclick = () =>
      run(true);
    select<HTMLButtonElement>(host, "[data-scene-cancel]").onclick = () =>
      attempt(() => coordinator.cancel());
    select<HTMLButtonElement>(host, "[data-scene-result]").onclick = () =>
      attempt(() => play(coordinator.record!.performanceId!));
    this.render();
  }
  setContext(mapId: string | null, editing = false) {
    this.mapId = mapId;
    this.editing = editing;
    this.render();
  }
  render() {
    const record =
        this.coordinator.record?.mapId === this.mapId
          ? this.coordinator.record
          : null,
      busy = this.coordinator.busy;
    if (record && record.id !== this.recordId) {
      this.recordId = record.id;
      this.openDetails.clear();
      select<HTMLTextAreaElement>(this.host, "[data-scene-request]").value =
        record.request;
      select<HTMLInputElement>(this.host, "[data-scene-climb]").value = String(
        record.climb,
      );
    }
    const button = select<HTMLButtonElement>(
      this.host,
      "[data-scene-generate]",
    );
    button.disabled = !this.mapId || busy;
    button.textContent = busy
      ? "正在构建…"
      : this.editing
        ? "修改场景"
        : "生成场景";
    select<HTMLTextAreaElement>(this.host, "[data-scene-request]").disabled =
      busy;
    select<HTMLElement>(this.host, "[data-scene-cancel]").hidden =
      !record ||
      !["planning", "generating", "assembling"].includes(record.phase);
    const retry = select<HTMLButtonElement>(this.host, "[data-scene-retry]");
    retry.hidden = busy || !record || record.phase === "ready";
    retry.textContent = record?.blueprint ? "继续原构建" : "重新规划";
    select<HTMLElement>(this.host, "[data-scene-result]").hidden =
      record?.phase !== "ready";
    const completed =
      record?.tasks.filter((t) => t.state === "done").length ?? 0;
    select(this.host, "[data-scene-build-status]").textContent = record
      ? record.status +
        (record.tasks.length
          ? ` · 素材 ${completed}/${record.tasks.length}`
          : "")
      : this.mapId
        ? ""
        : "先打开一张地图。";
    select<HTMLElement>(this.host, "[data-generation-navigation]").hidden =
      !record?.error ||
      record.tasks.some((t) =>
        ["failed", "uncertain", "save-failed"].includes(t.state),
      );
    const details = select(this.host, "[data-scene-build-details]");
    details
      .querySelectorAll<HTMLDetailsElement>("[data-task-detail]")
      .forEach((d) => {
        if (d.open) this.openDetails.add(d.dataset.taskDetail!);
        else this.openDetails.delete(d.dataset.taskDetail!);
      });
    details.innerHTML = record?.blueprint
      ? record.blueprint.actors
          .map((role) => {
            const tasks = record.tasks.filter((t) => t.roleKey === role.key);
            return `<section class="generation-role"><h3>${escape(role.name)}</h3>${tasks.map((task) => `<div class="generation-task" data-task-id="${task.id}" data-task-state="${task.state}"><div class="generation-task-line"><b>${task.kind === "model" ? "模型" : escape(task.name)}</b><span class="task-state state-${task.state}">${escape(task.state === "done" ? (task.reused ? "已复用" : "已完成") : task.status)}</span></div><div class="task-controls">${task.state === "done" ? `<button data-preview-task="${task.id}" class="small">${task.kind === "model" ? "查看模型" : "预览动画"}</button>` : ""}${["failed", "uncertain", "save-failed"].includes(task.state) ? `<button data-retry-task="${task.id}" class="small">${task.state === "save-failed" ? "重试保存" : task.state === "uncertain" ? "重新生成此项" : "重试此项"}</button>` : ""}</div><details data-task-detail="${task.id}" ${this.openDetails.has(task.id) ? "open" : ""}><summary>生成描述</summary><p>${escape(task.description)}</p>${task.error ? `<p class="action-error">${escape(task.error)}</p>` : ""}${task.state === "uncertain" ? "<p>后端可能已执行。重新生成会提交一个新请求。</p>" : ""}</details></div>`).join("")}<div class="generation-behaviors"><small>行为动作</small>${role.actions.map((a) => `<p>${escape(a.name)}<span>${record.phase === "ready" ? "已完成" : ["assets-ready", "assembling"].includes(record.phase) ? "等待地图验证" : "等待素材"}</span></p>`).join("")}</div></section>`;
          })
          .join("")
      : "";
    if (record?.phase === "ready")
      details.innerHTML = `<details class="generation-summary" data-task-detail="complete" ${this.openDetails.has("complete") ? "open" : ""}><summary>生成素材 · ${record.tasks.length} 项</summary>${details.innerHTML}</details>`;
    const locations = Object.values(record?.assembly?.roles ?? {}).flatMap(
      (r) => Object.values(r.locations),
    );
    if (locations.length)
      details.insertAdjacentHTML(
        "afterbegin",
        `<p class="lifetime-help">地点 ${locations.filter((l) => l.state === "ready").length}/${locations.length} 已确定${record?.assembly?.state === "needs-repair" ? " · 有待调整项" : ""}</p>`,
      );
    if (
      record?.plan &&
      record.phase !== "ready" &&
      record.tasks.every((t) => t.state === "done")
    ) {
      details.insertAdjacentHTML(
        "beforeend",
        `<button data-open-build-repair class="secondary" ${busy ? "disabled" : ""}>${record.assembly ? "查看并调整空间草稿" : "检查地图并调整"}</button>`,
      );
      select<HTMLButtonElement>(details, "[data-open-build-repair]").onclick =
        () => {
          void this.repair().catch((e) => this.notify(String(e)));
        };
    }
    const history = this.coordinator.history.filter(
      (r) => r.mapId === this.mapId,
    );
    if (history.length) {
      details.insertAdjacentHTML(
        "beforeend",
        `<details class="build-history" data-task-detail="history" ${this.openDetails.has("history") ? "open" : ""}><summary>构建记录 · ${history.length}</summary><select data-build-history aria-label="选择构建记录" ${busy ? "disabled" : ""}>${history.map((r) => `<option value="${r.id}" ${r.id === record?.id ? "selected" : ""}>${escape(r.request.slice(0, 50))} · ${r.phase === "ready" ? "已完成" : r.assembly?.state === "needs-repair" ? "待调整" : r.phase === "failed" ? "未完成" : "进行中"}</option>`).join("")}</select></details>`,
      );
      select<HTMLSelectElement>(details, "[data-build-history]").onchange = (
        e,
      ) => {
        void this.selectBuild((e.target as HTMLSelectElement).value).catch(
          (e) => {
            this.notify(String(e));
            this.render();
          },
        );
      };
    }
    details.querySelectorAll<HTMLButtonElement>("[data-preview-task]").forEach(
      (b) =>
        (b.onclick = () => {
          const task = record!.tasks.find(
            (t) => t.id === b.dataset.previewTask,
          )!;
          void this.preview(task).catch((e) => this.notify(String(e)));
        }),
    );
    details
      .querySelectorAll<HTMLButtonElement>("[data-retry-task]")
      .forEach((b) => {
        b.disabled = busy;
        b.onclick = () => {
          void this.coordinator
            .retryTask(b.dataset.retryTask!)
            .catch((e) => this.notify(String(e)));
        };
      });
  }
}
