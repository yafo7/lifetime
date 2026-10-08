import type { NavigationProfile } from "../../shared/sceneMotion";
export function navigationConfig(profile: NavigationProfile) {
  const cs = 0.15,
    ch = 0.05;
  return {
    cs,
    ch,
    walkableRadius: Math.ceil(profile.radius / cs),
    walkableHeight: Math.ceil(profile.height / ch),
    walkableClimb: Math.floor(profile.climb / ch),
    walkableSlopeAngle: profile.slope,
    minRegionArea: 4,
    mergeRegionArea: 16,
    maxSimplificationError: 0.6,
    detailSampleDist: 3,
    detailSampleMaxError: 1,
  };
}
