/** Shared dimensions for the visible grid and actor movement. */
export const PREVIEW_GROUND_SIZE = 100;
export const PREVIEW_GROUND_HALF = PREVIEW_GROUND_SIZE / 2;
export const REFERENCE_TREE_POSITIONS = [
  [PREVIEW_GROUND_HALF / 2, 0],
  [-PREVIEW_GROUND_HALF / 2, 0],
  [0, PREVIEW_GROUND_HALF / 2],
  [0, -PREVIEW_GROUND_HALF / 2],
] as const;
