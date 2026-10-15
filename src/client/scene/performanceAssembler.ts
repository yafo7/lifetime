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
import { TraversalClearance } from "../navigation/traversalClearance";
import { TraversalPlanner } from "../navigation/traversalPlanner";
import { adaptTraversal } from "../navigation/adaptTraversal";
import { compileSceneAction } from "./actionCompiler";
import { validateSceneDesign } from "../../shared/sceneDesign";
import type {
  AssemblyDraft,
  AssemblyRole,
  AssemblyIssue,
} from "../../shared/sceneBuild";

class AssemblyCheckpointFailure extends Error {}
function fingerprint(value: unknown) {
  const text = JSON.stringify(value);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++)
    hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16);
}
export class AssemblyNeedsRepair extends Error {
  constructor(readonly draft: AssemblyDraft) {
    super(
      Object.values(draft.roles)
        .flatMap((r) => r.issues)
        .map((i) => i.message)[0] || "地图装配需要调整",
    );
  }
}

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
    draft?: AssemblyDraft;
    checkpoint?: (draft: AssemblyDraft) => Promise<void>;
  },
): Promise<AssembledScene> {
  const { map, actors, base, signal } = context,
    index = buildSemanticIndex(map),
    performance = structuredClone(base);
  const draft: AssemblyDraft = context.draft ?? {
    schemaVersion: 1,
    revision: 0,
    mapRevision: map.updatedAt,
    planSignature: JSON.stringify(plan),
    performanceId: crypto.randomUUID(),
    roles: {},
    state: "working",
  };
  if (
    draft.mapRevision !== map.updatedAt ||
    draft.planSignature !== JSON.stringify(plan)
  )
    throw new Error("空间草稿与当前地图或方案版本不一致，请重新检查方案");
  draft.state = "working";
  const save = async () => {
    check();
    for (const role of Object.values(draft.roles)) {
      let n = 0;
      for (const location of Object.values(role.locations))
        for (const point of location.points) point.name = `p${++n}`;
    }
    try {
      await context.checkpoint?.(draft);
    } catch (error) {
      throw new AssemblyCheckpointFailure(
        `空间草稿保存失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  performance.id = draft.performanceId;
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
    const work: AssemblyRole = (draft.roles[role.key] ??= {
      instanceId: role.instanceId ?? crypto.randomUUID(),
      locations: {},
      actions: {},
      checks: {},
      issues: [],
    });
    work.issues = [];
    try {
      context.stage?.(`确定 ${role.name} 的地图位置`);
      const source = actors.get(role.actorId)!;
      let actor = structuredClone(source);
      const resourcesSignature = fingerprint([
        source.modelRevisions.find((m) => m.id === role.modelRevisionId),
        source.animations.filter(
          (c) => c.modelRevisionId === role.modelRevisionId,
        ),
      ]);
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
      const sameModel = existing?.modelRevisionId === model.id;
      const bounds = calculateModelVisualBounds(model.modelJson),
        scale = sameModel
          ? existing!.scale
          : 2 / Math.max(0.01, bounds.max[1] - bounds.min[1]);
      const profile = (sameModel
        ? existing?.sceneMotion?.navigation
        : null) ?? {
        radius: Math.max(
          0.05,
          (Math.hypot(
            bounds.max[0] - bounds.min[0],
            bounds.max[2] - bounds.min[2],
          ) *
            scale) /
            2 +
            0.05,
        ),
        height: Math.max(0.1, (bounds.max[1] - bounds.min[1]) * scale),
        climb: existing?.sceneMotion?.navigation.climb ?? context.climb,
        slope: 35,
      };
      const instance: ActorInstance = existing
        ? structuredClone(existing)
        : {
            id: work.instanceId,
            actorId: actor.id,
            modelRevisionId: model.id,
            clipId: null,
            position: [0, 0, 0],
            rotation: 0,
            scale,
            loop: false,
          };
      instance.modelRevisionId = model.id;
      instance.scale = scale;
      const profileChanged =
        JSON.stringify(work.profile) !== JSON.stringify(profile);
      work.profile = structuredClone(profile);
      await save();
      const nav = await context.navigation(profile);
      const clearance = new TraversalClearance(
        context.geometry,
        map.map,
        profile,
      );
      const traversalPolicy = existing?.sceneMotion?.traversal;
      const traversal = new TraversalPlanner(nav, clearance, traversalPolicy);
      check();
      const unchanged =
        sameModel &&
        !!existing?.sceneMotion &&
        !!oldRole &&
        JSON.stringify(oldRole.locations) === JSON.stringify(role.locations) &&
        JSON.stringify(oldRole.actions) === JSON.stringify(role.actions) &&
        oldRole.origin === role.origin &&
        !Object.values(work.locations).some((l) => l.manual);
      let actionIds: Record<string, string>,
        locationsIds: Record<string, string[]>;
      if (unchanged) {
        actionIds = structuredClone(previous!.actions);
        locationsIds = structuredClone(previous!.locations);
        for (const intent of role.locations) {
          const points = existing!.sceneMotion!.points.filter((p) =>
            locationsIds[intent.key]?.includes(p.id),
          );
          work.locations[intent.key] = {
            intent: structuredClone(intent),
            name: index.features.get(intent.featureId)?.semantic.name,
            points: structuredClone(points),
            automatic: structuredClone(
              previous!.points.filter((p) =>
                locationsIds[intent.key]?.includes(p.id),
              ),
            ),
            manual: points.some(
              (p) =>
                JSON.stringify(p) !==
                JSON.stringify(previous!.points.find((old) => old.id === p.id)),
            ),
            closed:
              intent.relation === "surroundingRoute" ||
              !!index.map.guides.find(
                (g) => `guide:${g.id}` === intent.featureId,
              )?.closed,
            state: "ready",
          };
        }
        for (const intent of role.actions) {
          const binding = existing!.sceneMotion!.actions.find(
            (a) => a.id === actionIds[intent.key],
          );
          if (binding && "actorActionId" in binding) {
            const action = actor.motionActions?.find(
              (a) => a.id === binding.actorActionId,
            );
            const inputs = new Set(
              intent.steps.flatMap((s) =>
                "target" in s ? [s.target] : "route" in s ? [s.route] : [],
              ),
            );
            const signature = JSON.stringify([
              resourcesSignature,
              intent,
              Object.entries(work.locations)
                .filter(([key]) => inputs.has(key))
                .map(([key, l]) => [key, l.points.map((p) => p.id), l.closed]),
            ]);
            if (action)
              work.actions[intent.key] = {
                signature,
                bindingId: binding.id,
                bindings: structuredClone(binding.bindings),
                action: structuredClone(action),
                state: "pending",
              };
          }
        }
      } else {
        const resolver = new LocationResolver(
            index,
            context.geometry,
            nav,
            signal,
            traversal,
          ),
          locations = new Map<string, ResolvedLocation>();
        for (const intent of [...role.locations].sort(
          (a, b) =>
            Number(b.key === role.origin) - Number(a.key === role.origin),
        )) {
          check();
          let location = work.locations[intent.key];
          try {
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
              !location?.manual &&
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
            } else if (
              location?.manual ||
              (location?.state === "ready" && !profileChanged)
            ) {
              const restored = {
                intent,
                points: structuredClone(location.points),
                closed: location.closed,
              };
              resolver.validate(restored);
              locations.set(intent.key, restored);
            } else
              locations.set(
                intent.key,
                await resolver.resolve(
                  intent,
                  locations.get(role.origin)?.points[0]?.ground
                    ? pointPosition(locations.get(role.origin)!.points[0])
                    : undefined,
                  intent.key === role.origin
                    ? role.locations.filter(
                        (target) =>
                          target.key !== role.origin &&
                          role.actions.some((action) =>
                            action.steps.some(
                              (step) =>
                                (step.type === "moveTo" &&
                                  step.target === target.key) ||
                                (step.type === "followRoute" &&
                                  step.route === target.key),
                            ),
                          ),
                      )
                    : [],
                ),
              );
            const result = locations.get(intent.key)!;
            location = work.locations[intent.key] = {
              intent: structuredClone(intent),
              name: index.features.get(intent.featureId)?.semantic.name,
              points: result.points,
              automatic: location?.automatic.length
                ? location.automatic
                : structuredClone(result.points),
              manual: location?.manual ?? false,
              closed: result.closed,
              state: "ready",
            };
          } catch (error) {
            check();
            const suggested = (
              error as { points?: import("../../shared/motion").ActionPoint[] }
            ).points;
            const candidate = suggested?.length
              ? {
                  points: suggested,
                  closed: !!(error as { closed?: boolean }).closed,
                }
              : location?.points.length
                ? location
                : resolver.preview(intent);
            const issue: AssemblyIssue = {
              code: (error as { code?: string }).code ?? "LOCATION_UNRESOLVED",
              locationKey: intent.key,
              message: `${role.name} · ${index.features.get(intent.featureId)?.semantic.name ?? intent.key}：${error instanceof Error ? error.message : String(error)}`,
            };
            work.locations[intent.key] = {
              intent: structuredClone(intent),
              name: index.features.get(intent.featureId)?.semantic.name,
              points: candidate.points,
              automatic:
                location?.automatic ?? structuredClone(candidate.points),
              manual: location?.manual ?? false,
              closed: candidate.closed,
              state: "needs-repair",
              error: issue,
            };
            work.issues.push(issue);
          }
          await save();
        }
        const points = [...locations.values()].flatMap((l) => l.points);
        if (points.length > 20)
          throw new Error(`${role.name} 的自动标点超过20个，请简化行为`);

        if (!locations.has(role.origin))
          throw new Error("起始站位需要调整，已确定的其他点已保留");
        instance.position = pointPosition(
          locations.get(role.origin)!.points[0],
        );
        instance.clipId = null;
        instance.loop = false;
        instance.sceneMotion = {
          schemaVersion: 2,
          points,
          actions: [],
          selectedActionId: null,
          startPointId: locations.get(role.origin)!.points[0].id,
          navigation: profile,
          ...(traversalPolicy ? { traversal: traversalPolicy } : {}),
        };
        actionIds = {};
        locationsIds = Object.fromEntries(
          [...locations].map(([key, l]) => [key, l.points.map((p) => p.id)]),
        );
        context.stage?.(`制作 ${role.name} 的完整动作`);
        for (const intent of role.actions) {
          const inputs = new Set(
            intent.steps.flatMap((s) =>
              "target" in s ? [s.target] : "route" in s ? [s.route] : [],
            ),
          );
          const signature = JSON.stringify([
            resourcesSignature,
            intent,
            [...locations]
              .filter(([key]) => inputs.has(key))
              .map(([key, l]) => [key, l.points.map((p) => p.id), l.closed]),
          ]);
          const cached = work.actions[intent.key];
          try {
            const compiled =
              cached?.action && cached.signature === signature
                ? { action: cached.action, bindings: cached.bindings }
                : compileSceneAction(intent, actor, model.id, locations);
            actor.motionActions ??= [];
            actor.motionActions = actor.motionActions.filter(
              (a) => a.id !== compiled.action.id,
            );
            actor.motionActions.push(compiled.action);
            pending.push({ actorId: actor.id, action: compiled.action });
            const id = cached?.bindingId ?? crypto.randomUUID();
            work.actions[intent.key] = {
              signature,
              bindingId: id,
              action: compiled.action,
              bindings: compiled.bindings,
              state: "pending",
            };
            actionIds[intent.key] = id;
            instance.sceneMotion.actions.push({
              id,
              name: intent.name,
              actorActionId: compiled.action.id,
              actorActionUpdatedAt: compiled.action.updatedAt,
              bindings: compiled.bindings,
            });
          } catch (error) {
            check();
            const issue: AssemblyIssue = {
              code: "ACTION_INPUT_MISSING",
              actionKey: intent.key,
              message: `${role.name} · ${intent.name}：${error instanceof Error ? error.message : String(error)}`,
            };
            work.actions[intent.key] = {
              signature,
              bindingId: cached?.bindingId ?? crypto.randomUUID(),
              bindings: {},
              state: "needs-repair",
              error: issue,
            };
            work.issues.push(issue);
          }
          await save();
        }
        instance.sceneMotion.selectedActionId =
          actionIds[role.actions[0].key] ?? Object.values(actionIds)[0] ?? null;
      }
      work.instance = structuredClone(instance);
      const runtimeStates = role.states
        .filter((s) => actionIds[s.action])
        .map((s) => ({
          id: s.key,
          name: s.name,
          actionId: actionIds[s.action],
          repetitions: s.repetitions,
          waitSeconds: s.waitSeconds,
          nextStateId: s.next,
        }));
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
      if (runtimeStates.length !== role.states.length)
        delete instance.sceneMotion!.machine;
      validateSceneMotion(instance.sceneMotion!, actor, instance, map.map);
      context.stage?.(`验证 ${role.name} 的路线与状态衔接`);
      const ctx = sceneContext(actor, instance, map.map);
      const prepare = async (
        id: string,
        origin: { position: [number, number, number]; heading: number },
      ) => {
        check();
        const binding = instance.sceneMotion!.actions.find((a) => a.id === id)!;
        const compiled = adaptTraversal(
            sceneActionPlan(binding, ctx),
            ctx,
            origin.position,
            traversal,
          ).plan,
          runtime = new MotionRuntime({
            route: (a, b, via) => {
              try {
                return nav.route(a, b, via);
              } catch (error) {
                const locationKey = Object.entries(work.locations).find(
                  ([, l]) =>
                    l.points.some(
                      (p) =>
                        p.ground &&
                        pointPosition(p).every(
                          (v, i) => Math.abs(v - b[i]) < 0.01,
                        ),
                    ),
                )?.[0];
                throw Object.assign(
                  new Error(
                    error instanceof Error ? error.message : String(error),
                  ),
                  {
                    code:
                      (error as { code?: string }).code ?? "TARGET_UNREACHABLE",
                    locationKey,
                  },
                );
              }
            },
            stationary: (p) => {
              traversal.assertStationary(p);
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
        await checkStationaryClearance(
          actor,
          instance,
          map.map,
          runtime,
          timing,
        );
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
        position: traversalPolicy?.fly
          ? initialPoint
            ? pointPosition(initialPoint)
            : instance.position
          : nav.project(
              initialPoint ? pointPosition(initialPoint) : instance.position,
            ),
        heading: (instance.rotation * Math.PI) / 180,
      };
      const endpoints = new Map<
        string,
        { position: [number, number, number]; heading: number }
      >();
      // Preflight every defined state and each possible completion edge before publishing.
      for (const state of runtimeStates) {
        const actionKey = role.states.find((s) => s.key === state.id)!.action;
        const binding = instance.sceneMotion!.actions.find(
          (a) => a.id === state.actionId,
        )!;
        const used =
          "bindings" in binding
            ? new Set(Object.values(binding.bindings))
            : null;
        const signature = JSON.stringify([
          resourcesSignature,
          work.profile,
          traversalPolicy,
          instance.sceneMotion!.points.filter((p) => !used || used.has(p.id)),
          sceneActionPlan(binding, ctx),
          origin,
        ]);
        try {
          const previousCheck = work.checks[state.id];
          const end =
            previousCheck?.signature === signature &&
            !previousCheck.error &&
            previousCheck.end
              ? previousCheck.end
              : await prepare(state.actionId, origin);
          endpoints.set(state.id, end);
          if (work.actions[actionKey]) {
            work.actions[actionKey].state = "ready";
            delete work.actions[actionKey].error;
          }
          work.checks[state.id] = { signature, end };
        } catch (error) {
          check();
          const issue: AssemblyIssue = {
            code: (error as { code?: string }).code ?? "ACTION_INVALID",
            actionKey,
            stateKey: state.id,
            locationKey: (error as { locationKey?: string }).locationKey,
            message: `${role.name} · ${state.name}：${error instanceof Error ? error.message : String(error)}`,
          };
          work.checks[state.id] = { signature, error: issue };
          if (work.actions[actionKey]) {
            work.actions[actionKey].state = "needs-repair";
            work.actions[actionKey].error = issue;
          }
          work.issues.push(issue);
        }
        await save();
      }
      for (const state of runtimeStates) {
        const end = endpoints.get(state.id);
        if (!end) continue;
        const edgeKey = `edge:${state.id}`;
        const edgeActions = [
          state.actionId,
          runtimeStates.find((s) => s.id === state.nextStateId)?.actionId,
        ].filter(Boolean);
        const edgeBindings = instance.sceneMotion!.actions.filter((a) =>
          edgeActions.includes(a.id),
        );
        const usedPoints = new Set(
          edgeBindings.flatMap((a) =>
            "bindings" in a ? Object.values(a.bindings) : [],
          ),
        );
        const signature = JSON.stringify([
          end,
          state,
          resourcesSignature,
          work.profile,
          edgeBindings.map((a) => sceneActionPlan(a, ctx)),
          instance.sceneMotion!.points.filter((p) => usedPoints.has(p.id)),
        ]);
        if (
          work.checks[edgeKey]?.signature === signature &&
          !work.checks[edgeKey].error
        )
          continue;
        try {
          if (state.repetitions > 1) await prepare(state.actionId, end);
          if (state.nextStateId) {
            const next = runtimeStates.find((s) => s.id === state.nextStateId);
            if (next) await prepare(next.actionId, end);
          }
          work.checks[edgeKey] = { signature };
        } catch (error) {
          check();
          const issue = {
            code:
              (error as { code?: string }).code ?? "STATE_TRANSITION_INVALID",
            stateKey: state.id,
            message: `${role.name} · ${state.name}衔接：${error instanceof Error ? error.message : String(error)}`,
          };
          work.checks[edgeKey] = { signature, error: issue };
          work.issues.push(issue);
        }
        await save();
      }
      work.instance = structuredClone(instance);
      if (work.issues.length) {
        await save();
        continue;
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
      await save();
    } catch (error) {
      if (error instanceof AssemblyCheckpointFailure) throw error;
      check();
      work.issues.push({
        code: (error as { code?: string }).code ?? "ROLE_INVALID",
        message: `${role.name}：${error instanceof Error ? error.message : String(error)}`,
      });
      await save();
    }
  }
  if (Object.values(draft.roles).some((r) => r.issues.length)) {
    draft.state = "needs-repair";
    await save();
    throw new AssemblyNeedsRepair(draft);
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
  draft.state = "ready";
  await save();
  return { performance, actions: pending, mapRevision: map.updatedAt };
}
