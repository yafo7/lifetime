export type Vec3 = [number, number, number];
export const PLAYER_MOVE_SPEED = 4.2, PLAYER_SPRINT_MULTIPLIER = 1.6, SPECTATOR_MOVE_SPEED = 8, PLAYER_JUMP_SPEED = 6.5 * Math.sqrt(1.5), PLAYER_GRAVITY = 18;
export interface InputState { forward: boolean; backward: boolean; left: boolean; right: boolean; up: boolean; down: boolean; sprint: boolean; yaw: number; pitch: number }
