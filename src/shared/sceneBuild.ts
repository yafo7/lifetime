import type { Performance } from "./contracts";
import type { ScenePlan } from "./scenePlan";
import type { AssetManifest, SceneBlueprint } from "./sceneBlueprint";
import type { ActorInstance } from "./contracts";
import type { ActionPoint, SavedAction, Vec3 } from "./motion";
import type { LocationIntent } from "./mapSemantics";
import type { NavigationProfile } from "./sceneMotion";

export interface AssemblyIssue {
  code: string;
  message: string;
  locationKey?: string;
  actionKey?: string;
  stateKey?: string;
}
export interface AssemblyLocation {
  intent: LocationIntent;
  name?: string;
  points: ActionPoint[];
  automatic: ActionPoint[];
  manual: boolean;
  closed: boolean;
  state: "pending" | "ready" | "needs-repair";
  error?: AssemblyIssue;
}
export interface AssemblyAction {
  signature: string;
  bindingId: string;
  action?: SavedAction;
  bindings: Record<string, string>;
  state: "pending" | "ready" | "needs-repair";
  error?: AssemblyIssue;
}
export interface AssemblyRole {
  instanceId: string;
  profile?: NavigationProfile;
  instance?: ActorInstance;
  locations: Record<string, AssemblyLocation>;
  actions: Record<string, AssemblyAction>;
  checks: Record<
    string,
    {
      signature: string;
      error?: AssemblyIssue;
      end?: { position: Vec3; heading: number };
    }
  >;
  issues: AssemblyIssue[];
}
/** Editable production work. An incomplete draft is never a published Performance. */
export interface AssemblyDraft {
  schemaVersion: 1;
  revision: number;
  mapRevision: number;
  planSignature: string;
  performanceId: string;
  roles: Record<string, AssemblyRole>;
  state: "working" | "needs-repair" | "ready";
}

export type AssetTaskState =
  | "waiting"
  | "queued"
  | "generating"
  | "saving"
  | "save-failed"
  | "done"
  | "failed"
  | "uncertain";
export interface AssetTask {
  id: string;
  roleKey: string;
  animationKey?: string;
  kind: "model" | "animation";
  name: string;
  description: string;
  state: AssetTaskState;
  status: string;
  error?: string;
  attempts: number;
  reused: boolean;
  updatedAt: number;
}
export interface SceneGenerationRun {
  purpose?: "navigation-assets";
  traversalAssets?: {
    actorId: string;
    modelRevisionId: string;
    kinds: import("./traversal").TraversalKind[];
  };
  schemaVersion: 1;
  id: string;
  mapId: string;
  mapRevision: number;
  base: Performance;
  request: string;
  climb: number;
  phase:
    | "planning"
    | "generating"
    | "assets-ready"
    | "assembling"
    | "ready"
    | "failed"
    | "cancelled";
  status: string;
  blueprint?: SceneBlueprint;
  manifest: AssetManifest;
  tasks: AssetTask[];
  plan?: ScenePlan;
  assembly?: AssemblyDraft;
  planningResponse?: string;
  performanceId?: string;
  error?: string;
  lease?: { owner: string; token: string; until: number };
  startedAt: number;
  updatedAt: number;
}
