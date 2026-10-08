/** Serializable rules only; execution and navigation remain local. */
export interface CharacterState {
  id: string;
  name: string;
  actionId: string;
  repetitions: number;
  waitSeconds: number;
  nextStateId: string | null;
}
export interface CharacterMachine {
  schemaVersion: 1;
  enabled: boolean;
  initialStateId: string;
  states: CharacterState[];
}
export function validateCharacterMachine(
  value: CharacterMachine,
  actionIds: Set<string>,
) {
  const keys = (v: object, allowed: string[]) =>
    Object.keys(v).every((k) => allowed.includes(k));
  if (
    !value ||
    value.schemaVersion !== 1 ||
    typeof value.enabled !== "boolean" ||
    !Array.isArray(value.states) ||
    !value.states.length ||
    value.states.length > 100 ||
    !keys(value, ["schemaVersion", "enabled", "initialStateId", "states"])
  )
    throw new Error("角色状态机配置无效");
  const ids = new Set<string>();
  for (const state of value.states) {
    if (
      !state ||
      typeof state.id !== "string" ||
      !state.id ||
      state.id.length > 100 ||
      ids.has(state.id) ||
      typeof state.name !== "string" ||
      !state.name.trim() ||
      state.name.length > 100 ||
      !actionIds.has(state.actionId) ||
      !Number.isInteger(state.repetitions) ||
      state.repetitions < 1 ||
      state.repetitions > 100 ||
      !Number.isFinite(state.waitSeconds) ||
      state.waitSeconds < 0 ||
      state.waitSeconds > 3600 ||
      !keys(state, [
        "id",
        "name",
        "actionId",
        "repetitions",
        "waitSeconds",
        "nextStateId",
      ])
    )
      throw new Error("角色状态的名称、动作、次数或等待时间无效");
    ids.add(state.id);
  }
  if (!ids.has(value.initialStateId)) throw new Error("角色初始状态不存在");
  for (const state of value.states)
    if (state.nextStateId !== null && !ids.has(state.nextStateId))
      throw new Error("角色后续状态不存在");
}
