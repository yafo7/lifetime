export type LocationRelation =
  "near" | "center" | "shore" | "surroundingRoute" | "alongGuide" | "facing";
export interface SemanticFeature {
  id: string;
  name: string;
  kind: "water" | "bridge" | "tree" | "building" | "path" | "ground" | "object";
  source: "map" | "name";
  queries: LocationRelation[];
  near: string[];
  /** Bounded source names/tags; not AI-invented capabilities. */
  aliases?: string[];
  /** Coarse map-relative location. North is -Z. No coordinates leave the resolver. */
  sector?:
    | "northwest"
    | "north"
    | "northeast"
    | "west"
    | "center"
    | "east"
    | "southwest"
    | "south"
    | "southeast";
}
/** Small AI-facing catalogue. Geometry, paths and coordinates never appear here. */
export interface MapSemantics {
  mapId: string;
  revision: number;
  name: string;
  features: SemanticFeature[];
  omittedFeatures?: number;
}
export interface LocationIntent {
  key: string;
  featureId: string;
  relation: LocationRelation;
}
