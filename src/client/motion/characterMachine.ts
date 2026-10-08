import type {
  CharacterMachine,
  CharacterState,
} from "../../shared/characterMachine";

export type MachineStatus =
  | "starting"
  | "running"
  | "waiting"
  | "paused"
  | "completed"
  | "stopped"
  | "failed";
export interface CharacterMachineState {
  status: MachineStatus;
  stateId: string;
  actionId: string;
  iteration: number;
  waitRemaining: number;
  error?: string;
}
export interface MachineDriver {
  launch(
    actionId: string,
    initial: boolean,
    current: () => boolean,
  ): Promise<void>;
  actionStatus(): string | undefined;
  pause(): void;
  resume(): void;
  interrupt(): void;
  changed(): void;
}
/** No DOM, geometry, network, or wall-clock timers. Each instance owns its own scheduler. */
export class CharacterMachineRuntime {
  private definition: CharacterMachine;
  private value: CharacterMachineState;
  private revision = 0;
  private phase: "starting" | "running" | "waiting" = "starting";
  constructor(
    definition: CharacterMachine,
    private driver: MachineDriver,
  ) {
    this.definition = structuredClone(definition);
    const state = this.definition.states.find(
      (s) => s.id === definition.initialStateId,
    )!;
    this.value = {
      status: "stopped",
      stateId: state.id,
      actionId: state.actionId,
      iteration: 0,
      waitRemaining: 0,
    };
  }
  getState(): CharacterMachineState {
    return structuredClone(this.value);
  }
  private state(): CharacterState {
    return this.definition.states.find((s) => s.id === this.value.stateId)!;
  }
  async start(stateId = this.definition.initialStateId, initial = true) {
    const state = this.definition.states.find((s) => s.id === stateId);
    if (!state) throw new Error("角色状态不存在");
    this.revision++;
    this.driver.interrupt();
    this.value = {
      status: "starting",
      stateId,
      actionId: state.actionId,
      iteration: 0,
      waitRemaining: 0,
    };
    await this.launch(initial);
  }
  private async launch(initial: boolean) {
    const revision = ++this.revision;
    this.phase = "starting";
    if (this.value.status !== "paused") this.value.status = "starting";
    this.value.iteration++;
    this.driver.changed();
    try {
      await this.driver.launch(
        this.value.actionId,
        initial,
        () => revision === this.revision,
      );
      if (revision !== this.revision) return;
      this.phase = "running";
      if (this.value.status === "paused") this.driver.pause();
      else this.value.status = "running";
      this.driver.changed();
    } catch (error) {
      if (revision !== this.revision) return;
      this.value.status = "failed";
      this.value.error = error instanceof Error ? error.message : String(error);
      this.driver.pause();
      this.driver.changed();
    }
  }
  advance(dt: number) {
    if (!Number.isFinite(dt) || dt < 0) throw new Error("状态机时间增量无效");
    if (this.value.status === "running") {
      const status = this.driver.actionStatus();
      if (status === "completed") {
        const state = this.state();
        if (this.value.iteration < state.repetitions) {
          void this.launch(false);
          return;
        }
        this.phase = "waiting";
        this.value.status = "waiting";
        this.value.waitRemaining = state.waitSeconds;
        // The completing frame belongs to the action; waiting begins on the next frame.
        if (!state.waitSeconds) this.next();
        this.driver.changed();
      } else if (
        status === "failed" ||
        status === "cancelled" ||
        status === undefined
      ) {
        this.value.status = "failed";
        this.value.error = "当前状态的动作已中断";
        this.driver.changed();
      }
    } else if (this.value.status === "waiting") {
      this.value.waitRemaining = Math.max(0, this.value.waitRemaining - dt);
      if (!this.value.waitRemaining) this.next();
      this.driver.changed();
    }
  }
  private next() {
    const next = this.state().nextStateId;
    if (next === null) this.value.status = "completed";
    else void this.start(next, false);
  }
  pause() {
    if (!["starting", "running", "waiting"].includes(this.value.status)) return;
    this.value.status = "paused";
    this.driver.pause();
    this.driver.changed();
  }
  resume() {
    if (this.value.status !== "paused") return;
    this.value.status = this.phase;
    if (this.phase === "running") this.driver.resume();
    this.driver.changed();
  }
  seekAction() {
    if (this.phase === "starting" && this.value.status !== "completed")
      throw new Error("正在准备状态动作，请稍候再拖动进度");
    this.phase = "running";
    this.value.status = "paused";
    this.value.waitRemaining = 0;
    this.driver.pause();
    this.driver.changed();
  }
  stop() {
    this.revision++;
    this.value.status = "stopped";
    this.driver.interrupt();
    this.driver.changed();
  }
}
