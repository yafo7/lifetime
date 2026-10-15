import type { ActorInstance } from "../../shared/contracts";
import type { CharacterMachine } from "../../shared/characterMachine";
import type { SceneMotionPort } from "../services/sceneMotionPort";
import { escape, select } from "../ui";

const labels = {
  starting: "准备动作",
  running: "执行中",
  waiting: "等待中",
  paused: "已暂停",
  completed: "已完成",
  stopped: "已停止",
  failed: "执行失败",
};
/** State relationships refer to complete actor actions through map bindings. */
export class CharacterMachinePanel {
  private instance: ActorInstance | null = null;
  private expanded = new Set<string>();
  private optionsOpen = false;
  constructor(
    private host: HTMLElement,
    private port: SceneMotionPort,
    private notify: (text: string) => void,
  ) {}
  set(instance: ActorInstance | null) {
    if (this.instance?.id !== instance?.id) {
      this.expanded.clear();
      this.optionsOpen = false;
      this.host.replaceChildren();
    }
    this.instance = instance;
    this.render();
  }
  selectState(id: string | null) {
    if (
      id &&
      !this.instance?.sceneMotion?.machine?.states.some(
        (state) => state.id === id,
      )
    )
      return;
    this.expanded.clear();
    if (id) this.expanded.add(id);
    this.render(false);
  }
  private edit(update: (machine: CharacterMachine) => void) {
    if (!this.instance) return;
    try {
      this.port.updateConfiguration(this.instance.id, (i) =>
        update(i.sceneMotion!.machine!),
      );
    } catch (error) {
      this.notify(error instanceof Error ? error.message : String(error));
      this.render();
    }
  }
  private render(readExpansion = true) {
    if (readExpansion)
      this.host
        .querySelectorAll<HTMLDetailsElement>("[data-state-card]")
        .forEach((card) => {
          if (card.open) this.expanded.add(card.dataset.stateCard!);
          else this.expanded.delete(card.dataset.stateCard!);
        });
    const options = this.host.querySelector<HTMLDetailsElement>(
      "[data-machine-options]",
    );
    if (options) this.optionsOpen = options.open;
    const config = this.instance?.sceneMotion;
    this.host.hidden = !config;
    if (!config) {
      this.host.replaceChildren();
      return;
    }
    const machine = config.machine;
    const stateOptions = (empty: string) =>
      `<option value="">${empty}</option>` +
      (machine?.states ?? [])
        .map(
          (s) => `<option value="${escape(s.id)}">${escape(s.name)}</option>`,
        )
        .join("");
    const actionOptions = config.actions
      .map((a) => `<option value="${escape(a.id)}">${escape(a.name)}</option>`)
      .join("");
    this.host.innerHTML = `<div class="panel-heading"><h3>行为循环</h3><button data-state-add aria-label="添加行为" class="secondary small" ${!config.actions.length ? "disabled" : ""}>＋</button></div>
      ${
        machine
          ? `<div class="character-state-list">${machine.states
              .map(
                (
                  state,
                  index,
                ) => `<details class="character-state-card" data-state-card="${escape(state.id)}" ${this.expanded.has(state.id) ? "open" : ""}>
        <summary><b>${escape(state.name)}</b><span>执行 ${state.repetitions} 次${state.waitSeconds ? ` · 等待 ${state.waitSeconds} 秒` : ""}</span><small>→ ${escape(machine.states.find((s) => s.id === state.nextStateId)?.name ?? "结束")}</small></summary>
        <div class="state-editor"><label class="lifetime-field"><span>行为名称</span><input data-state-name aria-label="状态名称 ${index + 1}" value="${escape(state.name)}" maxlength="100"/></label>
        <label class="lifetime-field"><span>完整动作</span><select data-state-action aria-label="状态动作 ${index + 1}">${actionOptions}</select></label>
        <div class="transform-grid"><label class="lifetime-field"><span>执行次数</span><input data-state-repeat aria-label="状态执行次数 ${index + 1}" type="number" min="1" max="100" value="${state.repetitions}"/></label><label class="lifetime-field"><span>等待（秒）</span><input data-state-wait aria-label="状态等待秒数 ${index + 1}" type="number" min="0" max="3600" step=".1" value="${state.waitSeconds}"/></label></div>
        <label class="lifetime-field"><span>然后执行</span><select data-state-next aria-label="状态后续 ${index + 1}">${stateOptions("结束")}</select></label><button data-state-delete class="secondary small">删除行为</button></div>
      </details>`,
              )
              .join("")}</div>
      <details data-machine-options ${this.optionsOpen ? "open" : ""}><summary>起始行为</summary><label class="lifetime-field"><span>先执行</span><select data-machine-initial aria-label="角色初始状态">${stateOptions("选择行为")}</select></label><label class="check"><input data-machine-enabled type="checkbox" ${machine.enabled ? "checked" : ""}/>参与场景播放</label></details><p data-machine-status class="lifetime-help" role="status" hidden></p>`
          : "<p class='lifetime-help'>先添加完整动作，再创建行为。</p>"
      }`;
    select<HTMLButtonElement>(this.host, "[data-state-add]").onclick = () => {
      try {
        this.port.updateConfiguration(this.instance!.id, (i) => {
          const c = i.sceneMotion!,
            id = crypto.randomUUID();
          this.expanded.add(id);
          c.machine ??= {
            schemaVersion: 1,
            enabled: true,
            initialStateId: id,
            states: [],
          };
          c.machine.states.push({
            id,
            name: "行为 " + (c.machine.states.length + 1),
            actionId: c.selectedActionId ?? c.actions[0].id,
            repetitions: 1,
            waitSeconds: 0,
            nextStateId: null,
          });
        });
      } catch (error) {
        this.notify(String(error));
      }
    };
    if (!machine) return;
    select<HTMLDetailsElement>(this.host, "[data-machine-options]").ontoggle = (
      e,
    ) => {
      this.optionsOpen = (e.target as HTMLDetailsElement).open;
    };
    const initial = select<HTMLSelectElement>(
      this.host,
      "[data-machine-initial]",
    );
    initial.value = machine.initialStateId;
    initial.onchange = () =>
      this.edit((m) => {
        m.initialStateId = initial.value;
      });
    const enabled = select<HTMLInputElement>(
      this.host,
      "[data-machine-enabled]",
    );
    enabled.onchange = () =>
      this.edit((m) => {
        m.enabled = enabled.checked;
      });
    this.host
      .querySelectorAll<HTMLElement>("[data-state-card]")
      .forEach((card) => {
        (card as HTMLDetailsElement).ontoggle = () => {
          if (!card.isConnected) return;
          if ((card as HTMLDetailsElement).open)
            this.expanded.add(card.dataset.stateCard!);
          else this.expanded.delete(card.dataset.stateCard!);
        };
        const id = card.dataset.stateCard!,
          s = machine.states.find((s) => s.id === id)!;
        const bind = (
          selector: string,
          field:
            "name" | "actionId" | "repetitions" | "waitSeconds" | "nextStateId",
          value: string,
        ) => {
          const input = select<HTMLInputElement | HTMLSelectElement>(
            card,
            selector,
          );
          input.value = value;
          input.onchange = () =>
            this.edit((m) => {
              const target = m.states.find((s) => s.id === id)!;
              if (field === "repetitions" || field === "waitSeconds")
                target[field] = Number(input.value);
              else if (field === "nextStateId")
                target.nextStateId = input.value || null;
              else target[field] = input.value.trim();
            });
        };
        bind("[data-state-name]", "name", s.name);
        bind("[data-state-action]", "actionId", s.actionId);
        bind("[data-state-repeat]", "repetitions", String(s.repetitions));
        bind("[data-state-wait]", "waitSeconds", String(s.waitSeconds));
        bind("[data-state-next]", "nextStateId", s.nextStateId ?? "");
        select<HTMLButtonElement>(card, "[data-state-delete]").onclick = () => {
          try {
            this.port.updateConfiguration(this.instance!.id, (i) => {
              const m = i.sceneMotion!.machine!;
              m.states = m.states.filter((s) => s.id !== id);
              if (!m.states.length) {
                delete i.sceneMotion!.machine;
                return;
              }
              if (m.initialStateId === id) m.initialStateId = m.states[0].id;
              for (const s of m.states)
                if (s.nextStateId === id) s.nextStateId = null;
            });
          } catch (error) {
            this.notify(String(error));
          }
        };
      });
    this.status();
  }
  status() {
    if (!this.instance) return;
    const state = this.port.getMachineState(this.instance.id),
      node = this.host.querySelector<HTMLElement>("[data-machine-status]");
    if (!node) return;
    const name = this.instance.sceneMotion?.machine?.states.find(
      (s) => s.id === state?.stateId,
    )?.name;
    node.textContent = state
      ? `${labels[state.status]} · ${name} · 第 ${state.iteration} 次${state.status === "waiting" ? ` · 剩余 ${state.waitRemaining.toFixed(1)} 秒` : ""}${state.error ? `：${state.error}` : ""}`
      : "";
    node.hidden = !state;
    this.host
      .querySelectorAll<HTMLElement>("[data-state-card]")
      .forEach((card) =>
        card.classList.toggle(
          "current",
          card.dataset.stateCard === state?.stateId,
        ),
      );
  }
}
