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
export interface Actor {
  id: string;
  name: string;
  updatedAt: number;
  modelRevisions: ModelRevision[];
  animations: AnimationClip[];
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
