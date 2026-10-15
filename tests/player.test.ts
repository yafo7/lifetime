import { describe, it, expect } from "vitest";
import { PlayerMotion } from "../src/client/play/playerMotion";
import { playerAssets } from "../src/client/play/playerAssets";
import type { Actor } from "../src/shared/contracts";
import { clip, revision } from "./fixtures";
import { Navigation } from "../src/client/navigation/navigation";

const flat = {
  move: (_a: [number, number, number], b: [number, number, number]) =>
    [...b] as [number, number, number],
};
describe("third person character", () => {
  it("normalizes diagonals and supports movement while jumping, with one landing", () => {
    const p = new PlayerMotion(flat, [0, 0, 0]);
    for (let i = 0; i < 60; i++) p.update(1 / 60, 1, 1);
    expect(Math.hypot(p.frame.position[0], p.frame.position[2])).toBeCloseTo(4);
    p.jump();
    let highest = 0;
    for (let i = 0; i < 90; i++) {
      const f = p.update(1 / 60, 0, 1);
      highest = Math.max(highest, f.position[1]);
      if (i < 20) p.jump(); // Repeated commands while airborne never create a second jump.
    }
    expect(highest).toBeCloseTo(1.35, 2);
    expect(p.frame.airborne).toBe(false);
    expect(p.frame.position[1]).toBe(0);
    expect(p.frame.position[2]).toBeGreaterThan(8);
    p.update(1 / 60, 0, 0);
    expect(p.frame.moving).toBe(false);
  });
  it("ceiling collision stops ascent, lands, and cleared input cancels pending jump", () => {
    const p = new PlayerMotion(flat, [0, 0, 0], 0, 1.1, () => 0.25);
    p.jump();
    p.clearInput();
    p.update(0.05, 0, 0);
    expect(p.frame.airborne).toBe(false);
    p.jump();
    for (let i = 0; i < 90; i++) {
      const f = p.update(1 / 60, 0, 0);
      expect(f.position[1]).toBeLessThanOrEqual(0.25);
      expect(f.position[1]).toBeGreaterThanOrEqual(0);
    }
    expect(p.frame.airborne).toBe(false);
  });
  it("uses only clips from the same model, preserves library resources and rejects incomplete rigs", () => {
    const actor: Actor = {
      id: "iron",
      name: "红金钢铁侠装甲鸭",
      updatedAt: 1,
      modelRevisions: [revision, { ...revision, id: "new", createdAt: 2 }],
      animations: [
        { ...clip, name: "原地奔跑循环" },
        { ...clip, id: "jump", name: "玩家·跳跃" },
        {
          ...clip,
          id: "wrong",
          name: "玩家·跳跃",
          modelRevisionId: "other",
          createdAt: 9,
        },
      ],
    };
    const before = JSON.stringify(actor);
    const assets = playerAssets([actor]);
    expect(assets.model.id).toBe(revision.id);
    expect(assets.jump.id).toBe("jump");
    expect(JSON.stringify(actor)).toBe(before);
    expect(() =>
      playerAssets([
        {
          ...actor,
          animations: actor.animations.filter((c) => c.id !== "jump"),
        },
      ]),
    ).toThrow("同一模型版本");
  });
  it("real NavMesh movement stops at disconnected boundaries, slides along edges and keeps surface height", async () => {
    const nav = new Navigation({
      radius: 0.3,
      height: 1.8,
      climb: 0.3,
      slope: 35,
    });
    // Two floors separated by a narrow gap: proximity must never teleport between them.
    const positions = new Float32Array([
      -5, 0, -5, 0, 0, -5, 0, 0, 5, -5, 0, 5, 0.5, 0, -5, 5, 0, -5, 5, 0, 5,
      0.5, 0, 5,
    ]);
    await nav.build({
      positions,
      indices: new Uint32Array([0, 2, 1, 0, 3, 2, 4, 6, 5, 4, 7, 6]),
    });
    try {
      expect(nav.nearest([0.25, 0, 0], 0.1)).toBeNull();
      const start = nav.project([-2, 0, 0]);
      const p = new PlayerMotion(nav, start);
      for (let i = 0; i < 120; i++) p.update(1 / 60, 1, 0);
      expect(p.frame.position[0]).toBeLessThan(0);
      const edgeX = p.frame.position[0];
      p.jump();
      for (let i = 0; i < 90; i++) p.update(1 / 60, 1, 1);
      expect(p.frame.position[0]).toBeCloseTo(edgeX, 1);
      expect(p.frame.position[2]).toBeGreaterThan(2);
      expect(p.frame.airborne).toBe(false);
      expect(p.frame.position[1]).toBeCloseTo(start[1], 3);
    } finally {
      nav.dispose();
    }
  });
});
