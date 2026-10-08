import { normalizeMap } from "../src/client/rendering/map/shared/map";
import { buildSceneGeometry } from "../src/client/navigation/geometry";
import { Navigation } from "../src/client/navigation/navigation";
import type { ScenePlan } from "../src/shared/scenePlan";
import { revision, clip } from "./fixtures";
import type { Actor, Performance } from "../src/shared/contracts";
import type { MapResource } from "../src/shared/maps";
export const sceneActor: Actor = {
  id: "duck",
  name: "fixture duck",
  updatedAt: 1,
  modelRevisions: [revision],
  animations: [clip],
};
export const sceneMap: MapResource = {
  id: "court",
  name: "court",
  updatedAt: 1,
  scheme: null,
  map: normalizeMap({
    box: { size: [20, 10, 20] },
    waterBodies: [
      {
        id: "pond",
        name: "pond",
        type: "lake",
        level: 0.2,
        depth: 1,
        width: 1,
        points: [
          [-2, -3],
          [2, -3],
          [2, 3],
          [-2, 3],
        ],
      },
    ],
    objects: [
      {
        id: "bridge",
        name: "bridge",
        assetId: null,
        visible: true,
        transform: {
          position: [0, 0.1, 0],
          rotation: [0, 0, 0],
          scale: [8, 0.2, 2],
          size: [1, 1, 1],
        },
      },
    ],
  } as any),
};
export const baseScene: Performance = {
  id: "base",
  mapId: sceneMap.id,
  name: "base",
  updatedAt: 1,
  instances: [],
};
export function scenePlan(): ScenePlan {
  return {
    schemaVersion: 1,
    name: "living court",
    actors: [
      {
        key: "duck",
        name: "duck",
        actorId: sceneActor.id,
        modelRevisionId: revision.id,
        origin: "circuit",
        locations: [
          {
            key: "circuit",
            featureId: "water:pond",
            relation: "surroundingRoute",
          },
          { key: "show", featureId: "object:bridge", relation: "center" },
          { key: "facing", featureId: "water:pond", relation: "facing" },
        ],
        actions: [
          {
            key: "patrol",
            name: "patrol",
            steps: [
              {
                type: "followRoute",
                route: "circuit",
                animation: clip.id,
                speed: 3,
                rate: 1,
              },
            ],
          },
          {
            key: "show",
            name: "visit, perform and return",
            steps: [
              {
                type: "moveTo",
                target: "show",
                animation: clip.id,
                speed: 3,
                rate: 1,
              },
              { type: "face", target: "facing" },
              { type: "playClip", animation: clip.id, rate: 1, repetitions: 1 },
              {
                type: "moveTo",
                target: "circuit",
                animation: clip.id,
                speed: 3,
                rate: 1,
              },
            ],
          },
        ],
        states: [
          {
            key: "patrol",
            name: "patrol",
            action: "patrol",
            repetitions: 1,
            waitSeconds: 0,
            next: "show",
          },
          {
            key: "show",
            name: "show and return",
            action: "show",
            repetitions: 1,
            waitSeconds: 0,
            next: "patrol",
          },
        ],
        initialState: "patrol",
      },
    ],
  };
}
export async function assemblyFixture() {
  const geometry = await buildSceneGeometry(sceneMap.map),
    nav = new Navigation({ radius: 0.3, height: 3, climb: 0.4, slope: 35 });
  await nav.build(geometry);
  return {
    geometry,
    nav,
    context: {
      map: sceneMap,
      actors: new Map([[sceneActor.id, sceneActor]]),
      base: baseScene,
      request: "patrol and perform",
      geometry,
      navigation: async () => nav,
      climb: 0.4,
    },
    dispose() {
      geometry.dispose();
      nav.dispose();
    },
  };
}
