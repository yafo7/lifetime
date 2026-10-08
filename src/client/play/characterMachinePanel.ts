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
  private busy = false;
  constructor(
    private host: HTMLElement,
    private port: SceneMotionPort,
    private notify: (text: string) => void,
  ) {}
  set(instance: ActorInstance | null) {
    this.instance = instance;
    this.render();
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
  private async run(work: () => Promise<void>) {
    if (this.busy) return;
    this.busy = true;
    this.render();
    try {
      await work();
    } catch (error) {
      this.notify(error instanceof Error ? error.message : String(error));
    } finally {
      this.busy = false;
      this.render();
    }
  }
  private render() {
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
    this.host.innerHTML = `<div class="panel-heading"><h3>角色状态机</h3><button data-state-add class="secondary small" ${!config.actions.length || this.busy ? "disabled" : ""}>＋ 状态</button></div>
      <p class="lifetime-help">每个状态执行一个完整动作；完成后切换到后续状态，从当前位置继续。${config.actions.length ? "" : "请先加入演员动作并绑定地图点。"}</p>
      ${
        machine
          ? `<label class="check"><input data-machine-enabled type="checkbox" ${machine.enabled ? "checked" : ""} />参与演出播放</label>
        <label class="lifetime-field"><span>初始状态</span><select data-machine-initial aria-label="角色初始状态">${stateOptions("选择状态")}</select></label>
        <div class="character-state-list">${machine.states
          .map(
            (
              s,
              index,
            ) => `<div class="character-state-card" data-state-card="${escape(s.id)}">
          <div class="toolbar-actions"><b>${index + 1}</b><input data-state-name aria-label="状态名称 ${index + 1}" value="${escape(s.name)}" maxlength="100"/><button data-state-enter class="secondary small" ${this.busy || !machine.enabled ? "disabled" : ""}>进入</button><button data-state-delete class="secondary small">删除</button></div>
          <label class="lifetime-field"><span>执行动作</span><select data-state-action aria-label="状态动作 ${index + 1}">${actionOptions}</select></label>
          <div class="transform-grid"><label class="lifetime-field"><span>执行次数</span><input data-state-repeat aria-label="状态执行次数 ${index + 1}" type="number" min="1" max="100" step="1" value="${s.repetitions}"/></label><label class="lifetime-field"><span>结束后等待（秒）</span><input data-state-wait aria-label="状态等待秒数 ${index + 1}" type="number" min="0" max="3600" step=".1" value="${s.waitSeconds}"/></label></div>
          <label class="lifetime-field"><span>然后进入</span><select data-state-next aria-label="状态后续 ${index + 1}">${stateOptions("结束并保持站位")}</select></label>
        </div>`,
          )
          .join("")}</div>
        <div class="toolbar-actions"><button data-machine-play ${this.busy || !machine.enabled ? "disabled" : ""}>▶ 播放状态机</button><button data-machine-stop class="secondary small">停止复位</button></div><p data-machine-status class="lifetime-help" role="status"></p>`
          : '<p class="lifetime-help">添加状态后，选择动作和后续状态。后续选择自身即可持续循环。</p>'
      }`;
    select<HTMLButtonElement>(this.host, "[data-state-add]").onclick = () => {
      try {
        this.port.updateConfiguration(this.instance!.id, (i) => {
          const c = i.sceneMotion!,
            id = crypto.randomUUID();
          c.machine ??= {
            schemaVersion: 1,
            enabled: true,
            initialStateId: id,
            states: [],
          };
          c.machine.states.push({
            id,
            name: "状态 " + (c.machine.states.length + 1),
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
        select<HTMLButtonElement>(card, "[data-state-enter]").onclick = () => {
          const instanceId = this.instance!.id;
          void this.run(() => this.port.switchState(instanceId, id));
        };
      });
    select<HTMLButtonElement>(this.host, "[data-machine-play]").onclick =
      () => {
        const id = this.instance!.id,
          state = this.port.getMachineState(id);
        void this.run(async () => {
          if (state?.status === "paused") this.port.resumeExecution(id);
          else if (
            state &&
            ["running", "waiting", "starting"].includes(state.status)
          )
            this.port.pauseExecution(id);
          else await this.port.startStateMachine(id);
        });
      };
    select<HTMLButtonElement>(this.host, "[data-machine-stop]").onclick =
      () => {
        this.port.cancelExecution(this.instance!.id);
        this.status();
      };
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
      : "尚未播放；打开或保存演出不会自动启动。";
    const button = this.host.querySelector<HTMLButtonElement>(
      "[data-machine-play]",
    );
    if (button)
      button.textContent =
        state && ["starting", "running", "waiting"].includes(state.status)
          ? "Ⅱ 暂停状态机"
          : state?.status === "paused"
            ? "▶ 继续状态机"
            : "▶ 播放状态机";
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
