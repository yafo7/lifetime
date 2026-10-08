import { init, exportNavMesh } from "recast-navigation";
import { generateSoloNavMesh } from "recast-navigation/generators";
import type { NavigationProfile } from "../../shared/sceneMotion";
import { navigationConfig } from "./settings";
const scope = self as unknown as {
  onmessage: (e: MessageEvent<any>) => void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};
scope.onmessage = async (
  e: MessageEvent<{
    positions: Float32Array;
    indices: Uint32Array;
    profile: NavigationProfile;
  }>,
) => {
  try {
    await init();
    const result = generateSoloNavMesh(
      e.data.positions,
      e.data.indices,
      navigationConfig(e.data.profile),
    );
    if (!result.success) throw new Error(result.error);
    const bytes = exportNavMesh(result.navMesh);
    result.navMesh.destroy();
    scope.postMessage({ bytes }, [bytes.buffer as ArrayBuffer]);
  } catch (error) {
    scope.postMessage({
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
