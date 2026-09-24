import type * as THREE from 'three';
export function create(options: { THREE: typeof THREE }): {
  buildGeometry(type: string, params: Record<string, unknown>): THREE.BufferGeometry;
  listAnimationTemplates(): Array<{ key: string }>;
  evaluateMotion(plan: unknown, duration: number, time: number, lookups: unknown): Record<string, { position?: number[]; rotation?: number[]; scale?: number[] | null }>;
};
