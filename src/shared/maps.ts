import type { EditableMap } from "../client/rendering/map/shared/map";
import type { RenderScheme } from "../client/rendering/map/shared/renderScheme";
export type { EditableMap, RenderScheme };
export interface MapResource {
  id: string;
  name: string;
  updatedAt: number;
  map: EditableMap;
  scheme: RenderScheme | null;
  hdri?: { file: string; base64: string };
}
