export type LocationRelation =
  "near" | "center" | "shore" | "surroundingRoute" | "alongGuide" | "facing";
export interface SemanticFeature {
  id: string;
  name: string;
  kind: "water" | "bridge" | "tree" | "building" | "path" | "ground" | "object";
  source: "map" | "name";
  queries: LocationRelation[];
  near: string[];
}
/** Small AI-facing catalogue. Geometry, paths and coordinates never appear here. */
export interface MapSemantics {
  mapId: string;
  revision: number;
  name: string;
  features: SemanticFeature[];
}
export interface LocationIntent {
  key: string;
  featureId: string;
  relation: LocationRelation;
}
