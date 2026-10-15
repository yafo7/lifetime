import type {
  AssemblyDraft,
  SceneGenerationRun,
} from "../../shared/sceneBuild";
import type { ActionPoint } from "../../shared/motion";
import { POINT_MIME } from "../actors/scenePoints";
import { escape, select } from "../ui";

const labels = { pending: "待检查", ready: "已通过", "needs-repair": "待调整" };
/** Edits production inputs only. Saving here never publishes a performance. */
export class AssemblyRepairPanel {
  run: SceneGenerationRun | null = null;
  draft: AssemblyDraft | null = null;
  roleKey = "";
  actionKey = "";
  pointId = "";
  visible = true;
  private baseline = "";
  private working = false;
  constructor(
    private host: HTMLElement,
    private rolesHost: HTMLElement,
    private port: {
      changed(): void;
      place(id: string): void;
      save(draft: AssemblyDraft): Promise<AssemblyDraft>;
      check(): Promise<void>;
      publish(): Promise<void>;
      preview(actionKey: string): Promise<void>;
      close(): void;
      discard(): void;
      notify(message: string): void;
    },
  ) {
    host.hidden = true;
    rolesHost.hidden = true;
  }
  get dirty() {
    return !!this.draft && JSON.stringify(this.draft) !== this.baseline;
  }
  get role() {
    return this.draft?.roles[this.roleKey];
  }
  get points() {
    return Object.values(this.role?.locations ?? {}).flatMap((l) => l.points);
  }
  get busy() {
    return this.working;
  }
  open(
    run: SceneGenerationRun,
    baseline: AssemblyDraft | null = run.assembly ?? null,
  ) {
    if (!run.assembly) throw new Error("请先继续本地检查，生成空间草稿");
    this.run = run;
    this.draft = structuredClone(run.assembly);
    this.baseline = JSON.stringify(baseline);
    if (!this.draft.roles[this.roleKey])
      this.roleKey = Object.keys(this.draft.roles)[0] ?? "";
    const actions =
      run.plan?.actors.find((r) => r.key === this.roleKey)?.actions ?? [];
    if (!actions.some((a) => a.key === this.actionKey))
      this.actionKey = actions[0]?.key ?? "";
    if (!this.points.some((p) => p.id === this.pointId))
      this.pointId = this.points[0]?.id ?? "";
    this.host.hidden = this.rolesHost.hidden = false;
    this.render();
    this.port.changed();
  }
  close() {
    this.host.hidden = this.rolesHost.hidden = true;
    this.run = null;
    this.draft = null;
  }
  selectRole(key: string) {
    this.roleKey = key;
    this.actionKey =
      this.run?.plan?.actors.find((r) => r.key === key)?.actions[0]?.key ?? "";
    this.pointId = this.points[0]?.id ?? "";
    this.render();
    this.port.changed();
  }
  choosePoint(id: string) {
    this.pointId = id;
    this.render();
    this.port.changed();
  }
  place(id: string, point: ActionPoint) {
    if (!this.role || !this.draft || this.working) return;
    const location = Object.values(this.role.locations).find((l) =>
      l.points.some((p) => p.id === id),
    );
    if (!location) return;
    location.points[location.points.findIndex((p) => p.id === id)] =
      structuredClone(point);
    location.manual = true;
    location.state = "pending";
    delete location.error;
    const affected = new Set(
      this.run?.plan?.actors
        .find((r) => r.key === this.roleKey)
        ?.actions.filter((a) =>
          a.steps.some(
            (step) =>
              ("target" in step
                ? step.target
                : "route" in step
                  ? step.route
                  : null) === location.intent.key,
          ),
        )
        .map((a) => a.key),
    );
    this.role.issues = this.role.issues.filter(
      (i) =>
        i.locationKey !== location.intent.key &&
        !affected.has(i.actionKey ?? ""),
    );
    for (const [key, action] of Object.entries(this.role.actions)) {
      if (!affected.has(key)) continue;
      action.state = "pending";
      delete action.error;
    }
    this.draft.state = "needs-repair";
    this.pointId = id;
    this.render();
    this.port.changed();
  }
  async save() {
    if (!this.draft) return;
    this.draft = structuredClone(await this.port.save(this.draft));
    this.baseline = JSON.stringify(this.draft);
    this.port.notify("调整已保存到构建草稿");
  }
  private attempt(work: () => Promise<unknown>) {
    if (this.working) return;
    this.working = true;
    this.render();
    void work()
      .catch((e) =>
        this.port.notify(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => {
        this.working = false;
        this.render();
        this.port.changed();
      });
  }
  private render() {
    if (!this.draft || !this.run) return;
    const intended = this.run.plan?.actors.find((r) => r.key === this.roleKey);
    this.rolesHost.innerHTML = `<div class="panel-heading"><h3>构建草稿</h3><button data-close-repair class="small">返回演出</button></div>${this.run.plan?.actors.map((r) => `<button data-repair-role="${escape(r.key)}" class="clip-item ${r.key === this.roleKey ? "active" : ""}"><strong>${escape(r.name)}</strong><small>${this.draft!.roles[r.key]?.issues.length ? "需要调整" : "查看制作结果"}</small></button>`).join("") ?? ""}`;
    this.rolesHost
      .querySelectorAll<HTMLButtonElement>("[data-repair-role]")
      .forEach((b) => {
        b.disabled = this.working;
        b.onclick = () => this.selectRole(b.dataset.repairRole!);
      });
    select<HTMLButtonElement>(this.rolesHost, "[data-close-repair]").onclick =
      () => {
        if (this.working) return;
        if (this.dirty) {
          this.port.notify("请先保存或取消调整");
          return;
        }
        this.port.close();
      };
    this.host.innerHTML = `<div class="panel-heading"><h3>${escape(intended?.name ?? "空间草稿")}</h3><label><input data-repair-visible type="checkbox" ${this.visible ? "checked" : ""}/> 显示标点</label></div><p class="lifetime-help">拖动地图中的标点，或点击下方标点后在表面放置。调整只保存在本次构建。</p>
      <div class="repair-locations">${Object.entries(this.role?.locations ?? {})
        .map(
          ([key, l]) =>
            `<section class="repair-location" data-location-state="${l.state}"><strong>${escape(l.name ?? key)}</strong><small>${labels[l.state]}${l.manual ? " · 手动" : ""}</small><div>${l.points.map((p) => `<button data-repair-point="${p.id}" draggable="true" class="small ${p.id === this.pointId ? "active" : ""}">${escape(p.name)}${p.ground ? "" : " · 待放置"}</button>`).join("")}</div>${l.error ? `<p class="action-error">${escape(l.error.message)}</p>` : ""}${["alongGuide", "surroundingRoute"].includes(l.intent.relation) ? `<button data-repair-add="${escape(key)}" class="small">＋ 路径点</button>` : ""}</section>`,
        )
        .join("")}</div>
      <div class="repair-actions">${intended?.actions.map((a) => `<button data-repair-action="${escape(a.key)}" class="clip-item ${a.key === this.actionKey ? "active" : ""}"><strong>${escape(a.name)}</strong><small>${labels[this.role?.actions[a.key]?.state ?? "pending"]}</small></button>`).join("") ?? ""}</div>
      <p data-repair-route-status class="lifetime-help" role="status"></p>${
        this.role?.issues
          .filter((i) => !i.locationKey)
          .map((i) => `<p class="action-error">${escape(i.message)}</p>`)
          .join("") ?? ""
      }
      <div class="toolbar-actions"><button data-repair-save class="secondary small" ${!this.dirty ? "hidden" : ""}>保存调整</button><button data-repair-undo class="secondary small" ${!this.dirty ? "hidden" : ""}>取消调整</button><button data-repair-check class="secondary">重新检查</button>${this.role?.actions[this.actionKey]?.state === "ready" ? '<button data-repair-preview class="secondary small">预览动作</button>' : ""}<button data-repair-publish class="lifetime-primary" ${this.draft.state !== "ready" || this.dirty ? "hidden" : ""}>完成并发布</button></div>`;
    this.host
      .querySelectorAll<HTMLButtonElement>("button")
      .forEach((b) => (b.disabled = this.working));
    select<HTMLInputElement>(this.host, "[data-repair-visible]").onchange = (
      e,
    ) => {
      this.visible = (e.target as HTMLInputElement).checked;
      this.port.changed();
    };
    this.host
      .querySelectorAll<HTMLButtonElement>("[data-repair-point]")
      .forEach((b) => {
        b.onclick = () => {
          this.choosePoint(b.dataset.repairPoint!);
          this.port.place(b.dataset.repairPoint!);
        };
        b.ondragstart = (e) => {
          e.dataTransfer?.setData(POINT_MIME, b.dataset.repairPoint!);
          this.port.place(b.dataset.repairPoint!);
        };
      });
    this.host
      .querySelectorAll<HTMLButtonElement>("[data-repair-action]")
      .forEach(
        (b) =>
          (b.onclick = () => {
            this.actionKey = b.dataset.repairAction!;
            this.render();
            this.port.changed();
          }),
      );
    this.host.querySelectorAll<HTMLButtonElement>("[data-repair-add]").forEach(
      (b) =>
        (b.onclick = () => {
          if (this.points.length >= 20) {
            this.port.notify("每个角色最多20个地图点");
            return;
          }
          const location = this.role!.locations[b.dataset.repairAdd!];
          const point: ActionPoint = {
            id: crypto.randomUUID(),
            name: `p${this.points.length + 1}`,
            ground: null,
            height: 0,
          };
          location.points.push(point);
          this.place(point.id, point);
          this.port.place(point.id);
        }),
    );
    select<HTMLButtonElement>(this.host, "[data-repair-save]").onclick = () =>
      this.attempt(() => this.save());
    select<HTMLButtonElement>(this.host, "[data-repair-undo]").onclick = () => {
      this.port.discard();
      this.draft = JSON.parse(this.baseline);
      if (!this.draft) {
        this.port.close();
        return;
      }
      this.render();
      this.port.changed();
    };
    select<HTMLButtonElement>(this.host, "[data-repair-check]").onclick = () =>
      this.attempt(async () => {
        if (this.dirty) await this.save();
        await this.port.check();
      });
    select<HTMLButtonElement>(this.host, "[data-repair-publish]").onclick =
      () => this.attempt(() => this.port.publish());
    this.host
      .querySelector<HTMLButtonElement>("[data-repair-preview]")
      ?.addEventListener("click", () =>
        this.attempt(() => this.port.preview(this.actionKey)),
      );
  }
  routeStatus(text: string) {
    const el = this.host.querySelector("[data-repair-route-status]");
    if (el) el.textContent = text;
  }
}
