import type { SavedAction } from "../../shared/motion";
import type {
  Actor,
  ActionPool,
  ModelRevision,
  AnimationClip,
  Performance,
  ResourceSummary,
} from "../../shared/contracts";
import type { MapResource } from "../../shared/maps";
const root = "/api/resources";
export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${root}${url}`, init);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value as T;
}
function json(method: string, value: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  };
}
export const resources = {
  list: (kind: "actors" | "maps" | "performances") =>
    request<ResourceSummary[]>(`/${kind}`),
  actor: (id: string) => request<Actor>(`/actors/${id}`),
  createActor: (name: string) =>
    request<Actor>("/actors", json("POST", { name })),
  renameActor: (id: string, name: string) =>
    request<Actor>(`/actors/${id}`, json("PATCH", { name })),
  model: (id: string, revision: ModelRevision) =>
    request<Actor>(`/actors/${id}/models`, json("POST", revision)),
  clip: (id: string, clip: AnimationClip) =>
    request<Actor>(`/actors/${id}/clips`, json("POST", clip)),
  saveAction: (id: string, action: ActionPool) =>
    request<Actor>(`/actors/${id}/actions`, json("POST", action)),
  savePool: (id: string, pool: ActionPool) =>
    request<Actor>(`/actors/${id}/pools`, json("POST", pool)),
  saveMotionAction: (id: string, action: SavedAction) =>
    request<Actor>(`/actors/${id}/motion-actions`, json("POST", action)),
  map: (id: string) => request<MapResource>(`/maps/${id}`),
  importMap: (file: File, mapId?: string) =>
    request<MapResource>(`/maps${mapId ? `?mapId=${mapId}` : ""}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,
    }),
  performance: (id: string) => request<Performance>(`/performances/${id}`),
  savePerformance: (draft: Performance) =>
    request<Performance>(`/performances/${draft.id}`, json("PUT", draft)),
  exportMap: (id: string) => `${root}/maps/${id}/export`,
  hdri: (id: string) => `${root}/maps/${id}/hdri`,
};
