import { describe, it, expect } from "vitest";
import { decodeAnimation } from "../src/shared/animation";
import { AnimationPlayer } from "../src/client/rendering/animationPlayer";
import { buildModelGroupWithNodes } from "../src/client/rendering/map/client/modelRenderer";
import { modelJson, baked, clip } from "./fixtures";
describe("revision-bound pose playback", () => {
  it("uses returned duration and rejects unknown nodes and unsupported channels", () => {
    expect(decodeAnimation({ baked }, modelJson).duration).toBe(2);
    expect(() =>
      decodeAnimation(
        { baked: { ...baked, animation: { missing: { posX: [0] } } } },
        modelJson,
      ),
    ).toThrow("不存在");
    expect(() =>
      decodeAnimation(
        { baked: { ...baked, animation: { body: { scaleX: [1] } } } },
        modelJson,
      ),
    ).toThrow("不支持");
    expect(() =>
      decodeAnimation(
        { baked: { ...baked, animation: { body: { quatX: [0] } } } },
        modelJson,
      ),
    ).toThrow("四元数");
  });
  it("preserves parent-local hierarchy, metadata and nonuniform scale", async () => {
    const model = structuredClone(modelJson);
    Object.assign(model.nodes[0].transform!, { scale: [2, 3, 4] });
    const built = await buildModelGroupWithNodes(model, { fidelity: true });
    expect(built.objects.get("head")?.parent).toBe(built.objects.get("body"));
    expect(built.objects.get("body")?.scale.toArray()).toEqual([2, 3, 4]);
    expect(model._meta.ai.provider).toBe("fixture");
  });
  it("seeks deterministically without changing other instances and resets to rest", async () => {
    const first = await buildModelGroupWithNodes(modelJson, { fidelity: true }),
      second = await buildModelGroupWithNodes(modelJson, { fidelity: true });
    const player = new AnimationPlayer(first);
    player.sample(clip, 0.5);
    const angle = first.objects.get("arm")!.rotation.z;
    player.sample(clip, 1.5);
    player.sample(clip, 0.5);
    expect(first.objects.get("arm")!.rotation.z).toBeCloseTo(angle);
    expect(second.objects.get("arm")!.rotation.z).toBeCloseTo(0);
    player.sample(null, 0);
    expect(first.objects.get("arm")!.rotation.z).toBeCloseTo(0);
  });
  it("treats baked quaternion tracks as absolute local rotation", async () => {
    const built = await buildModelGroupWithNodes(modelJson, { fidelity: true });
    built.objects.get("body")!.rotation.y = 0.7;
    const player = new AnimationPlayer(built);
    player.sample(
      {
        ...clip,
        animation: {
          fps: 1,
          duration: 1,
          animation: {
            body: { quatX: [0], quatY: [0], quatZ: [0], quatW: [1], posY: [2] },
          },
        },
      },
      0,
    );
    expect(built.objects.get("body")!.rotation.y).toBeCloseTo(0);
    expect(built.objects.get("body")!.position.y).toBeCloseTo(3.4);
  });
  it("rejects legacy effect templates instead of silently dropping them", () => {
    expect(() =>
      decodeAnimation(
        { plan: { _duration: 1, body: { emit: {} } } },
        modelJson,
      ),
    ).toThrow("模板");
    expect(
      decodeAnimation(
        {
          plan: { _duration: 1, arm: { swing: { axis: "z", amplitude: 0.2 } } },
        },
        modelJson,
      ).format,
    ).toBe("plan");
  });
});
