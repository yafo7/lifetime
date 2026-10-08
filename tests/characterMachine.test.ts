import { describe, expect, it } from "vitest";
import {
  CharacterMachineRuntime,
  type MachineDriver,
} from "../src/client/motion/characterMachine";
import {
  validateCharacterMachine,
  type CharacterMachine,
} from "../src/shared/characterMachine";

const rules: CharacterMachine = {
  schemaVersion: 1,
  enabled: true,
  initialStateId: "walk",
  states: [
    {
      id: "walk",
      name: "走动",
      actionId: "move",
      repetitions: 2,
      waitSeconds: 1,
      nextStateId: "dance",
    },
    {
      id: "dance",
      name: "跳舞",
      actionId: "pose",
      repetitions: 1,
      waitSeconds: 0,
      nextStateId: null,
    },
  ],
};
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
function setup(definition = rules) {
  let action = "running",
    paused = false;
  const launches: [string, boolean][] = [];
  const driver: MachineDriver = {
    launch: async (id, initial) => {
      launches.push([id, initial]);
      action = "running";
    },
    actionStatus: () => action,
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
    },
    interrupt: () => {},
    changed: () => {},
  };
  const runtime = new CharacterMachineRuntime(definition, driver);
  return {
    runtime,
    driver,
    launches,
    complete: () => {
      action = "completed";
    },
    paused: () => paused,
  };
}
describe("character state machine", () => {
  it("repeats, waits on simulation time, then transitions and ends", async () => {
    const { runtime, launches, complete } = setup();
    await runtime.start();
    complete();
    runtime.advance(0.1);
    await settle();
    expect(launches).toEqual([
      ["move", true],
      ["move", false],
    ]);
    expect(runtime.getState().iteration).toBe(2);
    complete();
    runtime.advance(0.5);
    expect(runtime.getState()).toMatchObject({
      status: "waiting",
      waitRemaining: 1,
    });
    runtime.advance(0.4);
    runtime.pause();
    runtime.advance(5);
    expect(runtime.getState()).toMatchObject({
      status: "paused",
      waitRemaining: 0.6,
    });
    runtime.resume();
    runtime.advance(0.6);
    await settle();
    expect(runtime.getState()).toMatchObject({
      status: "running",
      stateId: "dance",
      iteration: 1,
    });
    expect(launches.at(-1)).toEqual(["pose", false]);
    complete();
    runtime.advance(0.1);
    expect(runtime.getState().status).toBe("completed");
    runtime.advance(100);
    expect(launches).toHaveLength(3);
  });
  it("loops through self transitions without recursive synchronous execution", async () => {
    const rule = structuredClone(rules);
    rule.states[0].nextStateId = "walk";
    rule.states[0].repetitions = 1;
    rule.states[0].waitSeconds = 0;
    const { runtime, launches, complete } = setup(rule);
    await runtime.start();
    complete();
    runtime.advance(100);
    await settle();
    expect(launches).toHaveLength(2);
    expect(runtime.getState().status).toBe("running");
    runtime.pause();
    runtime.advance(100);
    expect(launches).toHaveLength(2);
    runtime.stop();
    runtime.advance(100);
    expect(runtime.getState().status).toBe("stopped");
  });
  it("seeking a waiting action pauses and resumes action completion before waiting again", async () => {
    const { runtime, complete } = setup();
    await runtime.start();
    complete();
    runtime.advance(0.1);
    await settle();
    complete();
    runtime.advance(0.1);
    expect(runtime.getState().status).toBe("waiting");
    runtime.seekAction();
    expect(runtime.getState()).toMatchObject({
      status: "paused",
      waitRemaining: 0,
    });
    runtime.resume();
    expect(runtime.getState().status).toBe("running");
    runtime.advance(0.1);
    expect(runtime.getState()).toMatchObject({
      status: "waiting",
      waitRemaining: 1,
    });
  });
  it("freezes a pending preparation and prevents stale launches after stop or switch", async () => {
    const { runtime, driver, paused } = setup();
    const pending: { resolve: () => void; current: () => boolean }[] = [];
    driver.launch = async (_id, _initial, current) =>
      new Promise<void>((resolve) => pending.push({ resolve, current }));
    const first = runtime.start();
    runtime.pause();
    pending[0].resolve();
    await first;
    expect(runtime.getState().status).toBe("paused");
    expect(paused()).toBe(true);
    runtime.resume();
    expect(runtime.getState().status).toBe("running");
    const old = runtime.start();
    const next = runtime.start("dance", false);
    expect(pending[1].current()).toBe(false);
    pending[1].resolve();
    await old;
    expect(runtime.getState().stateId).toBe("dance");
    runtime.stop();
    expect(pending[2].current()).toBe(false);
    pending[2].resolve();
    await next;
    expect(runtime.getState().status).toBe("stopped");
  });
  it("reports a preparation failure without repeating or advancing to the next state", async () => {
    const { runtime, driver } = setup();
    driver.launch = async () => {
      throw new Error("目标不可达");
    };
    await runtime.start();
    runtime.advance(100);
    expect(runtime.getState()).toMatchObject({
      status: "failed",
      error: "目标不可达",
    });
  });
  it("validates references, versions and bounded settings; allows meaningful cycles", () => {
    const ids = new Set(["move", "pose"]);
    expect(() => validateCharacterMachine(rules, ids)).not.toThrow();
    for (const update of [
      (m: CharacterMachine) => {
        m.initialStateId = "missing";
      },
      (m: CharacterMachine) => {
        m.states[0].actionId = "missing";
      },
      (m: CharacterMachine) => {
        m.states[0].nextStateId = "missing";
      },
      (m: CharacterMachine) => {
        m.states[0].repetitions = 0.5;
      },
      (m: CharacterMachine) => {
        m.states[0].waitSeconds = Infinity;
      },
      (m: CharacterMachine) => {
        m.states.push(m.states[0]);
      },
    ]) {
      const value = structuredClone(rules);
      update(value);
      expect(() => validateCharacterMachine(value, ids)).toThrow();
    }
  });
});
