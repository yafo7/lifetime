import { describe, it, expect, vi } from "vitest";
import {
  SceneBuildCoordinator,
  type SceneBuildRecord,
} from "../src/client/scene/buildCoordinator";
import {
  sceneActor,
  sceneMap,
  scenePlan,
  assemblyFixture,
} from "./sceneFixtures";
import { validateSceneDesign } from "../src/shared/sceneDesign";

function setup() {
  let record: SceneBuildRecord | null = null;
  const actor = structuredClone(sceneActor);
  const api = {
    map: vi.fn(async () => sceneMap),
    actor: vi.fn(async () => actor),
    saveMotionAction: vi.fn(async (_id: string, action: any) => {
      actor.motionActions ??= [];
      actor.motionActions.push({
        ...action,
        updatedAt: 42,
        createdAt: 43,
        prompt: "server projected prompt",
      });
      return actor;
    }),
    savePerformance: vi.fn(async (performance: any) => {
      validateSceneDesign(
        performance.sceneDesign,
        performance,
        [actor],
        sceneMap,
      );
      return performance;
    }),
  };
  const planner = vi.fn(async () => scenePlan());
  const storage = {
    read: () => structuredClone(record),
    write: (r: SceneBuildRecord) => {
      record = structuredClone(r);
    },
  };
  const coordinator = new SceneBuildCoordinator(storage, api as any, planner);
  return { actor, api, planner, storage, coordinator };
}
describe("scene build orchestration", () => {
  it("journals partial saves and resumes after reload without another AI request", async () => {
    const f = await assemblyFixture(),
      s = setup(),
      context = {
        ...f.context,
        geometry: async () => f.geometry,
        current: () => true,
      };
    try {
      s.api.savePerformance.mockRejectedValueOnce(
        new Error("disk unavailable"),
      );
      await expect(s.coordinator.run("patrol", context)).rejects.toThrow(
        "disk unavailable",
      );
      expect(s.coordinator.record?.savedActions).toHaveLength(2);
      const resumed = new SceneBuildCoordinator(
        s.storage,
        s.api as any,
        s.planner,
      );
      const result = await resumed.run("ignored retry text", context, true);
      expect(s.planner).toHaveBeenCalledTimes(1);
      expect(s.api.saveMotionAction).toHaveBeenCalledTimes(2);
      expect(
        result.instances[0].sceneMotion!.actions.every(
          (a) => "actorActionUpdatedAt" in a && a.actorActionUpdatedAt === 42,
        ),
      ).toBe(true);
      expect(result.sceneDesign!.plan.actors[0].instanceId).toBe(
        result.instances[0].id,
      );
      expect(resumed.record?.phase).toBe("ready");
    } finally {
      f.dispose();
    }
  });
  it("does not save when the base changes during planning", async () => {
    const f = await assemblyFixture(),
      s = setup();
    let current = true;
    try {
      s.planner.mockImplementationOnce(async () => {
        current = false;
        return scenePlan();
      });
      await expect(
        s.coordinator.run("patrol", {
          ...f.context,
          geometry: async () => f.geometry,
          current: () => current,
        }),
      ).rejects.toThrow("当前演出已修改");
      expect(s.api.saveMotionAction).not.toHaveBeenCalled();
      expect(s.api.savePerformance).not.toHaveBeenCalled();
    } finally {
      f.dispose();
    }
  });
  it("rejects a map revision change before publishing the performance", async () => {
    const f = await assemblyFixture(),
      s = setup();
    try {
      s.api.map
        .mockResolvedValueOnce(sceneMap)
        .mockResolvedValueOnce({ ...sceneMap, updatedAt: 2 });
      await expect(
        s.coordinator.run("patrol", {
          ...f.context,
          geometry: async () => f.geometry,
          current: () => true,
        }),
      ).rejects.toThrow("地图已更新");
      expect(s.api.savePerformance).not.toHaveBeenCalled();
    } finally {
      f.dispose();
    }
  });
  it("validates supplied plans locally and never calls chat for the build port", async () => {
    const f = await assemblyFixture(),
      s = setup();
    try {
      await s.coordinator.run(
        "external plan",
        { ...f.context, geometry: async () => f.geometry, current: () => true },
        false,
        scenePlan(),
      );
      expect(s.planner).not.toHaveBeenCalled();
      const invalid = structuredClone(
        s.coordinator.record!.result!.performance,
      );
      invalid.sceneDesign!.roles[0].actions.patrol = "fake";
      expect(() =>
        validateSceneDesign(invalid.sceneDesign, invalid, [s.actor], sceneMap),
      ).toThrow("场景动作记录");
    } finally {
      f.dispose();
    }
  });
  it("cancellation stops before local resource writes and does not restart planning", async () => {
    const f = await assemblyFixture(),
      s = setup();
    try {
      s.planner.mockImplementationOnce(async () => {
        s.coordinator.cancel();
        return scenePlan();
      });
      await expect(
        s.coordinator.run("patrol", {
          ...f.context,
          geometry: async () => f.geometry,
          current: () => true,
        }),
      ).rejects.toThrow("取消");
      expect(s.coordinator.record?.phase).toBe("cancelled");
      expect(s.api.saveMotionAction).not.toHaveBeenCalled();
      expect(s.planner).toHaveBeenCalledTimes(1);
    } finally {
      f.dispose();
    }
  });
  it("recovers an action whose successful save response was lost without saving it twice", async () => {
    const f = await assemblyFixture(),
      s = setup(),
      context = {
        ...f.context,
        geometry: async () => f.geometry,
        current: () => true,
      };
    try {
      const original = s.api.saveMotionAction.getMockImplementation()!;
      s.api.saveMotionAction.mockImplementationOnce(async (id, action) => {
        await original(id, action);
        throw new Error("response lost");
      });
      await expect(s.coordinator.run("patrol", context)).rejects.toThrow(
        "response lost",
      );
      expect(s.coordinator.record?.savedActions).toHaveLength(0);
      await s.coordinator.run("patrol", context, true);
      expect(s.api.saveMotionAction).toHaveBeenCalledTimes(2);
      expect(s.actor.motionActions).toHaveLength(2);
      expect(s.planner).toHaveBeenCalledTimes(1);
    } finally {
      f.dispose();
    }
  });
  it("reports storage exhaustion without claiming resumable persistence", async () => {
    const f = await assemblyFixture(),
      s = setup();
    try {
      const coordinator = new SceneBuildCoordinator(
        {
          read: () => null,
          write: () => {
            throw new Error("quota");
          },
        },
        s.api as any,
        s.planner,
      );
      await coordinator.run("patrol", {
        ...f.context,
        geometry: async () => f.geometry,
        current: () => true,
      });
      expect(coordinator.record?.phase).toBe("ready");
      expect(coordinator.record?.warning).toContain("无法保证恢复");
    } finally {
      f.dispose();
    }
  });
});
