import type { ActorInstance } from "../../shared/contracts";
import type { SceneMotionPort } from "../services/sceneMotionPort";
import { escape } from "../ui";

/** Read-only outline: selection inspects a complete behavior without changing playback. */
export class NpcBehaviorPanel {
  private instance: ActorInstance | null = null;
  private stateId: string | null = null;
  private actionId: string | null = null;
  private configuredActionId: string | null = null;
  private pathEditing = false;
  private pathVisible = false;
  private pathStatus = "";
  constructor(
    private host: HTMLElement,
    private port: SceneMotionPort,
    private choose: (actionId: string, stateId: string | null) => void,
    private path: (operation: "toggle" | "save" | "cancel") => void,
  ) {}
  set(instance: ActorInstance | null) {
    if (this.instance?.id !== instance?.id) {
      this.stateId = null;
      this.actionId = null;
      this.configuredActionId = null;
    }
    this.instance = instance;
    const config = instance?.sceneMotion;
    if (this.configuredActionId !== (config?.selectedActionId ?? null)) {
      this.configuredActionId = config?.selectedActionId ?? null;
      this.actionId = this.configuredActionId;
      this.stateId = null;
    }
    if (!config?.actions.some((action) => action.id === this.actionId))
      this.actionId =
        config?.selectedActionId ?? config?.actions[0]?.id ?? null;
    const states = config?.machine?.states ?? [];
    if (!states.some((state) => state.id === this.stateId))
      this.stateId =
        states.find((state) => state.actionId === this.actionId)?.id ?? null;
    const selected = states.find((state) => state.id === this.stateId);
    if (selected) this.actionId = selected.actionId;
    this.render();
  }
  get selectedActionId() {
    return this.actionId;
  }
  setPathEditing(editing: boolean, visible: boolean) {
    this.pathEditing = editing;
    this.pathVisible = visible;
    this.render();
  }
  setPathStatus(status: string) {
    this.pathStatus = status;
    const node = this.host.querySelector<HTMLElement>("[data-path-status]");
    if (node) node.textContent = status;
  }
  private render() {
    const config = this.instance?.sceneMotion;
    this.host.hidden = !this.instance;
    if (!config) {
      this.host.replaceChildren();
      return;
    }
    const machine = config.machine,
      states = machine?.states ?? [];
    const height = states.length * 92 + 16;
    const edges = states
      .map((state, index) => {
        const target = states.findIndex(
          (next) => next.id === state.nextStateId,
        );
        if (target < 0) return "";
        const y = index * 92 + 16,
          end = target * 92 + 16;
        const path =
          target === index
            ? `M 216 ${y + 44} C 247 ${y + 68},247 ${y - 10},216 ${y + 18}`
            : target === index + 1
              ? `M 125 ${y + 64} L 125 ${end - 3}`
              : `M 34 ${y + 32} C 6 ${y + 32},6 ${end + 32},31 ${end + 32}`;
        return `<path data-network-edge="${escape(state.id)}" d="${path}" marker-end="url(#npc-state-arrow)"/>`;
      })
      .join("");
    this.host.innerHTML = `<section class="npc-network-section"><div class="panel-heading"><h3>状态机</h3><button data-path-toggle class="secondary small" ${!config.points.length ? "disabled" : ""} aria-pressed="${this.pathVisible}">${this.pathEditing ? (this.pathVisible ? "隐藏 P 点" : "显示 P 点") : "修改路径"}</button></div>
      ${this.pathEditing ? `<div class="path-edit-controls"><button data-path-save class="lifetime-primary small">保存路径</button><button data-path-cancel class="secondary small">取消</button><p class="lifetime-help">拖动 P 点更新路线，选中途经点按 Delete 删除；共用此点的动作也会更新。起点、终点及朝向目标可拖动调整。</p><p data-path-status class="lifetime-help" role="status">${escape(this.pathStatus)}</p></div>` : ""}
      ${
        states.length
          ? `<div class="npc-state-network" style="height:${height}px"><svg viewBox="0 0 250 ${height}" preserveAspectRatio="none" aria-hidden="true"><defs><marker id="npc-state-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"/></marker></defs>${edges}</svg>
        ${states.map((state, index) => `<button data-network-state="${escape(state.id)}" class="npc-state-node ${state.id === this.stateId ? "selected" : ""}" style="top:${index * 92 + 16}px" aria-pressed="${state.id === this.stateId}" title="${escape(state.name)} → ${escape(states.find((next) => next.id === state.nextStateId)?.name ?? "结束")}"><b>${escape(state.name)}</b><small>${escape(config.actions.find((action) => action.id === state.actionId)?.name ?? "动作缺失")}</small>${state.id === machine!.initialStateId ? '<span class="npc-initial-badge">起始</span>' : ""}</button>`).join("")}</div>`
          : '<p class="empty-state">还没有状态机<br>在右侧为完整动作添加状态。</p>'
      }
      <p data-network-status class="lifetime-help" role="status" hidden></p></section>
      <section class="npc-actions-section"><div class="panel-heading"><h3>动作</h3><span class="muted">${config.actions.length}</span></div><div class="clip-list">${config.actions.map((action) => `<button data-npc-action="${escape(action.id)}" class="clip-item ${action.id === this.actionId ? "active" : ""}" aria-pressed="${action.id === this.actionId}"><b>${escape(action.name)}</b></button>`).join("") || '<p class="empty-state">还没有动作</p>'}</div></section>`;
    this.host.querySelector<HTMLButtonElement>("[data-path-toggle]")!.onclick =
      () => this.path("toggle");
    for (const operation of ["save", "cancel"] as const)
      this.host
        .querySelector<HTMLButtonElement>(`[data-path-${operation}]`)
        ?.addEventListener("click", () => this.path(operation));
    this.host
      .querySelectorAll<HTMLButtonElement>("[data-network-state]")
      .forEach((button) => {
        button.onclick = () => {
          const state = states.find(
            (state) => state.id === button.dataset.networkState,
          )!;
          this.stateId = state.id;
          this.actionId = state.actionId;
          this.render();
          this.choose(state.actionId, state.id);
        };
      });
    this.host
      .querySelectorAll<HTMLButtonElement>("[data-npc-action]")
      .forEach((button) => {
        button.onclick = () => {
          this.actionId = button.dataset.npcAction!;
          this.stateId = null;
          this.render();
          this.choose(this.actionId, null);
        };
      });
    this.status();
  }
  status() {
    const current =
      this.instance && this.port.getMachineState(this.instance.id);
    this.host
      .querySelectorAll<HTMLElement>("[data-network-state]")
      .forEach((node) => {
        node.classList.toggle(
          "current",
          node.dataset.networkState === current?.stateId,
        );
      });
    const label = this.host.querySelector<HTMLElement>("[data-network-status]");
    if (label) {
      const name = this.instance?.sceneMotion?.machine?.states.find(
        (state) => state.id === current?.stateId,
      )?.name;
      label.textContent = current
        ? `${name ?? ""} · ${{ starting: "准备中", running: "执行中", waiting: "等待中", paused: "已暂停", completed: "已完成", stopped: "已停止", failed: "失败" }[current.status]}`
        : "";
      label.hidden = !current;
    }
  }
}
