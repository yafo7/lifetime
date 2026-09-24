/**
 * geometry-schema.js — Shared geometry parameter schema (Single Source of Truth)
 *
 * Consumed by:
 *   - backend  services/code-engine.js     → normalize/validate AI-provided geometry params
 *   - frontend services/templates-module.js → buildGeometry defaults + listGeometryTypes + param table
 *   - docs/api-reference.md §5 param table mirrors this
 *
 * Keep the param keys/defaults here in sync with the builders in templates-module.js.
 * Adding a new primitive: add an entry here, a builder in templates-module.js, and an API
 * method in code-engine.js.
 */

export const GEOMETRY_SCHEMA = {
  box: {
    params: [
      { key: 'width',  type: 'number', default: 1 },
      { key: 'height', type: 'number', default: 1 },
      { key: 'depth',  type: 'number', default: 1 },
    ],
  },
  sphere: {
    params: [
      { key: 'radius',         type: 'number', default: 1 },
      { key: 'widthSegments',  type: 'int',    default: 8 },
      { key: 'heightSegments', type: 'int',    default: 6 },
    ],
  },
  cylinder: {
    params: [
      { key: 'radiusTop',      type: 'number', default: 1 },
      { key: 'radiusBottom',   type: 'number', default: 1 },
      { key: 'height',         type: 'number', default: 1 },
      { key: 'radialSegments', type: 'int',    default: 8 },
    ],
  },
  cone: {
    params: [
      { key: 'radius',         type: 'number', default: 1 },
      { key: 'height',         type: 'number', default: 1 },
      { key: 'radialSegments', type: 'int',    default: 8 },
    ],
  },
  torus: {
    params: [
      { key: 'radius',          type: 'number', default: 1 },
      { key: 'tube',            type: 'number', default: 0.3 },
      { key: 'radialSegments',  type: 'int',    default: 8 },
      { key: 'tubularSegments', type: 'int',    default: 12 },
    ],
  },
  dodecahedron: {
    params: [
      { key: 'radius', type: 'number', default: 1 },
      { key: 'detail', type: 'int',    default: 0 },
    ],
  },
  icosahedron: {
    params: [
      { key: 'radius', type: 'number', default: 1 },
      { key: 'detail', type: 'int',    default: 0 },
    ],
  },
  octahedron: {
    params: [
      { key: 'radius', type: 'number', default: 1 },
      { key: 'detail', type: 'int',    default: 0 },
    ],
  },
  wedge: {
    params: [
      { key: 'width',  type: 'number', default: 1 },
      { key: 'height', type: 'number', default: 1 },
      { key: 'depth',  type: 'number', default: 1 },
    ],
  },
  tri: {
    params: [
      { key: 'a', type: 'vec3',   default: [0, 0, 0] },
      { key: 'b', type: 'vec3',   default: [1, 0, 0] },
      { key: 'c', type: 'vec3',   default: [0, 1, 0] },
      { key: 'd', type: 'number', default: 0 }, // thickness; >0 → triangular prism
    ],
  },
  patch: {
    params: [
      { key: 'vertices', type: 'numberArray', default: [] }, // flat [x,y,z, ...], 3 verts per triangle
      { key: 'd',        type: 'number',      default: 0 },  // thickness; >0 → offset both sides
    ],
  },
};

export const GEOMETRY_TYPES = Object.keys(GEOMETRY_SCHEMA);

/** Schema entry for a type (throws on unknown). */
export function getSchema(type) {
  const schema = GEOMETRY_SCHEMA[type];
  if (!schema) throw new Error(`Unknown mesh type: ${type}`);
  return schema;
}

/** Default params object for a type (plain key→value, arrays cloned). */
export function defaultParams(type) {
  const schema = getSchema(type);
  const out = {};
  for (const p of schema.params) out[p.key] = cloneDefault(p.default);
  return out;
}

/**
 * Fill missing params with schema defaults and coerce scalar types.
 * Unknown keys in `params` are dropped — only schema-defined params survive.
 * Returns a new object; never mutates the input.
 */
export function normalizeGeometryParams(type, params) {
  const schema = getSchema(type);
  const out = defaultParams(type);
  if (params) {
    for (const p of schema.params) {
      const v = params[p.key];
      if (v !== undefined && v !== null) out[p.key] = coerce(p.type, v);
    }
  }
  return out;
}

function cloneDefault(v) {
  return Array.isArray(v) ? v.slice() : v;
}

function coerce(type, v) {
  if (type === 'int')    return Math.trunc(Number(v)) || 0;
  if (type === 'number') return Number(v) || 0;
  return v; // vec3 / numberArray — pass through; builders construct their own buffers
}

