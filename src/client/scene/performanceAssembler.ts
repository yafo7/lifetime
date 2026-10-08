import type { Actor, ActorInstance, Performance } from "../../shared/contracts";
import type { MapResource } from "../../shared/maps";
import type { ScenePlan, SceneDesign } from "../../shared/scenePlan";
import {
  sceneContext,
  sceneActionPlan,
  validateSceneMotion,
  type NavigationProfile,
} from "../../shared/sceneMotion";
import { pointPosition, type SavedAction } from "../../shared/motion";
import { calculateModelVisualBounds } from "../rendering/map/shared/modelBounds";
import { MotionRuntime } from "../motion/runtime";
import { checkStationaryClearance } from "../navigation/actionClearance";
import {
  LocationResolver,
  type ResolvedLocation,
} from "../navigation/locationResolver";
import { buildSemanticIndex } from "../navigation/semanticIndex";
import type { SceneGeometry } from "../navigation/geometry";
import type { Navigation } from "../navigation/navigation";
import { compileSceneAction } from "./actionCompiler";
import { validateSceneDesign } from "../../shared/sceneDesign";

export interface AssembledScene {
  performance: Performance;
  actions: { actorId: string; action: SavedAction }[];
  mapRevision: number;
}
export async function assembleScene(
  plan: ScenePlan,
  context: {
    map: MapResource;
    actors: Map<string, Actor>;
    base: Performance;
    request: string;
    geometry: SceneGeometry;
    navigation: (p: NavigationProfile) => Promise<Navigation>;
    climb: number;
    signal?: AbortSignal;
    stage?: (text: string) => void;
  },
): Promise<AssembledScene> {
  const { map, actors, base, signal } = context,
    index = buildSemanticIndex(map),
    performance = structuredClone(base);
  performance.id = crypto.randomUUID();
  performance.name = plan.name;
  performance.updatedAt = Date.now();
  const pending: AssembledScene["actions"] = [],
    removed = new Set(plan.removeInstanceIds ?? []),
    roles: SceneDesign["roles"] = [];
  performance.instances = performance.instances.filter(
    (i) => !removed.has(i.id),
  );
  const check = () => {
    if (signal?.aborted) throw new Error("已取消场景构建");
  };
  for (const role of plan.actors) {
    check();
    context.stage?.(`确定 ${role.name} 的地图位置`);
    const source = actors.get(role.actorId)!;
    let actor = structuredClone(source);
    const previous = base.sceneDesign?.roles.find(
        (r) => r.instanceId === role.instanceId,
      ),
      oldRole = base.sceneDesign?.plan.actors.find(
        (a) => a.key === previous?.key,
      );
    const existing = role.instanceId
      ? performance.instances.find((i) => i.id === role.instanceId)
      : undefined;
    const model = actor.modelRevisions.find(
      (m) => m.id === role.modelRevisionId,
    )!;
    const bounds = calculateModelVisualBounds(model.modelJson),
      scale =
        existing?.scale ?? 2 / Math.max(0.01, bounds.max[1] - bounds.min[1]);
    const profile = existing?.sceneMotion?.navigation ?? {
      radius: Math.max(
        0.05,
        (Math.max(
          bounds.max[0] - bounds.min[0],
          bounds.max[2] - bounds.min[2],
        ) *
          scale) /
          2,
      ),
      height: Math.max(0.1, (bounds.max[1] - bounds.min[1]) * scale),
      climb: context.climb,
      slope: 35,
    };
    const instance: ActorInstance = existing
      ? structuredClone(existing)
      : {
          id: crypto.randomUUID(),
          actorId: actor.id,
          modelRevisionId: model.id,
          clipId: null,
          position: [0, 0, 0],
          rotation: 0,
          scale,
          loop: false,
        };
    const nav = await context.navigation(profile);
    check();
    const unchanged =
      !!existing?.sceneMotion &&
      !!oldRole &&
      JSON.stringify(oldRole.locations) === JSON.stringify(role.locations) &&
      JSON.stringify(oldRole.actions) === JSON.stringify(role.actions) &&
      oldRole.origin === role.origin;
    let actionIds: Record<string, string>,
      locationsIds: Record<string, string[]>;
    if (unchanged) {
      actionIds = structuredClone(previous!.actions);
      locationsIds = structuredClone(previous!.locations);
    } else {
      const resolver = new LocationResolver(
          index,
          context.geometry,
          nav,
          signal,
        ),
        locations = new Map<string, ResolvedLocation>();
      for (const intent of role.locations) {
        check();
        const previousIntent = oldRole?.locations.find(
            (l) => l.key === intent.key,
          ),
          ids = previous?.locations[intent.key];
        const edited = ids?.some(
          (id) =>
            JSON.stringify(
              existing?.sceneMotion?.points.find((p) => p.id === id),
            ) !== JSON.stringify(previous?.points.find((p) => p.id === id)),
        );
        if (
          edited &&
          JSON.stringify(previousIntent) === JSON.stringify(intent)
        ) {
          const points = ids!.map((id) =>
            existing!.sceneMotion!.points.find((p) => p.id === id)!,
          );
          if (points.some((p) => !p))
            throw new Error("人工标点已删除，请检查动作输入");
          locations.set(intent.key, {
            intent,
            points: structuredClone(points),
            closed: intent.relation === "surroundingRoute",
          });
        } else locations.set(intent.key, await resolver.resolve(intent));
      }
      const points = [...locations.values()].flatMap((l) => l.points);
      if (points.length > 20)
        throw new Error(`${role.name} 的自动标点超过20个，请简化行为`);
      points.forEach((p, n) => (p.name = "p" + (n + 1)));
      instance.position = pointPosition(locations.get(role.origin)!.points[0]);
      instance.clipId = null;
      instance.loop = false;
      instance.sceneMotion = {
        schemaVersion: 2,
        points,
        actions: [],
        selectedActionId: null,
        startPointId: locations.get(role.origin)!.points[0].id,
        navigation: profile,
      };
      actionIds = {};
      locationsIds = Object.fromEntries(
        [...locations].map(([key, l]) => [key, l.points.map((p) => p.id)]),
      );
      context.stage?.(`制作 ${role.name} 的完整动作`);
      for (const intent of role.actions) {
        const compiled = compileSceneAction(intent, actor, model.id, locations);
        actor.motionActions ??= [];
        actor.motionActions.push(compiled.action);
        pending.push({ actorId: actor.id, action: compiled.action });
        const id = crypto.randomUUID();
        actionIds[intent.key] = id;
        instance.sceneMotion.actions.push({
          id,
          name: intent.name,
          actorActionId: compiled.action.id,
          actorActionUpdatedAt: compiled.action.updatedAt,
          bindings: compiled.bindings,
        });
      }
      instance.sceneMotion.selectedActionId = actionIds[role.actions[0].key];
    }
    instance.sceneMotion!.machine = {
      schemaVersion: 1,
      enabled: true,
      initialStateId: role.initialState,
      states: role.states.map((s) => ({
        id: s.key,
        name: s.name,
        actionId: actionIds[s.action],
        repetitions: s.repetitions,
        waitSeconds: s.waitSeconds,
        nextStateId: s.next,
      })),
    };
    validateSceneMotion(instance.sceneMotion!, actor, instance, map.map);
    context.stage?.(`验证 ${role.name} 的路线与状态衔接`);
    const ctx = sceneContext(actor, instance, map.map);
    const prepare = async (
      id: string,
      origin: { position: [number, number, number]; heading: number },
    ) => {
      check();
      const binding = instance.sceneMotion!.actions.find((a) => a.id === id)!;
      const compiled = sceneActionPlan(binding, ctx),
        runtime = new MotionRuntime({
          route: (a, b, via) => nav.route(a, b, via),
          stationary: (p) => {
            nav.project(p);
          },
          preserveRoot: true,
        });
      runtime.executeAction(
        compiled,
        ctx,
        instance.id,
        {},
        origin.position,
        origin.heading,
      );
      const timing = runtime.inspectAction(
        compiled,
        ctx,
        {},
        origin.position,
        origin.heading,
      );
      await checkStationaryClearance(actor, instance, map.map, runtime, timing);
      check();
      runtime.reset();
      runtime.executeAction(
        compiled,
        ctx,
        instance.id,
        {},
        origin.position,
        origin.heading,
      );
      runtime.advance(runtime.getExecutionState()!.duration);
      const state = runtime.getExecutionState()!;
      const end = { position: state.position, heading: state.heading };
      runtime.reset();
      return end;
    };
    const initialPoint = instance.sceneMotion!.points.find(
      (p) => p.id === instance.sceneMotion!.startPointId,
    );
    const origin = {
      position: nav.project(
        initialPoint ? pointPosition(initialPoint) : instance.position,
      ),
      heading: (instance.rotation * Math.PI) / 180,
    };
    const endpoints = new Map<
      string,
      { position: [number, number, number]; heading: number }
    >();
    // Preflight every defined state and each possible completion edge before publishing.
    for (const state of instance.sceneMotion!.machine.states)
      endpoints.set(state.id, await prepare(state.actionId, origin));
    for (const state of instance.sceneMotion!.machine.states) {
      const end = endpoints.get(state.id)!;
      if (state.repetitions > 1) await prepare(state.actionId, end);
      if (state.nextStateId) {
        const next = instance.sceneMotion!.machine.states.find(
          (s) => s.id === state.nextStateId,
        )!;
        await prepare(next.actionId, end);
      }
    }
    if (existing)
      performance.instances[
        performance.instances.findIndex((i) => i.id === existing.id)
      ] = instance;
    else performance.instances.push(instance);
    // Retain the original automatic position for unchanged inputs, so later builds
    // can still distinguish the user's edits from generated coordinates.
    const snapshots = instance.sceneMotion!.points.map((point) => {
      const location = role.locations.find((l) =>
        locationsIds[l.key]?.includes(point.id),
      );
      const original = previous?.points.find((p) => p.id === point.id);
      const sameIntent =
        location &&
        JSON.stringify(
          oldRole?.locations.find((l) => l.key === location.key),
        ) === JSON.stringify(location);
      return structuredClone(
        original && sameIntent ? { ...original, name: point.name } : point,
      );
    });
    roles.push({
      key: role.key,
      instanceId: instance.id,
      actions: actionIds,
      locations: locationsIds,
      points: snapshots,
    });
  }
  const keptRoles = (base.sceneDesign?.roles ?? []).filter(
    (r) =>
      !removed.has(r.instanceId) &&
      !roles.some((n) => n.instanceId === r.instanceId),
  );
  const keptPlans = (base.sceneDesign?.plan.actors ?? []).filter((p) =>
    keptRoles.some((r) => r.key === p.key),
  );
  if (keptRoles.some((r) => roles.some((n) => n.key === r.key)))
    throw new Error("角色标识与保留角色重复，请使用唯一标识或引用要修改的实例");
  const resolvedPlans = plan.actors.map((p) => ({
    ...structuredClone(p),
    instanceId: roles.find((r) => r.key === p.key)!.instanceId,
  }));
  performance.sceneDesign = {
    schemaVersion: 1,
    request: context.request,
    plan: {
      schemaVersion: 1,
      name: plan.name,
      actors: [...keptPlans, ...resolvedPlans],
    },
    roles: [...keptRoles, ...roles],
  };
  if (performance.instances.length > 100)
    throw new Error("演出的演员实例超过100个，请缩小规划范围");
  validateSceneDesign(
    performance.sceneDesign,
    performance,
    [...actors.values()],
    map,
  );
  return { performance, actions: pending, mapRevision: map.updatedAt };
}
