/**
 * templates-module.js — Single Source of Truth
 *
 * Served to the browser at GET /api/templates/module.js.
 * Frontend dynamically imports this to get all animation templates
 * and geometry builders. Add new templates/mesh types HERE only.
 *
 * THREE injection (v2): prefer runtime.create({ THREE }) to bind a THREE
 * instance. For backward compatibility, the module also captures
 * globalThis.THREE at load (legacy frontends set window.THREE before import).
 */

import { GEOMETRY_TYPES, normalizeGeometryParams } from './geometry-schema.js';
import { applyWorldTemplates, ensureWorldObb } from './world-anim-core.js';
import { computeAllOBB } from './obb.js';

// THREE binding — override via create({ THREE }); defaults to global (legacy).
let THREE = (typeof globalThis !== 'undefined' && globalThis.THREE) || null;

/* ═══════════════ Internal helpers ═══════════════ */
function loopFreq(freq, duration) {
  const cycles = Math.max(1, Math.round(freq * duration));
  return cycles / duration;
}
function easeIn(t)  { return t * t; }
function easeOut(t) { return 1 - (1 - t) * (1 - t); }

/** Accumulate world-space quaternion of parent chain (root → parent of groupId).
 *  @param {Object|null} motionResult — evaluateMotion result for current motion, or null for rest pose */
function _chainWorldQuat(lookups, groupId, motionResult) {
  const Q = THREE.Quaternion, E = THREE.Euler;
  const group = lookups?.getPart?.(groupId);
  if (!group || !group.parent) return new Q();
  const chain = [];
  let current = lookups.getPart(group.parent);
  while (current) {
    chain.unshift(current);
    current = current.parent ? lookups.getPart(current.parent) : null;
  }
  const worldQ = new Q();
  for (const p of chain) {
    if (p.quaternion && !motionResult) {
      worldQ.multiply(new Q(p.quaternion.x, p.quaternion.y, p.quaternion.z, p.quaternion.w));
    } else {
      let rx = p.rotation?.x || 0, ry = p.rotation?.y || 0, rz = p.rotation?.z || 0;
      if (motionResult && motionResult[p.id]?.rotation) {
        const mo = motionResult[p.id].rotation;
        rx += mo[0]; ry += mo[1]; rz += mo[2];
      }
      worldQ.multiply(new Q().setFromEuler(new E(rx, ry, rz, 'XYZ')));
    }
  }
  return worldQ;
}

/* ═══════════════ Animation Templates ═══════════════ */
const ANIMATION_TEMPLATES = {
  bounce: {
    label: '弹跳',
    params: [
      { key: 'amplitude', type: 'float', min: -1.0, max: 1.0, default: 0.2, curve: 2.5 },
      { key: 'frequency', type: 'float', min: 0.01, max: 5.0, default: 2, curve: 3.5 },
    ],
    evaluate(p, t, duration) {
      const amp = p.amplitude || 0.2;
      const freq = loopFreq(p.frequency || 2, duration);
      return { position: [0, Math.sin(t * freq * Math.PI * 2) * amp, 0] };
    }
  },

  slide: {
    label: '滑动',
    params: [
      { key: 'axis',      type: 'select', options: ['x','y','z'], default: 'y' },
      { key: 'distance',  type: 'float',  min: 0.1, max: 10.0, default: 1, curve: 2.5 },
      { key: 'frequency', type: 'float',  min: 0.01, max: 5.0, default: 1, curve: 3.5 },
      { key: 'phase',     type: 'float',  min: 0, max: 1, step: 0.05, default: 0 },
    ],
    evaluate(p, t, duration) {
      const axis = p.axis || 'y';
      const dist = p.distance || 1;
      const freq = p.frequency || 1;
      const phase = p.phase || 0;
      // Triangle wave: 0 → +dist → 0 → -dist → 0 (linear back-and-forth)
      const tp = ((t * freq + phase + 0.25) % 1 + 1) % 1; // phase, start at 0 going up
      const tri = 1 - 4 * Math.abs(tp - 0.5); // -1 to +1 triangle
      const raw = tri * dist;
      const val = [0, 0, 0];
      val[axis === 'x' ? 0 : axis === 'y' ? 1 : 2] = raw;
      return { position: val };
    }
  },

  swing: {
    label: '摆动',
    params: [
      { key: 'axis',      type: 'select', options: ['x','y','z'], default: 'x' },
      { key: 'amplitude', type: 'float',  min: -2.0, max: 2.0, default: 0.5, curve: 2.5 },
      { key: 'frequency', type: 'float',  min: 0.01, max: 5.0, default: 1, curve: 3.5 },
      { key: 'phase',     type: 'float',  min: 0, max: 1, step: 0.05, default: 0 },
    ],
    evaluate(p, t, duration) {
      const axis = p.axis || 'x';
      const raw = Math.sin((t * loopFreq(p.frequency||1, duration) + (p.phase||0)) * Math.PI * 2) * (p.amplitude||0.5) * (Math.PI/3);
      const val = [0,0,0]; val[axis==='x'?0:axis==='y'?1:2] = raw;
      return { rotation: val };
    }
  },

  sway: {
    label: '轻摆',
    params: [
      { key: 'axis',      type: 'select', options: ['x','y','z'], default: 'z' },
      { key: 'amplitude', type: 'float',  min: -1.0, max: 1.0, default: 0.3, curve: 2.5 },
      { key: 'frequency', type: 'float',  min: 0.01, max: 5.0, default: 1, curve: 3.5 },
      { key: 'phase',     type: 'float',  min: 0, max: 1, step: 0.05, default: 0 },
    ],
    evaluate(p, t, duration) {
      const axis = p.axis || 'z';
      const raw = Math.sin((t * loopFreq(p.frequency||1, duration) + (p.phase||0)) * Math.PI * 2) * (p.amplitude||0.3) * (Math.PI/3);
      const val = [0,0,0]; val[axis==='x'?0:axis==='y'?1:2] = raw;
      return { rotation: val };
    }
  },

  breathe: {
    label: '呼吸',
    params: [
      { key: 'amplitude', type: 'float', min: -0.1, max: 0.1, default: 0.02, curve: 2.5 },
      { key: 'frequency', type: 'float', min: 0.01, max: 2.0, default: 0.5, curve: 3.5 },
    ],
    evaluate(p, t, duration) {
      const amp = p.amplitude || 0.02;
      const freq = loopFreq(p.frequency || 0.5, duration);
      const s = 1 + Math.sin(t * freq * Math.PI * 2) * amp;
      return { scale: [s, s, s] };
    }
  },

  wave: {
    label: '波浪',
    params: [
      { key: 'amplitude', type: 'float', min: -0.5, max: 0.5, default: 0.2, curve: 2.5 },
      { key: 'frequency', type: 'float', min: 0.01, max: 3.0, default: 1.5, curve: 3.5 },
      { key: 'delay',     type: 'float', min: 0, max: 0.3, step: 0.01, default: 0.08 },
    ],
    evaluate(p, t, duration, groupId, lookups) {
      const amp = p.amplitude || 0.2;
      const freq = loopFreq(p.frequency || 1.5, duration);
      const delay = p.delay || 0.08;
      if (!lookups || !lookups.getPart || !lookups.getChildren) return {};
      const chainGroup = lookups.getPart(groupId);
      if (!chainGroup) return {};
      const wpIds = lookups.getChildren(groupId).filter(c => c.isGroup).map(c => c.id);
      if (wpIds.length < 2) return {};
      const result = {};
      wpIds.forEach((wpId, i) => {
        const raw = Math.sin((t * freq - i * delay / duration) * Math.PI * 2) * amp;
        result[wpId] = { position: [0, raw, 0] };
      });
      return result;
    }
  },

  drop: {
    label: '坠落',
    params: [
      { key: 'amplitude', type: 'float', min: 0, max: 3.0, default: 0.5, curve: 2.5 },
      { key: 'axis',      type: 'select', options: ['x','y','z'], default: 'y' },
      { key: 'bounce',    type: 'float', min: 0, max: 1.0, default: 0.1 },
    ],
    evaluate(p, t, duration) {
      const amp = p.amplitude || 0.5;
      const axis = p.axis || 'y';
      const bounce = p.bounce || 0.1;
      const idx = axis==='x'?0:axis==='y'?1:2;
      const val = [0,0,0];
      const fallEnd = duration * 0.3;
      const settleEnd = duration * 0.5;
      if (t <= fallEnd)       { val[idx] = -amp * easeIn(t / fallEnd); }
      else if (t <= settleEnd) { val[idx] = -amp + bounce * easeOut((t-fallEnd)/(settleEnd-fallEnd)); }
      else                     { val[idx] = -amp + bounce; }
      return { position: val };
    }
  },

  impulse: {
    label: '冲击',
    params: [
      { key: 'amplitude', type: 'float', min: -2.0, max: 2.0, default: 0.5, curve: 2.5 },
      { key: 'axis',      type: 'select', options: ['x','y','z'], default: 'y' },
    ],
    evaluate(p, t, duration) {
      const amp = p.amplitude || 0.5;
      const axis = p.axis || 'y';
      const idx = axis==='x'?0:axis==='y'?1:2;
      const val = [0,0,0];
      const peakTime = duration * 0.2;
      if (t <= peakTime) val[idx] = amp * easeOut(t / peakTime);
      else               val[idx] = amp * (1 - easeIn((t-peakTime)/(duration-peakTime)));
      return { position: val };
    }
  },

  launch: {
    label: '发射',
    params: [
      { key: 'axis',  type: 'select', options: ['x','y','z'], default: 'z' },
      { key: 'speed', type: 'float',  min: 0.5, max: 50.0, default: 8, curve: 2.0 },
      { key: 'decel', type: 'float',  min: 0, max: 5.0, default: 1.5, step: 0.1, note: '0=匀速 1.5=默认 5=急减速' },
    ],
    evaluate(p, t, duration) {
      const axis = p.axis || 'z';
      const speed = p.speed || 8;
      const decel = p.decel ?? 1.5;
      const idx = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
      const val = [0, 0, 0];
      const td = Math.max(duration, 0.01);
      const ct = Math.min(t, td);
      // Power-law deceleration: velocity = speed * (1 - t/d)^decel
      // position = speed * td * (1 - (1 - t/d)^(decel+1)) / (decel+1)
      const x = ct / td;
      const exp = decel + 1;
      val[idx] = speed * td * (1 - Math.pow(1 - x, exp)) / exp;
      return { position: val };
    }
  },

  dash: {
    label: '冲刺',
    params: [
      { key: 'axis',  type: 'select', options: ['x','y','z'], default: 'z' },
      { key: 'speed', type: 'float',  min: 0.5, max: 50.0, default: 8, curve: 2.0 },
    ],
    evaluate(p, t, duration) {
      const axis = p.axis || 'z';
      const speed = p.speed || 8;
      const idx = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
      const val = [0, 0, 0];
      const td = Math.max(duration, 0.01);
      const ct = Math.min(t, td);
      val[idx] = speed * ct; // constant speed, no deceleration
      return { position: val };
    }
  },

  slash: {
    label: '挥砍',
    params: [
      { key: 'axis',      type: 'select', options: ['x','y','z'], default: 'x' },
      { key: 'amplitude', type: 'float',  min: -3.0, max: 3.0, default: 0.8, curve: 2.0 },
      { key: 'speed',     type: 'float',  min: 0.5, max: 20.0, default: 4, step: 0.5, note: '挥砍速度，越快越猛' },
    ],
    evaluate(p, t, duration) {
      const axis = p.axis || 'x';
      const amp = (p.amplitude || 0.8) * (Math.PI / 3);
      const speed = p.speed || 4;
      const idx = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
      const val = [0, 0, 0];
      // Slash ignores duration — progress is t * speed, clamped to full arc
      const progress = Math.min(t * speed, 1);
      val[idx] = amp * (1 - Math.cos(Math.PI / 2 * progress));
      return { rotation: val };
    }
  },

  spin: {
    label: '旋转',
    params: [
      { key: 'axis',      type: 'select', options: ['x','y','z'], default: 'y' },
      { key: 'frequency', type: 'float',  min: 0.1, max: 10.0, default: 1, curve: 2.0 },
      { key: 'direction', type: 'select', options: ['cw','ccw'], default: 'cw' },
    ],
    evaluate(p, t, duration) {
      const axis = p.axis || 'y';
      const freq = loopFreq(p.frequency || p.speed || 1, duration);
      const dir = (p.direction === 'ccw') ? -1 : 1;
      const raw = t * freq * Math.PI * 2 * dir;
      const val = [0, 0, 0];
      val[axis === 'x' ? 0 : axis === 'y' ? 1 : 2] = raw;
      return { rotation: val };
    }
  },

  pointTo: {
    label: '指向',
    params: [
      { key: 'axis',       type: 'select', options: ['x','y','z'], default: 'x' },
      { key: 'angle',      type: 'float',  min: -180, max: 180, default: 15 },
      { key: 'lockWorldRot', type: 'bool', default: false },
    ],
    evaluate(p, t, duration, groupId, lookups) {
      const axis = p.axis || 'x';
      const target = (p.angle || 0) * Math.PI / 180;
      const idx = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;


      const val = [0, 0, 0];
      val[idx] = target;
      return { rotation: val };
    }
  },

  // ── 世界坐标模板（求值核：./world-anim-core.js，浏览器经
  //    GET /templates/world-anim-core.js 以原生 ESM sibling 加载）──
  aimSeq: {
    label: '世界目标时序指向',
    params: [
      // keys/target: 非滑杆参数，由 LLM/prompt 提供，此处不列
      { key: 'amount', type: 'float', min: 0, max: 1, default: 1, step: 0.05, note: '到位程度' },
    ],
    evaluate() { return {}; } // handled in post-processing (world-anim-core)
  },

  sweep: {
    label: '世界弧线挥砍',
    params: [
      { key: 'speed',  type: 'float', min: 0.5, max: 20, default: 4, note: '起手+挥击各占 1/speed 秒' },
      { key: 'amount', type: 'float', min: 0, max: 1, default: 1, step: 0.05, note: '到位程度' },
      // from/to/via: 世界点引用（[x,y,z] 或 {group,offset}），非滑杆参数
    ],
    evaluate() { return {}; } // handled in post-processing (world-anim-core)
  },

  shift: {
    label: '位移',
    params: [
      { key: 'axis',     type: 'select', options: ['x','y','z'], default: 'y' },
      { key: 'distance', type: 'float',  min: -10, max: 10, default: 1, curve: 2.0 },
    ],
    evaluate(p, t, duration) {
      const axis = p.axis || 'y';
      const dist = p.distance || 0;
      const val = [0, 0, 0];
      val[axis === 'x' ? 0 : axis === 'y' ? 1 : 2] = dist;
      return { position: val };
    }
  },

  squash: {
    label: '挤压',
    params: [
      { key: 'axis',   type: 'select', options: ['x','y','z'], default: 'y' },
      { key: 'amount', type: 'float',  min: 0.1, max: 3.0, default: 1.5, curve: 2.0 },
    ],
    evaluate(p, t, duration) {
      const axis = p.axis || 'y';
      const amount = p.amount ?? 1;
      const s = [1, 1, 1];
      s[axis === 'x' ? 0 : axis === 'y' ? 1 : 2] = amount;
      return { scale: s };
    }
  },

  // ── Emit (particle) ── flat param keys for slider editing; ParticleSystem reads nested format
  emit: {
    label: '粒子',
    params: [
      { key: 'rate',       type: 'float', min: 1, max: 100, default: 15, curve: 2.0 },
      { key: 'lifetimeMin', type: 'float', min: 0.1, max: 3.0, default: 0.5 },
      { key: 'lifetimeMax', type: 'float', min: 0.3, max: 5.0, default: 1.5 },
      { key: 'velDirX',    type: 'float', min: -1, max: 1, default: 0 },
      { key: 'velDirY',    type: 'float', min: -1, max: 1, default: 1 },
      { key: 'velDirZ',    type: 'float', min: -1, max: 1, default: 0 },
      { key: 'velSpeedMin', type: 'float', min: 0.1, max: 10, default: 1 },
      { key: 'velSpeedMax', type: 'float', min: 0.5, max: 20, default: 3 },
      { key: 'velSpread',  type: 'float', min: 0, max: 2, default: 0.3 },
      { key: 'accelX',     type: 'float', min: -20, max: 20, default: 0 },
      { key: 'accelY',     type: 'float', min: -20, max: 20, default: -2 },
      { key: 'accelZ',     type: 'float', min: -20, max: 20, default: 0 },
      { key: 'offsetX',    type: 'float', min: -2, max: 2, default: 0 },
      { key: 'offsetY',    type: 'float', min: -2, max: 2, default: 0 },
      { key: 'offsetZ',    type: 'float', min: -2, max: 2, default: 0 },
      { key: 'emitMode',    type: 'select', options: ['point','volume'], default: 'point' },
      { key: 'mesh',       type: 'select', options: ['sphere','box'], default: 'sphere' },
      { key: 'meshSize',   type: 'float', min: 0.02, max: 1.0, default: 0.4 },
      { key: 'colorStartR', type: 'float', min: 0, max: 1, default: 1, step: 0.01 },
      { key: 'colorStartG', type: 'float', min: 0, max: 1, default: 0.8, step: 0.01 },
      { key: 'colorStartB', type: 'float', min: 0, max: 1, default: 0.2, step: 0.01 },
      { key: 'colorEndR',  type: 'float', min: 0, max: 1, default: 0.5, step: 0.01 },
      { key: 'colorEndG',  type: 'float', min: 0, max: 1, default: 0, step: 0.01 },
      { key: 'colorEndB',  type: 'float', min: 0, max: 1, default: 0, step: 0.01 },
      { key: 'scaleStart', type: 'float', min: 0, max: 3, default: 1, step: 0.1 },
      { key: 'scaleEnd',   type: 'float', min: 0.1, max: 3, default: 0.3, step: 0.1 },
    ],
    evaluate(p, t, duration) {
      return {}; // no transforms — ParticleSystem handles rendering
    }
  },

  // ── VFX (preset-based, vocabulary-driven) ── 新系统,与 emit 并存(向后兼容)
  // 词表通过 request body 的 vfxTags 传入,buildVfxPrompt 注入 prompt
  // 数据流:group.vfx → 前端 ParticleCompanion.createParticleEffect({attachTo}, {preset, overrides})
  vfx: {
    label: 'VFX (词汇表)',
    params: [
      { key: 'preset', type: 'string', default: '', description: '词表预设名(flame/smoke/hit_spark/...)' },
      { key: 'params', type: 'object', default: {} },
    ],
    evaluate(p, t, duration) {
      return {}; // no transforms — 前端 VFX 系统按 baked.vfx 字段渲染
    }
  },

  lockWorldRot: {
    label: '锁定世界朝向',
    params: [
      { key: 'rotX', type: 'float', min: -3.2, max: 3.2, default: 0, step: 0.01 },
      { key: 'rotY', type: 'float', min: -3.2, max: 3.2, default: 0, step: 0.01 },
      { key: 'rotZ', type: 'float', min: -3.2, max: 3.2, default: 0, step: 0.01 },
    ],
    evaluate(p, t, duration) {
      return {}; // handled in post-processing
    }
  },
};

// ── Emit config flat ↔ nested conversion ──────────────────────────
function flattenEmitConfig(config) {
  const flat = {};
  flat.rate = config.rate ?? 15;
  flat.lifetimeMin = (config.lifetime || [0.5, 1.5])[0];
  flat.lifetimeMax = (config.lifetime || [0.5, 1.5])[1];
  const vel = config.velocity || {};
  flat.velDirX = (vel.dir || [0, 1, 0])[0];
  flat.velDirY = (vel.dir || [0, 1, 0])[1];
  flat.velDirZ = (vel.dir || [0, 1, 0])[2];
  flat.velSpeedMin = (vel.speed || [1, 3])[0];
  flat.velSpeedMax = (vel.speed || [1, 3])[1];
  flat.velSpread = vel.spread ?? 0.3;
  const accel = config.acceleration || [0, 0, 0];
  flat.accelX = accel[0];
  flat.accelY = accel[1];
  flat.accelZ = accel[2];
  const off = config.offset || [0, 0, 0];
  flat.offsetX = off[0];
  flat.offsetY = off[1];
  flat.offsetZ = off[2];
  flat.mesh = config.mesh || 'sphere';
  flat.meshSize = config.meshSize ?? 0.4;
  const cs = config.colorStart || [1, 0.8, 0.2];
  flat.colorStartR = cs[0];
  flat.colorStartG = cs[1];
  flat.colorStartB = cs[2];
  const ce = config.colorEnd || [0.5, 0, 0];
  flat.colorEndR = ce[0];
  flat.colorEndG = ce[1];
  flat.colorEndB = ce[2];
  flat.scaleStart = config.scaleStart ?? 1;
  flat.scaleEnd = config.scaleEnd ?? 0.3;
  flat.emitMode = config.emitMode || 'point';
  return flat;
}

function unflattenEmitConfig(flat) {
  return {
    rate: flat.rate ?? 15,
    emitMode: flat.emitMode || 'point',
    lifetime: [flat.lifetimeMin ?? 0.5, flat.lifetimeMax ?? 1.5],
    velocity: {
      dir: [flat.velDirX ?? 0, flat.velDirY ?? 1, flat.velDirZ ?? 0],
      speed: [flat.velSpeedMin ?? 1, flat.velSpeedMax ?? 3],
      spread: flat.velSpread ?? 0.3,
    },
    acceleration: [flat.accelX ?? 0, flat.accelY ?? -2, flat.accelZ ?? 0],
    offset: [flat.offsetX ?? 0, flat.offsetY ?? 0, flat.offsetZ ?? 0],
    mesh: flat.mesh || 'box',
    meshSize: flat.meshSize ?? 0.4,
    colorStart: [flat.colorStartR ?? 1, flat.colorStartG ?? 0.8, flat.colorStartB ?? 0.2],
    colorEnd: [flat.colorEndR ?? 0.5, flat.colorEndG ?? 0, flat.colorEndB ?? 0],
    scaleStart: flat.scaleStart ?? 1,
    scaleEnd: flat.scaleEnd ?? 0,
  };
}

/* ═══════════════ Geometry Builders ═══════════════ */
const GEOMETRY_BUILDERS = {
  box({ width, height, depth }) {
    return new THREE.BoxGeometry(width||1, height||1, depth||1, 1, 1, 1);
  },

  sphere({ radius, widthSegments, heightSegments }) {
    return new THREE.SphereGeometry(radius||1, widthSegments||8, heightSegments||6);
  },

  cylinder({ radiusTop, radiusBottom, height, radialSegments }) {
    return new THREE.CylinderGeometry(
      radiusTop ?? 1, radiusBottom ?? 1, height || 1, radialSegments || 8
    );
  },

  cone({ radius, height, radialSegments }) {
    return new THREE.ConeGeometry(radius||1, height||1, radialSegments||8);
  },

  torus({ radius, tube, radialSegments, tubularSegments }) {
    const geo = new THREE.TorusGeometry(radius||1, tube||0.3, radialSegments||8, tubularSegments||12);
    geo.rotateX(-Math.PI / 2);
    return geo;
  },

  dodecahedron({ radius, detail }) {
    return new THREE.DodecahedronGeometry(radius||1, detail||0);
  },

  icosahedron({ radius, detail }) {
    return new THREE.IcosahedronGeometry(radius||1, detail||0);
  },

  octahedron({ radius, detail }) {
    return new THREE.OctahedronGeometry(radius||1, detail||0);
  },

  wedge({ width, height, depth }) {
    const w = width || 1, h = height || 1, d = depth || 1;
    const shape = new THREE.Shape();
    shape.moveTo(-w/2, -h/2);
    shape.lineTo( w/2, -h/2);
    shape.lineTo(-w/2,  h/2);
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, { steps:1, depth:d, bevelEnabled:false });
    geo.translate(0, 0, -d/2);
    geo.computeVertexNormals();
    return geo;
  },

  tri({ a, b, c, d }) {
    const A = a || [0,0,0], B = b || [1,0,0], C = c || [0,1,0];
    const thickness = d || 0;
    if (thickness > 0) {
      const va = new THREE.Vector3(A[0],A[1],A[2]), vb = new THREE.Vector3(B[0],B[1],B[2]), vc = new THREE.Vector3(C[0],C[1],C[2]);
      const ab = new THREE.Vector3().subVectors(vb, va);
      const ac = new THREE.Vector3().subVectors(vc, va);
      const normal = new THREE.Vector3().crossVectors(ab, ac).normalize();
      const offset = normal.clone().multiplyScalar(thickness / 2);
      const fa = va.clone().add(offset), fb = vb.clone().add(offset), fc = vc.clone().add(offset);
      const ba = va.clone().sub(offset), bb = vb.clone().sub(offset), bc = vc.clone().sub(offset);
      const verts = new Float32Array([
        fa.x,fa.y,fa.z, fb.x,fb.y,fb.z, fc.x,fc.y,fc.z,
        ba.x,ba.y,ba.z, bc.x,bc.y,bc.z, bb.x,bb.y,bb.z,
        fa.x,fa.y,fa.z, ba.x,ba.y,ba.z, fb.x,fb.y,fb.z,
        fb.x,fb.y,fb.z, ba.x,ba.y,ba.z, bb.x,bb.y,bb.z,
        fb.x,fb.y,fb.z, bb.x,bb.y,bb.z, fc.x,fc.y,fc.z,
        fc.x,fc.y,fc.z, bb.x,bb.y,bb.z, bc.x,bc.y,bc.z,
        fc.x,fc.y,fc.z, bc.x,bc.y,bc.z, fa.x,fa.y,fa.z,
        fa.x,fa.y,fa.z, bc.x,bc.y,bc.z, ba.x,ba.y,ba.z,
      ]);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
      geo.computeVertexNormals();
      return geo;
    }
    const verts = new Float32Array([A[0],A[1],A[2], B[0],B[1],B[2], C[0],C[1],C[2]]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    geo.setIndex([0,1,2]);
    geo.computeVertexNormals();
    return geo;
  },

  patch({ vertices, d }) {
    const verts = vertices || [];
    const numVerts = verts.length / 3;
    if (numVerts < 3) return new THREE.BoxGeometry(1,1,1);
    const thickness = d || 0;
    if (thickness > 0) {
      const v0 = new THREE.Vector3(verts[0],verts[1],verts[2]);
      const v1 = new THREE.Vector3(verts[3],verts[4],verts[5]);
      const v2 = new THREE.Vector3(verts[6],verts[7],verts[8]);
      const ab = new THREE.Vector3().subVectors(v1, v0);
      const ac = new THREE.Vector3().subVectors(v2, v0);
      const normal = new THREE.Vector3().crossVectors(ab, ac);
      if (normal.lengthSq() < 1e-10) normal.set(0,1,0); else normal.normalize();
      const off = normal.clone().multiplyScalar(thickness/2);
      const front = [], back = [];
      for (let i = 0; i < numVerts; i++) {
        const x=verts[i*3], y=verts[i*3+1], z=verts[i*3+2];
        front.push(x+off.x, y+off.y, z+off.z);
        back.push(x-off.x, y-off.y, z-off.z);
      }
      const allVerts = new Float32Array([...front, ...back]);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(allVerts, 3));
      // Build indices: front face (fan), back face (reversed fan), side quads
      const indices = [];
      for (let i = 1; i < numVerts - 1; i++) indices.push(0, i, i+1);
      for (let i = 1; i < numVerts - 1; i++) indices.push(numVerts, numVerts+i+1, numVerts+i);
      for (let i = 0; i < numVerts; i++) {
        const j = (i+1) % numVerts;
        const a = i, b = j, c = numVerts + i, d = numVerts + j;
        indices.push(a,b,d, a,d,c);
      }
      geo.setIndex(indices);
      geo.computeVertexNormals();
      return geo;
    }
    // Zero-thickness patch: vertices stored as consecutive triplets (v0,v1,v2 per triangle).
    // No index buffer — Three.js implicitly treats every 3 positions as a triangle.
    // This matches CodeEngine output and tolerates vertex reordering (e.g. by mirror).
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
    geo.computeVertexNormals();
    return geo;
  },
};

/* ═══════════════ Public API ═══════════════ */
export const voxelStudioRuntime = {
  /** Get all animation templates (metadata + isLooping flag) */
  listAnimationTemplates() {
    const looping = new Set(['bounce','slide','swing','sway','breathe','wave','spin']);
    return Object.entries(ANIMATION_TEMPLATES).map(([key, t]) => ({
      key, label: t.label, params: t.params, isLooping: looping.has(key)
    }));
  },
  /** Convert nested emit config → flat keys for slider editing */
  flattenEmitConfig,
  /** Convert flat slider keys → nested emit config for storage / ParticleSystem */
  unflattenEmitConfig,

  /** Evaluate a full Motion Plan at time t.
   *  v2 signature: evaluateMotion(plan, duration, t, lookups?)
   *    lookups (optional): { getPart(id), getChildren(id) } — decouples the
   *    runtime from any specific model API. Templates that need structural
   *    info (wave/pointTo) read from lookups; without it they no-op.
   *  Legacy signature still accepted: evaluateMotion(plan, duration, model, t). */
  evaluateMotion(plan, duration, a, b) {
    // Distinguish v2 (a = t:number) from legacy (a = model:object).
    const t = typeof a === 'number' ? a : b;
    const lookups = typeof a === 'number' ? b : a;
    const result = {};
    for (const [groupId, motions] of Object.entries(plan)) {
      if (groupId.startsWith('_')) continue;
      const entry = { position: [0,0,0], rotation: [0,0,0], scale: null };
      for (const [tplName, paramValue] of Object.entries(motions)) {
        if (tplName === '_attach') continue;
        if (tplName === 'emit' || tplName === 'vfx') continue;  // particle/vfx systems, no transforms
        const tpl = ANIMATION_TEMPLATES[tplName];
        if (!tpl) continue;
        const paramSets = Array.isArray(paramValue) ? paramValue : [paramValue];
        for (const p of paramSets) {
          const pt0 = p._t0 != null ? p._t0 : 0;
          const pt1 = p._t1 != null ? p._t1 : duration;
          if (t < pt0 - 0.0001 || t > pt1 + 0.0001) continue;
          const tr = tpl.evaluate(p, t, duration, groupId, lookups || null);
          // Check for per-child expansion (templates like wave-on-group)
          const childKeys = Object.keys(tr).filter(k => !['position','rotation','scale'].includes(k) && !k.startsWith('_'));
          if (childKeys.length > 0) {
            for (const childId of childKeys) {
              if (!result[childId]) result[childId] = { position: [0,0,0], rotation: [0,0,0], scale: null };
              const ct = tr[childId];
              if (ct.position) { for (let j=0;j<3;j++) result[childId].position[j] += ct.position[j]; }
              if (ct.rotation) { for (let j=0;j<3;j++) result[childId].rotation[j] += ct.rotation[j]; }
              if (ct.scale) result[childId].scale = ct.scale;
            }
          } else {
            if (tr.position) { for (let j=0;j<3;j++) entry.position[j] += tr.position[j]; }
            if (tr.rotation) { for (let j=0;j<3;j++) entry.rotation[j] += tr.rotation[j]; }
            if (tr.scale) entry.scale = tr.scale;
          }
        }
      }
      result[groupId] = entry;
    }

    // Post-processing: pointTo lockWorldRot — counter parent motion
    for (const [groupId, motions] of Object.entries(plan)) {
      if (groupId.startsWith('_')) continue;
      const pt = motions.pointTo;
      if (!pt) continue;
      const paramSets = Array.isArray(pt) ? pt : [pt];
      for (const p of paramSets) {
        if (!p.lockWorldRot) continue;
        const axis = p.axis || 'x';
        const angle = (p.angle || 0) * Math.PI / 180;
        const idx = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
        const Q = THREE.Quaternion, E = THREE.Euler;
        const part = lookups?.getPart?.(groupId);
        if (!part) continue;
        const baseRot = [part.rotation?.x || 0, part.rotation?.y || 0, part.rotation?.z || 0];
        // Compute part's rest-pose world orientation
        const Q_parent_rest = _chainWorldQuat(lookups, groupId, null);
        const Q_base = new Q().setFromEuler(new E(baseRot[0], baseRot[1], baseRot[2], 'XYZ'));
        const Q_rest_world = Q_parent_rest.clone().multiply(Q_base);
        // Replace locked axis with target angle, keep other axes from rest pose
        const restEuler = new E().setFromQuaternion(Q_rest_world, 'YXZ');
        const targetWorldEuler = [restEuler.x, restEuler.y, restEuler.z];
        targetWorldEuler[idx] = angle;
        const Q_target_world = new Q().setFromEuler(new E(targetWorldEuler[0], targetWorldEuler[1], targetWorldEuler[2], 'XYZ'));
        // Convert to local given current parent motion
        const Q_parent_motion = _chainWorldQuat(lookups, groupId, result);
        const Q_local = Q_parent_motion.clone().invert().multiply(Q_target_world);
        const localEuler = new E().setFromQuaternion(Q_local, 'YXZ');
        if (!result[groupId]) result[groupId] = { position: [0,0,0], rotation: [0,0,0], scale: null };
        result[groupId].rotation = [
          localEuler.x - baseRot[0],
          localEuler.y - baseRot[1],
          localEuler.z - baseRot[2],
        ];
      }
    }

    // Post-processing: lockWorldRot — counter-rotate to maintain world-space orientation
    for (const [groupId, motions] of Object.entries(plan)) {
      if (groupId.startsWith('_')) continue;
      const lwr = motions.lockWorldRot;
      if (!lwr) continue;
      const paramSets = Array.isArray(lwr) ? lwr : [lwr];
      for (const p of paramSets) {
        const Q = THREE.Quaternion, E = THREE.Euler;
        const part = lookups?.getPart?.(groupId);
        if (!part) continue;
        const baseRot = [part.rotation?.x || 0, part.rotation?.y || 0, part.rotation?.z || 0];
        // Target world rotation: use specified axes, keep rest-pose for others
        const Q_parent_rest = _chainWorldQuat(lookups, groupId, null);
        const Q_base = new Q().setFromEuler(new E(baseRot[0], baseRot[1], baseRot[2], 'XYZ'));
        const Q_rest_world = Q_parent_rest.clone().multiply(Q_base);
        const restEuler = new E().setFromQuaternion(Q_rest_world, 'YXZ');
        const targetEuler = [
          p.rotX !== undefined ? (p.rotX || 0) : restEuler.x,
          p.rotY !== undefined ? (p.rotY || 0) : restEuler.y,
          p.rotZ !== undefined ? (p.rotZ || 0) : restEuler.z,
        ];
        const Q_target = new Q().setFromEuler(new E(targetEuler[0], targetEuler[1], targetEuler[2], 'XYZ'));
        // Convert to local given current parent motion
        const Q_parent_motion = _chainWorldQuat(lookups, groupId, result);
        const Q_local = Q_parent_motion.clone().invert().multiply(Q_target);
        const localEuler = new E().setFromQuaternion(Q_local, 'YXZ');
        if (!result[groupId]) result[groupId] = { position: [0,0,0], rotation: [0,0,0], scale: null };
        result[groupId].rotation = [
          localEuler.x - baseRot[0],
          localEuler.y - baseRot[1],
          localEuler.z - baseRot[2],
        ];
      }
    }

    // ★ 世界坐标模板后处理：aimSeq / sweep（与后端 motion-expander 共享
    //    world-anim-core.js 求值核——双端一致性由构造保证）。
    //    放在 lockWorldRot 之后 —— 世界模板接管该组旋转通道。
    try {
      ensureWorldObb(plan, lookups || null, computeAllOBB);
      applyWorldTemplates(plan, duration, t, result, lookups || null,
        (stripped, tt) => voxelStudioRuntime.evaluateMotion(stripped, duration, tt, lookups || null));
    } catch (e) { /* 世界模板失败不拖垮常规模板 */ }

    result._attachMap = {};
    for (const [gid, m] of Object.entries(plan)) { if (m._attach) result._attachMap[gid] = m._attach; }
    return result;
  },

  /** Evaluate a single template at time t (for canvas preview) */
  evaluateTemplate(name, params, t, duration) {
    const tpl = ANIMATION_TEMPLATES[name];
    if (!tpl) return { position: [0,0,0] };
    return tpl.evaluate(params, t, duration);
  },

  /** Standard edit API — all frontends record edits using these */
  listEditActions() {
    return [
      { method: 'setProp',    params: ['target', 'key', 'value'],   note: 'Change part property (color/name/locked)' },
      { method: 'setOffset',  params: ['target', 'x', 'y', 'z'],   note: 'Move part to new position' },
      { method: 'setRotation',params: ['target', 'rx','ry','rz'], note: 'Rotate part' },
      { method: 'addPart',    params: ['type','parent','geometry','pos','color'], note: 'Add mesh part (type: box/sphere/cyl/cone/torus/ico/wedge/tri/patch)' },
      { method: 'removePart', params: ['target'], note: 'Delete a part' },
      { method: 'reparent',  params: ['target', 'newParent'], note: 'Change parent group' },
    ];
  },

  /** List all known geometry types */
  listGeometryTypes() { return GEOMETRY_TYPES; },


  /** Build a Three.js geometry for the given mesh type */
  buildGeometry(type, params) {
    const builder = GEOMETRY_BUILDERS[type];
    if (!builder) throw new Error(`Unknown mesh type: ${type}`);
    return builder(normalizeGeometryParams(type, params));
  },
};

/**
 * THREE injection factory (v2). Binds a THREE instance so renderers need not
 * set window.THREE. Returns the shared runtime (its geometry builders read the
 * bound THREE).
 *
 *   const runtime = (await import('/api/templates/module.js')).create({ THREE });
 *
 * Legacy: if never called, builders fall back to globalThis.THREE captured at load.
 */
export function create({ THREE: injected } = {}) {
  if (injected) THREE = injected;
  return voxelStudioRuntime;
}

