import type { AnimationClip, ModelRevision } from "../src/shared/contracts";
import { normalizeMap } from "../src/client/rendering/map/shared/map";
export const modelJson = {
  format: 2,
  _meta: {
    ai: { provider: "fixture" },
    semanticSnapshot: { v: 1, text: "A small robot", stats: {} },
  },
  nodes: [
    { id: "body", transform: { pos: [0, 1.4, 0] } },
    {
      id: "torso",
      parent: "body",
      mesh: {
        type: "box",
        params: { width: 1, height: 1.3, depth: 0.6 },
        color: 0x9dc18d,
      },
    },
    {
      id: "head",
      parent: "body",
      transform: { pos: [0, 1, 0] },
      mesh: {
        type: "box",
        params: { width: 0.8, height: 0.7, depth: 0.7 },
        color: 0xd9f47a,
      },
    },
    {
      id: "eye-left",
      parent: "head",
      transform: { pos: [-0.2, 0.08, 0.36] },
      mesh: {
        type: "box",
        params: { width: 0.12, height: 0.12, depth: 0.04 },
        color: 0x172326,
      },
    },
    {
      id: "eye-right",
      parent: "head",
      transform: { pos: [0.2, 0.08, 0.36] },
      mesh: {
        type: "box",
        params: { width: 0.12, height: 0.12, depth: 0.04 },
        color: 0x172326,
      },
    },
    { id: "arm", parent: "body", transform: { pos: [0.7, 0.1, 0] } },
    {
      id: "hand",
      parent: "arm",
      mesh: {
        type: "box",
        params: { width: 0.25, height: 1, depth: 0.3 },
        color: 0x9dc18d,
      },
    },
    {
      id: "left-leg",
      parent: "body",
      transform: { pos: [-0.28, -1, 0] },
      mesh: {
        type: "box",
        params: { width: 0.32, height: 0.7, depth: 0.4 },
        color: 0x4c7260,
      },
    },
    {
      id: "right-leg",
      parent: "body",
      transform: { pos: [0.28, -1, 0] },
      mesh: {
        type: "box",
        params: { width: 0.32, height: 0.7, depth: 0.4 },
        color: 0x4c7260,
      },
    },
  ],
};
export const revision: ModelRevision = {
  id: "model-fixture",
  createdAt: 1,
  prompt: "固定测试机器人",
  provider: "gpt",
  mode: "voxel-pro",
  modelJson,
};
export const baked = {
  fps: 30,
  duration: 2,
  loop: true,
  animation: {
    arm: {
      rotZ: Array.from(
        { length: 61 },
        (_, i) => Math.sin((i / 60) * Math.PI * 2) * 1.3,
      ),
    },
  },
};
export const clip: AnimationClip = {
  id: "clip-fixture",
  name: "挥手（测试样本）",
  createdAt: 2,
  prompt: "挥手",
  provider: "gpt",
  mode: "quick",
  modelRevisionId: revision.id,
  format: "baked",
  animation: baked,
  duration: 2,
};
export const testMap = normalizeMap({
  id: "map-fixture",
  name: "测试草地",
  sceneMode: "outdoor",
  box: {
    size: [20, 8, 20],
    colors: {
      floor: "#77956b",
      ceiling: "#9abbd0",
      north: "#899da0",
      south: "#899da0",
      east: "#899da0",
      west: "#899da0",
    },
  },
  terrain: { resolutionX: 2, resolutionZ: 2, heights: [0, 0, 0, 0] },
  assets: [],
  objects: [],
  grassLayers: [],
});
