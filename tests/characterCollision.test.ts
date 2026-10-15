import { describe, it, expect } from "vitest";
import {
  bodiesOverlap,
  canMoveBody,
  type CharacterBody,
} from "../src/client/navigation/characterCollision";
import { PlayerMotion } from "../src/client/play/playerMotion";

const body = (
  id: string,
  position: [number, number, number],
  radius = 0.5,
): CharacterBody => ({ id, position, radius, height: 2 });
describe("character collision", () => {
  it("uses volumes and height, sweeps fast moves, and permits tangential/separating movement", () => {
    const npc = body("npc", [0, 0, 0]),
      left = body("player", [-3, 0, 0]);
    expect(canMoveBody(left, [3, 0, 0], [npc])).toBe(false);
    expect(canMoveBody(left, [-1.2, 0, 0], [npc])).toBe(true);
    expect(canMoveBody(body("player", [0, 3, 0]), [3, 3, 0], [npc])).toBe(true);
    expect(canMoveBody(body("player", [0, 4, 0]), [0, -2, 0], [npc])).toBe(
      false,
    );
    expect(bodiesOverlap(body("small", [1.3, 0, 0]), npc)).toBe(false);
    expect(bodiesOverlap(body("large", [1.3, 0, 0], 1), npc)).toBe(true);
    expect(canMoveBody(body("legacy", [0.3, 0, 0]), [0.5, 0, 0], [npc])).toBe(
      true,
    );
    expect(canMoveBody(body("legacy", [0.3, 0, 0]), [0.1, 0, 0], [npc])).toBe(
      false,
    );
    expect(
      canMoveBody(body("player", [-1.12, 0, 0]), [-1.12, 0, 1], [npc]),
    ).toBe(true);
  });
  it("blocks a player against live NPCs, then resumes once the NPC has moved away", () => {
    let npc = body("npc", [0, 0, 0]);
    const player = new PlayerMotion(
      { move: (_from, to) => [...to] },
      [-3, 0, 0],
      0,
      1.1,
      () => Infinity,
      (from, to) => canMoveBody(body("player", from), to, [npc]),
    );
    for (let n = 0; n < 120; n++) player.update(1 / 60, 1, 0);
    expect(player.frame.position[0]).toBeLessThanOrEqual(-1.12);
    expect(player.frame.moving).toBe(false);
    npc = body("npc", [0, 0, 5]);
    for (let n = 0; n < 60; n++) player.update(1 / 60, 1, 0);
    expect(player.frame.position[0]).toBeGreaterThan(2);
  });
});
