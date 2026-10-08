import type { PoolEntry, SavedAction } from "./motion";
export type Provider = "gpt" | "deepseek";
export interface ModelRevision {
  id: string;
  createdAt: number;
  prompt: string;
  provider: Provider;
  mode: string;
  modelJson: unknown;
  metadata?: unknown;
}
export interface AnimationClip {
  id: string;
  name: string;
  createdAt: number;
  prompt: string;
  provider: Provider;
  mode: "quick" | "pro";
  modelRevisionId: string;
  format: "baked" | "plan";
  animation: unknown;
  duration: number;
  metadata?: unknown;
}
export interface ActionPool {
  id: string;
  name: string;
  createdAt: number;
  modelRevisionId: string;
  clipIds: string[];
  entries?: PoolEntry[];
}
export interface Actor {
  id: string;
  name: string;
  updatedAt: number;
  modelRevisions: ModelRevision[];
  animations: AnimationClip[];
  /** Legacy pool field, retained for lossless migration. */
  actions?: ActionPool[];
  pools?: ActionPool[];
  motionActions?: SavedAction[];
}
export interface ActorInstance {
  id: string;
  actorId: string;
  modelRevisionId: string;
  clipId: string | null;
  position: [number, number, number];
  rotation: number;
  scale: number;
  loop: boolean;
  sceneMotion?: import("./sceneMotion").SceneMotion;
}
export interface Performance {
  id: string;
  name: string;
  mapId: string;
  instances: ActorInstance[];
  updatedAt: number;
}
export interface ResourceSummary {
  id: string;
  name: string;
  updatedAt: number;
}
