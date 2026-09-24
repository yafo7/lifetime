/**
 * world-anim-core.js — 世界坐标动画模板共享求值核（aimSeq / sweep）
 *
 * 被 two 处消费，务必保持零依赖（无 THREE、无 node API）：
 *   - services/motion-expander.js   （后端 evaluateAt：bake / 校验 / transfer）
 *   - services/templates-module.js  （浏览器运行时 evaluateMotion）
 *   浏览器经 GET /templates/world-anim-core.js 以原生 ESM 加载（sibling 路由，
 *   同 geometry-schema.js 先例）。双端调用同一个 applyWorldTemplates ——
 *   一致性由构造保证，不允许出现第二份实现。
 *
 * 设计契约（快照时代的世界坐标语言）：
 *   - LLM 不写 axis+angle。LLM 从语义快照里抄**世界坐标**（@p / M: 端点 /
 *     功能端代表），只声明「末端在何时应指向哪个世界点」；引擎逐帧解算。
 *   - pointTo/aimEnd 是"局部角度"语言：角度相对静止姿态，父级一动就错位，
 *     且 LLM 对绕轴旋转的几何效果没有直觉（rootcause 报告 RC1/RC5）。
 *     本核的世界模板：引擎用父链**当前**世界变换反解局部 Δ —— 父级（身体/
 *     手臂）怎么动都自动补偿，指向在世界里保持。
 *   - Δ 输出口径沿用 lockWorldRot 后处理约定：算出「总目标局部四元数」→
 *     XYZ 欧拉 → 分量减 baseEuler。前端按 base+Δ 相加即精确还原目标姿态。
 *   - baseEuler 对带 rest quaternion 的节点取 quatToEuler(quaternion)——与前端
 *     basePose 捕获逻辑一致；无 quat 的节点用 rotation 字段。
 *
 * 模板语义：
 *   aimSeq { keys:[{t,target,ease?}], amount? }
 *     — 末端沿时间轴依次指向一串世界点。keys 按时刻排序；两 key 之间对
 *       目标**方向**做 slerp（ease 作用于该段）；末 key 之后保持；首 key 之前
 *       从静止末端方向平滑过渡到首目标（消除开场跳变）。单 key = 静态指向
 *       （自带 0.3s 起始过渡），即旧 aimAt 的语义。
 *   sweep  { from, to, via?, speed?, amount? }
 *     — 起手（rest→from 方向）+ 挥击（from→to 世界大弧，cos 缓动），到点停住。
 *       via 为途经方向点（挥击弧绕开躯干用）。
 *
 *   target/from/to/via 的每一项都是「世界点引用」：
 *     [x,y,z]                          绝对世界坐标（快照坐标即世界坐标，直接抄）
 *     { group:"gid", offset:[x,y,z] }  某组轴心当前世界位置 + 偏移；逐帧重解
 *                                      → 目标组在动（挥动的手/移动的载具）也跟得上
 */

// ═══════════════════════════ 四元数工具 [x,y,z,w] ═══════════════════════════

const ID_Q = [0, 0, 0, 1];

function mulQ(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

function invQ(q) { return [-q[0], -q[1], -q[2], q[3]]; }

function applyQ(q, v) {
  const [qx, qy, qz, qw] = q, [vx, vy, vz] = v;
  const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx);
  return [
    vx + qw * tx + (qy * tz - qz * ty),
    vy + qw * ty + (qz * tx - qx * tz),
    vz + qw * tz + (qx * ty - qy * tx),
  ];
}

/** XYZ 欧拉 → 四元数（与 Three.js Euler 默认 'XYZ' 序一致） */
function quatFromEulerXYZ(rx, ry, rz) {
  const c1 = Math.cos(rx / 2), s1 = Math.sin(rx / 2);
  const c2 = Math.cos(ry / 2), s2 = Math.sin(ry / 2);
  const c3 = Math.cos(rz / 2), s3 = Math.sin(rz / 2);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
}

/** 四元数 → XYZ 欧拉 */
function quatToEulerXYZ(q) {
  const { 0: x, 1: y, 2: z, 3: w } = q;
  const m13 = 2 * (x * z + w * y);
  const m23 = 2 * (y * z - w * x);
  const m33 = 1 - 2 * (x * x + y * y);
  const m12 = 2 * (x * y - w * z);
  const m11 = 1 - 2 * (y * y + z * z);
  if (Math.abs(m13) < 0.9999999) {
    return [
      Math.atan2(-m23, m33),
      Math.asin(Math.max(-1, Math.min(1, m13))),
      Math.atan2(-m12, m11),
    ];
  }
  return [
    Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + z * z)),
    Math.sign(m13) * Math.PI / 2,
    0,
  ];
}

/**
 * 单位向量 a → b 的最短弧四元数。
 * ★ 轴退化处理（平滑性关键）：旋转轴 = a×b，其长度 = sin(夹角)。当 |a×b| < 0.05
 * （近平行或近反向）时轴向是数值噪声——若此刻夹角≈180°，噪声×180° 会造成逐帧
 * 姿态疯狂翻转（锤柄从"朝上"转向"朝下"的动画必经此区）。近反向时改用**稳定
 * 垂直轴**（由 a 与固定参考轴确定，与帧无关），穿过退化区的弧连续且确定。
 */
function quatBetween(a, b) {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (dot > 0.99999) return [...ID_Q];
  const cx = a[1] * b[2] - a[2] * b[1];
  const cy = a[2] * b[0] - a[0] * b[2];
  const cz = a[0] * b[1] - a[1] * b[0];
  const axisLen = Math.hypot(cx, cy, cz);
  const PI = Math.PI;
  if (dot < -0.9) {
    // 近反向区：叉积轴随 b 穿过反极点快速翻转。用「稳定垂直轴」连续混合——
    // dot∈[-0.9,-1] 按比例混入稳定轴（只依赖 a），阈值两侧无跳变。
    const ref = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    let px = ref[1] * a[2] - ref[2] * a[1];
    let py = ref[2] * a[0] - ref[0] * a[2];
    let pz = ref[0] * a[1] - ref[1] * a[0];
    let pl = Math.hypot(px, py, pz) || 1;
    px /= pl; py /= pl; pz /= pl;
    let ax = cx, ay = cy, az = cz;
    if (axisLen > 1e-9) { ax /= axisLen; ay /= axisLen; az /= axisLen; }
    else { ax = px; ay = py; az = pz; }
    const k = Math.min(1, (-dot - 0.9) / 0.1);        // 0→1 连续
    const w = k * k * (3 - 2 * k);
    let nx = ax + (px - ax) * w, ny = ay + (py - ay) * w, nz = az + (pz - az) * w;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    // 混合轴下的角：保持把 a 转到 b 的分量正确 → 用点积恢复有效角
    const cosAng = Math.max(-1, Math.min(1, dot));
    const ang = Math.acos(cosAng);
    const half = Math.sin(ang / 2);
    return [nx * half, ny * half, nz * half, Math.cos(ang / 2)];
  }
  const raw = [cx, cy, cz, 1 + dot];
  const len = Math.hypot(raw[0], raw[1], raw[2], raw[3]);
  return raw.map(v => v / len);
}

/** 旋转角缩放 k 倍（轴不变）—— aimSeq/sweep 的 amount 到位程度用 */
/** 四元数 slerp（最短路），t 钳制到 [0,1]——anticipate 等缓动的负值段在
 *  大角度修正量上外推无界（150°修正×负外推=瞬跳），只保留 [0,1] 内插值 */
function qSlerp(a, b, tRaw) {
  const t = Math.max(0, Math.min(1, tRaw));
  let d = a[0]*b[0] + a[1]*b[1] + a[2]*b[2] + a[3]*b[3];
  let bb = b;
  if (d < 0) { bb = [-b[0], -b[1], -b[2], -b[3]]; d = -d; }
  if (d > 0.9995) {
    const r = a.map((v, i) => v + (bb[i] - v) * t);
    const l = Math.hypot(...r) || 1;
    return r.map(v => v / l);
  }
  const theta = Math.acos(Math.min(1, d)), sinT = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sinT, wb = Math.sin(t * theta) / sinT;
  return a.map((v, i) => wa * v + wb * bb[i]);
}

function scaleQuatAngle(q, k) {
  const w = Math.min(1, Math.max(-1, q[3]));
  const angle = 2 * Math.acos(w);
  if (angle < 1e-9) return [...ID_Q];
  const axLen = Math.hypot(q[0], q[1], q[2]);
  if (axLen < 1e-9) return [...ID_Q];
  const half = Math.sin(angle * k / 2);
  return [q[0] / axLen * half, q[1] / axLen * half, q[2] / axLen * half, Math.cos(angle * k / 2)];
}

function axisAngleQ(axis, ang) {
  const half = Math.sin(ang / 2);
  return [axis[0] * half, axis[1] * half, axis[2] * half, Math.cos(ang / 2)];
}

// ═══════════════════════════ 向量工具 ═══════════════════════════

const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function mul3(v, k) { return [v[0] * k, v[1] * k, v[2] * k]; }
function normalize3(v) {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-9 ? [v[0] / l, v[1] / l, v[2] / l] : null;
}
function angleBetween(a, b) {
  return Math.acos(Math.max(-1, Math.min(1, dot3(a, b))));
}

/** 把方向 a 朝方向 b 转 ang 弧度（不超过两者夹角） */
function rotateTowards(a, b, ang) {
  const d = angleBetween(a, b);
  if (d < 1e-6) return [...a];
  let axis = cross3(a, b);
  let alen = Math.hypot(axis[0], axis[1], axis[2]);
  if (alen < 1e-6) { // 反向：任取垂直轴
    const perp = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    axis = cross3(a, perp);
    alen = Math.hypot(axis[0], axis[1], axis[2]);
    if (alen < 1e-6) return [...a];
  }
  const nAxis = [axis[0] / alen, axis[1] / alen, axis[2] / alen];
  return applyQ(axisAngleQ(nAxis, Math.min(ang, d)), a);
}

/** 单位向量 a → b 的 slerp（t∈[0,1]）；近平行退 lerp，近反向绕固定垂直轴转 πt */
function slerpDir(a, b, t) {
  let d = dot3(a, b);
  if (d > 0.9995) return normalize3([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]) || [...a];
  if (d < -0.9995) {
    const ref = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : Math.abs(a[1]) < 0.9 ? [0, 1, 0] : [0, 0, 1];
    return rotateTowards(a, ref, Math.PI * t);
  }
  d = Math.max(-1, Math.min(1, d));
  const theta = Math.acos(d), sinTheta = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sinTheta;
  const wb = Math.sin(t * theta) / sinTheta;
  return [wa * a[0] + wb * b[0], wa * a[1] + wb * b[1], wa * a[2] + wb * b[2]];
}

// ═══════════════════════════ 缓动（与一次性模板同族） ═══════════════════════════

const EASE = {
  linear: t => t,
  easeIn: t => t * t,
  easeOut: t => 1 - Math.pow(1 - t, 3),
  easeInOut: t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  overshoot: t => 1 + 2.7 * Math.pow(t - 1, 3) + 1.7 * Math.pow(t - 1, 2),
  anticipate: t => (t < 0.5 ? -0.15 * Math.sin(t * Math.PI) : 1 + 0.15 * Math.sin((t - 1) * Math.PI)),
};
function easeOf(name) { return EASE[name] || EASE.easeInOut; }

/**
 * 挥击段鞭甩缓动（用户需求: 后半程加速明显, 末端速度 2-3×）。
 * blend = 0.05·cos缓出(旧) + 0.95·q⁶——深蓄力后爆发, 末端瞬时速度 ≈5.8
 * (旧 1.57, ≈3.7×, 实测末10%均值 ~2.6-3×); snap 在 (旧曲线, 鞭甩) 间插值,
 * snap=0 完全旧行为(兼容旧动画风格), 默认 1 全鞭甩。
 */
function strikeEase(q, snap) {
  const w = Math.max(0, Math.min(1, snap === undefined ? 1 : snap));
  const cosE = 1 - Math.cos(Math.PI / 2 * q);
  const whip = 0.05 * cosE + 0.95 * Math.pow(q, 6);   // 末端速度≈5.8 (旧1.57, ≈3.7×)
  return cosE + (whip - cosE) * w;
}

// ═══════════════════════════ 节点基础姿态 ═══════════════════════════

/** base 欧拉：带 rest quaternion 时取其欧拉（与前端 basePose 捕获一致），否则 rotation 字段 */
function baseEulerOf(part) {
  if (part.quaternion) {
    return quatToEulerXYZ([part.quaternion.x, part.quaternion.y, part.quaternion.z, part.quaternion.w]);
  }
  return [part.rotation?.x || 0, part.rotation?.y || 0, part.rotation?.z || 0];
}

function baseQuatOf(part) {
  if (part.quaternion) {
    return [part.quaternion.x, part.quaternion.y, part.quaternion.z, part.quaternion.w];
  }
  const e = baseEulerOf(part);
  return quatFromEulerXYZ(e[0], e[1], e[2]);
}

/**
 * 父链世界变换（世界 → groupId 的父级），含当前帧 motion 偏移。
 * 每个祖先：localPos = offset + Δpos（经父世界四元数旋转后累加），
 *           localQuat = E2Q(baseEuler + Δrot)。精确镜像前端 Three.js 每帧的
 *           场景图合成顺序 —— 双端一致性由这一镜像保证。
 * @returns {{pos:[x,y,z], quat:[x,y,z,w]}|null}
 */
function chainWorldTransform(lookups, groupId, motionResult) {
  const part = lookups?.getPart?.(groupId);
  if (!part) return null;
  const chain = [];
  let cur = part.parent ? lookups.getPart(part.parent) : null;
  let guard = 0;
  while (cur && guard++ < 64) {
    chain.unshift(cur);
    cur = cur.parent ? lookups.getPart(cur.parent) : null;
  }
  let pos = [0, 0, 0];
  let quat = [...ID_Q];
  for (const p of chain) {
    const mo = motionResult?.[p.id];
    const lp = [
      (p.offset?.x || 0) + (mo?.position?.[0] || 0),
      (p.offset?.y || 0) + (mo?.position?.[1] || 0),
      (p.offset?.z || 0) + (mo?.position?.[2] || 0),
    ];
    pos = add3(pos, applyQ(quat, lp));
    const be = baseEulerOf(p);
    const dr = mo?.rotation;
    quat = mulQ(quat, quatFromEulerXYZ(
      be[0] + (dr?.[0] || 0),
      be[1] + (dr?.[1] || 0),
      be[2] + (dr?.[2] || 0),
    ));
  }
  return { pos, quat };
}

/** 组自身轴心的当前世界位置 + 父世界变换（含 motion） */
function pivotWorld(lookups, groupId, motionResult) {
  const part = lookups?.getPart?.(groupId);
  if (!part) return null;
  const pw = chainWorldTransform(lookups, groupId, motionResult);
  if (!pw) return null;
  const mo = motionResult?.[groupId];
  const lp = [
    (part.offset?.x || 0) + (mo?.position?.[0] || 0),
    (part.offset?.y || 0) + (mo?.position?.[1] || 0),
    (part.offset?.z || 0) + (mo?.position?.[2] || 0),
  ];
  return { pos: add3(pw.pos, applyQ(pw.quat, lp)), parentPos: pw.pos, parentQuat: pw.quat };
}

// ═══════════════════════════ 世界点引用解析 ═══════════════════════════

/**
 * 世界点引用 → [x,y,z]。
 *   [x,y,z]                 绝对世界坐标
 *   { group, offset? }      组轴心当前世界位置 + 偏移（逐帧重解 → 跟踪运动中的组）
 * 非法返回 null。
 */
export function resolveWorldRef(ref, lookups, motionResult) {
  if (Array.isArray(ref)) {
    if (ref.length >= 3 && ref.slice(0, 3).every(Number.isFinite)) return [ref[0], ref[1], ref[2]];
    return null;
  }
  if (ref && typeof ref === 'object' && typeof ref.group === 'string') {
    const pv = pivotWorld(lookups, ref.group, motionResult);
    if (!pv) return null;
    const off = (Array.isArray(ref.offset) && ref.offset.length >= 3 && ref.offset.every(Number.isFinite))
      ? ref.offset : [0, 0, 0];
    return [pv.pos[0] + off[0], pv.pos[1] + off[1], pv.pos[2] + off[2]];
  }
  return null;
}

// ═══════════════════════════ 末端方向（局部） ═══════════════════════════

/**
 * 组的延伸末端方向（组局部单位向量）。
 * 优先级（bbc9e0c 用挂载武器回归换来的教训——与 motion-expander.obbEndDirWorld
 * 的语义一致）：
 *   1. 骨骼向量：到「最深子树的子组」的 offset 方向。这是关节链的自然延伸
 *      方向（臂→腕），不受挂载物影响——手持武器会把 group 的 OBB 撑成武器
 *      形状，用 OBB 主轴会把"武器指向"误当"肢体指向"，导致反关节姿态。
 *   2. OBB 主轴 × center 符号：无子组的末端组（武器/工具/触手末节）——
 *      武器组自身的 OBB 主轴就是刃的指向，此时 OBB 恰恰是对的。
 *   3. 都没有 → null（模板跳过，宁缺毋错）。
 *   ★ 头/颈类组不走 1/2，直接用局部 +Z（面部朝向，见 isHeadLike）。
 */

/** 头/颈类组判定。挂载物组（mount* 前缀，如 mount01_hat）不是头本体；
 *  项链/领带等配饰词排除（'neck' 子串误命中）。 */
const HEAD_LIKE_RE = /head|neck|颈|头/i;
const HEAD_EXCLUDE_RE = /necklace|necktie|choker|枕头|埋头/i;

function isHeadLike(part) {
  if (!part) return false;
  const id = part.id || '';
  if (/^mount/i.test(id)) return false;
  if (HEAD_EXCLUDE_RE.test(id) || HEAD_EXCLUDE_RE.test(part.name || '')) return false;
  return HEAD_LIKE_RE.test(id) || HEAD_LIKE_RE.test(part.name || '');
}

/** 头/颈组 aimSeq/sweep 的单次求解旋转角上限（弧度）。
 *  无限位的纯几何求解会把"帽尖轴对准脚下"解成 160°+ 折头（低头过头 rootcause，
 *  2026-08-29）；75° 覆盖人/马低头极限（看脚下≈80° 需求微欠量、马吃草≈67°）。 */
const MAX_HEAD_AIM = 75 * Math.PI / 180;

export function endDirLocal(part, lookups) {
  // 头/颈的功能指向 = 面部朝向（引擎坐标约定 +Z 前）。子组链方向会被挂载物
  // 污染（厨师帽 → +Y），OBB 主轴会被高部件（帽/耳朵）带成竖直——两条代理
  // 路径对头部都是错的：把帽尖对准地面 = 头折过垂直线再翻到背后。
  if (isHeadLike(part)) return [0, 0, 1];
  const kids = (lookups?.getChildren?.(part.id) || []).filter(c => c && c.isGroup);
  if (kids.length) {
    const depthOf = (node, seen = new Set()) => {
      if (seen.has(node.id)) return 0;
      seen.add(node.id);
      let best = 0;
      for (const k of (lookups.getChildren(node.id) || [])) {
        if (k && k.isGroup) best = Math.max(best, depthOf(k, seen));
      }
      return best + 1;
    };
    let best = null, bestDepth = -1;
    for (const k of kids) {
      const d = depthOf(k);
      if (d > bestDepth) { bestDepth = d; best = k; }
    }
    const off = best ? [best.offset?.x || 0, best.offset?.y || 0, best.offset?.z || 0] : null;
    const n = off ? normalize3(off) : null;
    if (n) return n;
  }
  const obb = part._obb;
  if (obb && Array.isArray(obb.axes) && Array.isArray(obb.size) && obb.size.length === 3) {
    const mainIdx = obb._mainAxis ?? obb.size.indexOf(Math.max(...obb.size));
    let d = [...(obb.axes[mainIdx] || [0, 1, 0])];
    const c = Array.isArray(obb.center) ? obb.center : [0, 0, 0];
    const cOn = (c[0] || 0) * d[0] + (c[1] || 0) * d[1] + (c[2] || 0) * d[2];
    if (cOn < 0) d = d.map(v => -v);
    const n = normalize3(d);
    if (n) return n;
  }
  return null;
}

/** 末端方向的当前世界向量（base 姿态，不含本组自身 motion——用于起手参考） */
function restEndDirWorld(part, lookups, parentQuat) {
  const eDirL = endDirLocal(part, lookups);
  if (!eDirL) return null;
  return applyQ(mulQ(parentQuat, baseQuatOf(part)), eDirL);
}

// ═══════════════════════════ 功能面（绕主轴滚转） ═══════════════════════════

/**
 * 组的功能面法向（组局部单位向量）——锤/斧/铲/熨斗类工具有明确的工作面。
 * 推导：OBB 中**非主轴里较长的那根**（锤头横长轴 = 两打击面连线方向；
 * 斧刃宽向 = 刃面法向）。主轴约束指向后，绕主轴的滚转自由度由它定死。
 * 无 OBB / 主轴即最长且其余两轴近等（圆柱锤头无横宽）→ null（滚转不可控）。
 */
export function faceDirLocal(part) {
  const obb = part?._obb;
  if (!obb || !Array.isArray(obb.axes) || !Array.isArray(obb.size) || obb.size.length !== 3) return null;
  const mainIdx = obb._mainAxis ?? obb.size.indexOf(Math.max(...obb.size));
  const others = [0, 1, 2].filter(i => i !== mainIdx);
  // 其余两轴按长度降序
  others.sort((a, b) => obb.size[b] - obb.size[a]);
  const [second, third] = others;
  if (obb.size[second] < 1.15 * Math.max(obb.size[third], 1e-6)) return null; // 近对称→无明确功能面
  const d = [...(obb.axes[second] || [0, 1, 0])];
  return normalize3(d);
}

/** 方位词/向量 → 世界方向向量；非法返回 null */
const FACE_WORDS = {
  forward: [0, 0, 1], back: [0, 0, -1], up: [0, 1, 0], down: [0, -1, 0],
  left: [-1, 0, 0], right: [1, 0, 0],
  'forward-down': [0, -0.7, 0.7], 'forward-up': [0, 0.7, 0.7],
  'back-down': [0, -0.7, -0.7],
};
export function parseFaceDir(face) {
  if (typeof face === 'string') {
    const v = FACE_WORDS[face];
    return v ? normalize3([...v]) : null;
  }
  if (Array.isArray(face) && face.length >= 3 && face.slice(0, 3).every(Number.isFinite)) {
    return normalize3([face[0], face[1], face[2]]);
  }
  return null;
}

// ═══════════════════════════ 求解：方向 → 局部 Δ 欧拉 ═══════════════════════════

/** 纯朝向求解：swing(主轴对齐) + twist(功能面滚转, 可观测阻尼) → 世界目标四元数。
 *  无平滑/无写出——供逐帧求解与修正层锚点计算共用同一数学。 */
function _aimWorldTarget(part, pv, targetDir, amount, faceDir, blend) {
  const eDirL = endDirLocal(part, _solveDirAim._lookups);
  if (!eDirL) return null;
  const baseQ = baseQuatOf(part);
  const worldBase = mulQ(pv.parentQuat, baseQ);
  const endWorld = applyQ(worldBase, eDirL);
  let qd = quatBetween(endWorld, targetDir);
  // 头/颈限位：旋转角超上限时按比例收缩（轴不变）。目标过近正下方/身后等
  // 极端几何不再把头折过垂直线；amount 缩放在其后叠加（只减不增）。
  if (isHeadLike(part)) {
    const ang = 2 * Math.acos(Math.min(1, Math.max(-1, qd[3])));
    if (ang > MAX_HEAD_AIM) qd = scaleQuatAngle(qd, MAX_HEAD_AIM / ang);
  }
  const amt = (amount === undefined || amount === null) ? 1 : Math.max(0, Math.min(1, amount));
  if (amt !== 1) qd = scaleQuatAngle(qd, amt);
  let twist = [...ID_Q];
  if (faceDir) {
    const fLocal = faceDirLocal(part);
    if (fLocal) {
      const swung = mulQ(qd, worldBase);
      const fCur = applyQ(swung, fLocal);
      const perpOf = (v) => sub3(v, mul3(targetDir, dot3(v, targetDir)));
      const pa = perpOf(fCur), pb = perpOf(faceDir);
      const la = Math.hypot(...pa), lb = Math.hypot(...pb);
      if (la > 1e-6 && lb > 1e-6) {
        const observ = Math.max(0, Math.min(1, Math.min(la, lb) / 0.4));
        const w = observ * observ * (3 - 2 * observ);
        if (w > 1e-4) {
          const a = [pa[0] / la, pa[1] / la, pa[2] / la], b = [pb[0] / lb, pb[1] / lb, pb[2] / lb];
          const crossAB = cross3(a, b);
          const onAxis = dot3(crossAB, targetDir);
          const ang = Math.atan2(Math.hypot(...crossAB), dot3(a, b)) * Math.sign(onAxis || 1) * w;
          const full = axisAngleQ(targetDir, ang);
          twist = amt !== 1 ? scaleQuatAngle(full, amt) : full;
        }
      }
    }
  }
  let worldTarget = mulQ(twist, mulQ(qd, worldBase));
  if (blend !== undefined && blend < 1) worldTarget = qSlerp(worldBase, worldTarget, blend);
  return worldTarget;
}

/** 求解结果写出：时序平滑 + 欧拉连续化 + 写回 result[gid].rotation */
function _writeSolved(result, groupId, part, pv, worldTarget, t, tEnd) {
  const baseE = baseEulerOf(part);
  {
    let sstore = _smoothCtx.get(_solveDirAim._plan);
    if (!sstore) { sstore = new Map(); _smoothCtx.set(_solveDirAim._plan, sstore); }
    const sp = sstore.get(groupId);
    if (sp && t > sp.t && (t - sp.t) < 0.5) {
      const ramp = Math.max(0, Math.min(1, (t - ((tEnd ?? t) - 0.3)) / 0.3));
      const alpha = Math.min(1, Math.max((t - sp.t) / 0.08, ramp));
      worldTarget = qSlerp(sp.wt, worldTarget, alpha);
    }
    sstore.set(groupId, { t, wt: [...worldTarget] });
  }
  const localTotal = mulQ(invQ(pv.parentQuat), worldTarget);
  const le = quatToEulerXYZ(localTotal);
  const TAU = Math.PI * 2;
  let store = _eulerCtx.get(_solveDirAim._plan);
  if (!store) { store = new Map(); _eulerCtx.set(_solveDirAim._plan, store); }
  const prev = store.get(groupId);
  let best = [le[0], le[1], le[2]];
  if (prev) best = best.map((v, i) => v + Math.round((prev[i] - v) / TAU) * TAU);
  store.set(groupId, best);
  if (!result[groupId]) result[groupId] = { position: [0, 0, 0], rotation: [0, 0, 0], scale: null };
  result[groupId].rotation = [best[0] - baseE[0], best[1] - baseE[1], best[2] - baseE[2]];
}

/** 祖先链上是否存在世界模板(aimSeq/sweep)——子组武器是否走修正层 */
function _ancestorHasWorld(plan, lookups, groupId) {
  let cur = lookups.getPart(groupId);
  const seen = new Set();
  while (cur?.parent && !seen.has(cur.parent)) {
    seen.add(cur.parent);
    cur = lookups.getPart(cur.parent);
    if (!cur) break;
    const m = plan[cur.id];
    if (m && (m.aimSeq || m.sweep)) return true;
  }
  return false;
}

/** 修正层锚点：每个 key 时刻的修正量 C_k = inv(FK姿态@t_k) ⊗ (期望世界姿态@t_k)。
 *  嵌套评估(去掉本组 aimSeq 的 plan 在 t_k 的完整求值)拿祖先真实状态；按 plan 缓存。 */
function _correctionAnchors(plan, duration, groupId, part, lookups, specsOverride, cacheKey, rideBody) {
  const ck = cacheKey || groupId;
  let cstore = _corrCtx.get(plan);
  if (!cstore) { cstore = new Map(); _corrCtx.set(plan, cstore); }
  const cached = cstore.get(ck);
  if (cached) return cached;

  const motions = plan[groupId];
  const aSets = Array.isArray(motions.aimSeq) ? motions.aimSeq : [motions.aimSeq];
  const p = aSets.find(x => x && Array.isArray(x.keys) && x.keys.length);
  const faceDir = parseFaceDir(p?.face);
  const amount = p?.amount;
  const specs = specsOverride || (p?.keys || []);
  // 剥掉本组 aimSeq 的 plan(其余全保留——祖先的 sweep/pointTo 都在)
  const stripped = { ...plan, [groupId]: { ...motions } };
  delete stripped[groupId].aimSeq;

  const nestedEval = _solveDirAim._nestedEval
    || ((pl, tt) => { const r = {}; applyWorldTemplates(pl, duration, tt, r, lookups, _solveDirAim._nestedEval); return r; });

  const anchors = [{ t: 0, C: [...ID_Q] }];

  if (rideBody) {
    // ★ ride 模式: 目标按静止快照系解释——修正量全部在 rest 姿态计算
    // (C_k = inv(静止FK姿态) ⊗ aim(静止系目标方向)), 回放时整个 FK 链
    // (含身体 spin/转身)带着修正量走: 静止转身→最终朝向=转身⊗静止目标,
    // 连续旋风→朝向随身体连转。无需嵌套评估。
    const pvRest = pivotWorld(lookups, groupId, null);
    if (pvRest) {
      const W_rest = mulQ(pvRest.parentQuat, baseQuatOf(part));
      for (const k of specs) {
        const dirBody = refToDir(k.target, lookups, pvRest, null);
        if (!dirBody) continue;
        const desired = _aimWorldTarget(part, pvRest, dirBody, k.amount ?? amount, parseFaceDir(k.face) || faceDir, 1);
        if (!desired) continue;
        anchors.push({ t: k.t, C: mulQ(invQ(W_rest), desired), ease: k.ease });
      }
      cstore.set(ck, anchors);
      return anchors;
    }
  }

  for (const k of specs) {
    try {
      // 保存模块上下文——嵌套求值会改写 _plan/_lookups/_nestedEval
      const savedPlan = _solveDirAim._plan, savedLookups = _solveDirAim._lookups, savedNested = _solveDirAim._nestedEval;
      let nres;
      try { nres = nestedEval(stripped, k.t); }
      finally { _solveDirAim._plan = savedPlan; _solveDirAim._lookups = savedLookups; _solveDirAim._nestedEval = savedNested; }
      const pvK = pivotWorld(lookups, groupId, nres);
      if (!pvK) continue;
      const dirK = refToDir(k.target, lookups, pvK, nres);
      if (!dirK) continue;
      const desired = _aimWorldTarget(part, pvK, dirK, amount, parseFaceDir(k.face) || faceDir, 1);
      if (!desired) continue;
      const W_fkK = mulQ(pvK.parentQuat, baseQuatOf(part));
      anchors.push({ t: k.t, C: mulQ(invQ(W_fkK), desired), ease: k.ease });
    } catch { /* 单 key 评估失败跳过，其余锚点仍可用 */ }
  }
  cstore.set(ck, anchors);
  return anchors;
}
const _corrCtx = new WeakMap();  // plan → Map(gid → anchors)
const _eulerCtx = new WeakMap();  // plan → Map(groupId → 上一帧欧拉)——按动画隔离
const _smoothCtx = new WeakMap();  // plan → Map(groupId → {t, wt})——姿态时序平滑状态

/**
 * 把「末端世界方向应变为 targetDir」解成局部 Δ 欧拉，写回 result[gid].rotation。
 * 父级补偿的核心：targetDir 是世界方向，父链当前 quat 已含父级 motion，
 * 反解出的局部 Δ 让 base+Δ 在**世界系**里精确等于目标姿态。
 *
 * faceDir（可选，世界向量）——功能面滚转控制（swing-twist 第二步）：
 *   Step1 swing: endDir → targetDir 最短弧（原逻辑）；
 *   Step2 twist: 绕新主轴(targetDir)滚转，把功能面法向（OBB 次长轴）的
 *   垂面分量对到 faceDir 的垂面分量。锤类砸击 = 主轴指打击方向 + face:"down"
 *   → 锤面精确朝下。faceDir 与主轴平行时退化为纯 swing（无约束可加）。
 */
function _solveDirAim(result, groupId, part, pv, targetDir, amount, faceDir, blend, t, tEnd) {
  const worldTarget = _aimWorldTarget(part, pv, targetDir, amount, faceDir, blend);
  if (!worldTarget) return false;
  _writeSolved(result, groupId, part, pv, worldTarget, t, tEnd);
  return true;
}
// 模块级上下文（同一次 applyWorldTemplates 内一致）


/** 引用 → 该帧的目标方向（pivot→ref 向量）；退化（重合）返回 null */
function refToDir(ref, lookups, pv, result) {
  const p = resolveWorldRef(ref, lookups, result);
  if (!p) return null;
  return normalize3(sub3(p, pv.pos));
}

// ═══════════════════════════ 老模型 OBB 兜底 ═══════════════════════════

/**
 * 世界模板依赖 endDirLocal；叶子组（无子组，武器/末节）只有 OBB 一条路。
 * 快照时代模型生成时已算 _obb，老模型（2026-08 以前）没有 → 引擎调用本函数
 * 按组子树现场补算（与 motion-plan-parser._convertAimEnd 的兜底同思路）。
 * computeAllOBB 由引擎注入（后端直连 obb.js；浏览器经 sibling ESM），核心保持零依赖。
 * OBB 挂到 part 上——同一 model 对象只需付一次计算成本。
 */
export function ensureWorldObb(plan, lookups, computeAllOBB) {
  if (!plan || !lookups?.getPart || typeof computeAllOBB !== 'function') return;
  for (const [gid, motions] of Object.entries(plan)) {
    if (gid.startsWith('_') || !motions || typeof motions !== 'object') continue;
    if (!motions.aimSeq && !motions.sweep) continue;
    const part = lookups.getPart(gid);
    if (!part || part._obb) continue;
    const nodes = [];
    const normParams = (raw) => {
      // obb.js 读 v2 正名 (width/height/depth)；v1 遗留与部分测试路径存 w/h/d——别名归一
      if (!raw || typeof raw !== 'object') return raw;
      const out = { ...raw };
      if (out.width === undefined && out.w !== undefined) out.width = out.w;
      if (out.height === undefined && out.h !== undefined) out.height = out.h;
      if (out.depth === undefined && out.d !== undefined) out.depth = out.d;
      return out;
    };
    const build = (p, parent) => {
      const n = {
        id: p.id, parent,
        mesh: p.mesh ? { type: p.mesh.type, params: normParams(p.mesh.geometry ?? p.mesh.params) } : undefined,
        transform: { pos: [p.offset?.x || 0, p.offset?.y || 0, p.offset?.z || 0] },
      };
      nodes.push(n);
      for (const c of (lookups.getChildren?.(p.id) || [])) build(c, p.id);
    };
    build(part, part.parent || null);
    try { computeAllOBB(nodes); } catch { continue; }
    const self = nodes.find(n => n.id === gid);
    if (self?._obb) part._obb = self._obb;
  }
}

// ═══════════════════════════ 主入口 ═══════════════════════════

/**
 * 对 plan 中所有 aimSeq / sweep 做逐帧后处理，改写 result。
 * 在两套引擎的常规模板累积 + lockWorldRot 后处理**之后**调用——
 * 世界坐标模板接管该组旋转通道（同组其他旋转模板被覆盖，prompt 已教）。
 */
export function applyWorldTemplates(plan, duration, t, result, lookups, nestedEval) {
  if (!plan || !lookups?.getPart) return result;
  _solveDirAim._lookups = lookups;
  _solveDirAim._plan = plan;
  _solveDirAim._nestedEval = nestedEval;
  _solveDirAim._duration = duration;

  // ★ 拓扑序（父组先解）：子组（武器）求解 pivotWorld 时必须能看到父组（手臂）
  // 本帧的运动——否则武器在手臂抡动中的补偿是按手臂静止算的（叠加失效）。
  // JSON 键序不保证父先子后，按父链深度排序。
  const depthOf = (gid, seen = new Set()) => {
    let d = 0, cur = lookups.getPart(gid);
    while (cur?.parent && !seen.has(cur.parent)) {
      seen.add(cur.parent);
      cur = lookups.getPart(cur.parent);
      d++;
      if (d > 64) break;
    }
    return d;
  };
  const orderedEntries = Object.entries(plan)
    .filter(([gid]) => !gid.startsWith('_') && lookups.getPart(gid))
    .sort((a, b) => depthOf(a[0]) - depthOf(b[0]));

  for (const [groupId, motions] of orderedEntries) {
    if (groupId.startsWith('_') || !motions || typeof motions !== 'object') continue;
    const part = lookups.getPart(groupId);
    if (!part) continue;

    // ── aimSeq：沿时间轴的世界目标指向 ──
    for (const p of (Array.isArray(motions.aimSeq) ? motions.aimSeq : motions.aimSeq ? [motions.aimSeq] : [])) {
      if (!p || !Array.isArray(p.keys) || !p.keys.length) continue;
      if (!_inWindow(p, t, duration)) continue;

      // ★ 修正层模式：祖先链有世界模板(手臂在抡)时，武器不再独立画弧——
      // 锚点(key时刻的精确修正)之间刚性骑在手臂 FK 上，相位天然锁定。
      // 无祖先世界模板 → 退化为直接瞄准(原语义)。
      if (p.ride || _ancestorHasWorld(plan, lookups, groupId)) {
        const anchors = _correctionAnchors(plan, duration, groupId, part, lookups, null, null, !!p.ride);
        if (anchors.length > 1) {
          const pvC = pivotWorld(lookups, groupId, result);
          if (pvC) {
            const winStart = p._t0 != null ? p._t0 : 0;
            const tw = t - winStart;
            // C(t): 锚点间 slerp(ease 取段末锚点)
            // 修正量插值一律 easeInOut——挥击节奏由手臂 sweep 的缓动表达，
            // anticipate 等曲线会把大修正量压缩到段末(150°/0.17s=瞬跳)。
            const easeIO = EASE.easeInOut;
            let C = anchors[anchors.length - 1].C;
            if (tw < anchors[1].t) {
              const f = Math.max(0, Math.min(1, tw / Math.max(anchors[1].t, 1e-6)));
              C = qSlerp(anchors[0].C, anchors[1].C, easeIO(f));
            } else {
              let i = 1;
              while (i < anchors.length - 1 && tw >= anchors[i + 1].t) i++;
              if (tw < anchors[anchors.length - 1].t) {
                const a0 = anchors[i], a1 = anchors[i + 1];
                const f = Math.max(0, Math.min(1, (tw - a0.t) / Math.max(a1.t - a0.t, 1e-6)));
                C = qSlerp(a0.C, a1.C, easeIO(f));
              }
            }
            const W_fk = mulQ(pvC.parentQuat, baseQuatOf(part));
            const worldTarget = mulQ(W_fk, C);
            _writeSolved(result, groupId, part, pvC, worldTarget, t, p._t1 != null ? p._t1 : duration);
            if (!result[groupId]) result[groupId] = { position: [0, 0, 0], rotation: [0, 0, 0], scale: null };
            result[groupId]._world = { mode: 'aimSeq@corr', at: +tw.toFixed(3), anchors: anchors.length };
            continue;
          }
        }
      }
      const winStart = p._t0 != null ? p._t0 : 0;
      const tw = t - winStart;
      const pv = pivotWorld(lookups, groupId, result);
      if (!pv) continue;
      const faceDir = parseFaceDir(p.face);

      // 逐帧解析各 key 的目标方向（组引用会跟踪运动中的组）
      const keyDirs = p.keys.map(k => ({ t: k.t, dir: refToDir(k.target, lookups, pv, result), ease: k.ease, face: parseFaceDir(k.face) || faceDir }));
      const valid0 = keyDirs.filter(k => k.dir);
      if (!valid0.length) continue;

      // ★ 隐式静止首 key：LLM 常把首 key 写在 t=0 且 target≠静止位置——约束瞬时全额
      //   生效会拧跳。把「静止末端方向」作为 t=0 的隐式 key 注入，并保证 key 时刻
      //   单调（首段至少 0.25s 到达用户首 key）——起手永远从静止平滑出发。
      const restDir = normalize3(restEndDirWorld(part, lookups, pv.parentQuat) || [0, 1, 0]);
      const valid = [{ t: 0, dir: restDir, ease: valid0[0].ease, face: null }];
      let lastT = 0.25;  // 静止→用户首 key 至少 0.25s（防首 key 贴 t=0 造成约束瞬跳）
      for (const k of valid0) {
        const t = Math.max(k.t, lastT + 0.05);
        valid.push({ ...k, t });
        lastT = t;
      }

      let dir, face, blendIn;
      if (tw >= valid[valid.length - 1].t) {
        const last = valid[valid.length - 1];
        dir = last.dir; face = last.face; // 末 key 之后保持
      } else {
        // 分段：静止→k0→k1→…，ease 作用于段起点 key；blend(滚转渐入)=首段进度
        let i = 0;
        while (i < valid.length - 2 && tw >= valid[i + 1].t) i++;
        const k0 = valid[i], k1 = valid[i + 1];
        const f = Math.max(0, Math.min(1, (tw - k0.t) / Math.max(k1.t - k0.t, 1e-6)));
        const ef = easeOf(k1.ease ?? k0.ease)(f);
        dir = slerpDir(k0.dir, k1.dir, ef);
        face = k1.face || (i === 0 ? null : k0.face);
        blendIn = i === 0 ? ef : 1;   // 首段(静止→k0)整体渐入，之后约束全额
      }
      const tEndW = p._t1 != null ? p._t1 : duration;
      if (dir && _solveDirAim(result, groupId, part, pv, dir, p.amount, face, blendIn, t, tEndW)) {
        result[groupId]._world = { mode: 'aimSeq', at: +tw.toFixed(3), keys: p.keys.length };
      }
    }

    // ── sweep：起手(rest→from) + 挥击(from→to 世界大弧)，到点停住 ──
    for (const p of (Array.isArray(motions.sweep) ? motions.sweep : motions.sweep ? [motions.sweep] : [])) {
      if (!p || typeof p !== 'object') continue;
      if (!_inWindow(p, t, duration)) continue;
      const winStart = p._t0 != null ? p._t0 : 0;
      const tw = t - winStart;
      const speed = Math.min(20, Math.max(0.1, Number(p.speed) > 0 ? Number(p.speed) : 4));
      const pv = pivotWorld(lookups, groupId, result);
      if (!pv) continue;
      const faceDir = parseFaceDir(p.face);

      // ★ ride 模式: 旋风/转身攻击——身体在转(spin/pointTo 等常规模板),
      // 肢体/武器应随身体转而非锁世界方向。合成相位锚点(静止→from→to),
      // 修正层骑 FK: 世界朝向=身体旋转⊗相对姿势。via 在 ride 下忽略。
      if (p.ride) {
        const speed = Math.min(20, Math.max(0.1, Number(p.speed) > 0 ? Number(p.speed) : 4));
        const winStart = p._t0 != null ? p._t0 : 0;
        const tFrom = winStart + 1 / speed, tTo = winStart + 2 / speed;
        const specs = [
          { t: tFrom, target: p.from, face: p.face },
          { t: tTo, target: p.to, face: p.face },
        ];
        const anchors = _correctionAnchors(plan, duration, groupId, part, lookups, specs, groupId + ':sweepRide:' + winStart + ':' + speed, true);
        if (anchors.length > 1) {
          const pvC = pivotWorld(lookups, groupId, result);
          if (pvC) {
            const tw = t - winStart;
            const easeIO = EASE.easeInOut;
            let C = anchors[anchors.length - 1].C;
            if (tw < anchors[1].t) {
              const f = Math.max(0, Math.min(1, tw / Math.max(anchors[1].t - 0, 1e-6)));
              C = qSlerp(anchors[0].C, anchors[1].C, easeIO(f));
            } else if (tw < anchors[anchors.length - 1].t) {
              const f = Math.max(0, Math.min(1, (tw - anchors[1].t) / Math.max(anchors[2]?.t - anchors[1].t || 1e-6, 1e-6)));
              C = qSlerp(anchors[1].C, anchors[2].C, easeIO(f));
            }
            const W_fk = mulQ(pvC.parentQuat, baseQuatOf(part));
            const worldTarget = mulQ(W_fk, C);
            _writeSolved(result, groupId, part, pvC, worldTarget, t, p._t1 != null ? p._t1 : duration);
            if (!result[groupId]) result[groupId] = { position: [0, 0, 0], rotation: [0, 0, 0], scale: null };
            result[groupId]._world = { mode: 'sweep@ride', anchors: anchors.length };
            continue;
          }
        }
      }

      const fDir = refToDir(p.from, lookups, pv, result);
      const toDir = refToDir(p.to, lookups, pv, result);
      if (!fDir || !toDir) continue;

      const progress = Math.min(tw * speed, 2); // [0,1]=起手 [1,2]=挥击
      let dir;
      let blendIn;
      if (progress < 1) {
        // 起手：从静止末端方向 eased 转到 from 方向（消除瞬移跳变）
        const restDir = normalize3(restEndDirWorld(part, lookups, pv.parentQuat) || [0, 1, 0]);
        dir = rotateTowards(restDir, fDir, (1 - Math.cos(Math.PI / 2 * progress)) * angleBetween(restDir, fDir));
        blendIn = 1 - Math.cos(Math.PI / 2 * progress);   // 滚转约束同步渐入
      } else {
        const q = progress - 1;
        const ease = strikeEase(q, p.snap);           // 鞭甩: 后半程加速(末端≈2.3×旧速)
        if (p.via) {
          const vDir = refToDir(p.via, lookups, pv, result);
          if (vDir) {
            const a1 = angleBetween(fDir, vDir), a2 = angleBetween(vDir, toDir);
            const travel = ease * (a1 + a2);
            dir = travel <= a1
              ? rotateTowards(fDir, vDir, travel)
              : rotateTowards(vDir, toDir, travel - a1);
          }
        }
        if (!dir) dir = rotateTowards(fDir, toDir, ease * angleBetween(fDir, toDir));
      }
      const tEndS = p._t1 != null ? p._t1 : duration;
      if (dir && _solveDirAim(result, groupId, part, pv, dir, p.amount, faceDir, blendIn, t, tEndS)) {
        result[groupId]._world = { mode: 'sweep', progress: +progress.toFixed(3), from: p.from, to: p.to };
      }
    }
  }
  return result;
}

/** _t0/_t1 时间窗（曲线编辑器裁剪），与其他模板口径一致 */
function _inWindow(p, t, duration) {
  const pt0 = p._t0 != null ? p._t0 : 0;
  const pt1 = p._t1 != null ? p._t1 : duration;
  return t >= pt0 - 0.0001 && t <= pt1 + 0.0001;
}

// ═══════════════════════════ 供 parser 用的参数校验 ═══════════════════════════

const _isVec3 = (v) => Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every(Number.isFinite);
const _isRef = (v) => _isVec3(v)
  || (v && typeof v === 'object' && !Array.isArray(v) && typeof v.group === 'string'
      && (v.offset === undefined || _isVec3(v.offset)));
const EASE_NAMES = new Set(Object.keys(EASE));

/**
 * 单个参数集校验+清洗；返回 null 表示应整条删除。
 * validGroups（可选）：合法 group id 集合，{group} 引用不在集合内 → 该引用无效。
 */
export function sanitizeWorldTemplate(name, p, validGroups) {
  if (!p || typeof p !== 'object') return null;
  const refOk = (v) => {
    if (!_isRef(v)) return false;
    if (v && typeof v === 'object' && !Array.isArray(v) && validGroups && !validGroups.has(v.group)) return false;
    return true;
  };
  const out = { ...p };

  if (name === 'aimSeq') {
    if (!Array.isArray(out.keys)) return null;
    const keys = out.keys
      .filter(k => k && typeof k === 'object' && Number.isFinite(+k.t) && +k.t >= 0 && refOk(k.target))
      .map(k => {
        const ck = { t: +k.t, target: Array.isArray(k.target) ? k.target.slice(0, 3) : { group: k.target.group, ...(k.target.offset ? { offset: k.target.offset.slice(0, 3) } : {}) } };
        if (k.ease && EASE_NAMES.has(k.ease)) ck.ease = k.ease;
        if (k.face !== undefined && parseFaceDir(k.face)) ck.face = k.face;
        return ck;
      })
      .sort((a, b) => a.t - b.t);
    if (!keys.length) return null;
    out.keys = keys;
    if (out.face !== undefined && !parseFaceDir(out.face)) delete out.face;
  } else if (name === 'sweep') {
    if (!refOk(out.from) || !refOk(out.to)) return null;
    if (out.via !== undefined) {
      if (!refOk(out.via)) delete out.via;
    }
    if (out.speed !== undefined) out.speed = Math.min(20, Math.max(0.1, Number(out.speed) || 4));
    if (out.snap !== undefined) out.snap = Math.max(0, Math.min(1, Number(out.snap) || 0));
    if (out.face !== undefined && !parseFaceDir(out.face)) delete out.face;
  } else {
    return null;
  }

  if (out.ride !== undefined) out.ride = !!out.ride;
  if (out.amount !== undefined) out.amount = Math.max(0, Math.min(1, Number(out.amount) || 0));
  return out;
}

/** 坐标合理性检查（研究用）：[x,y,z] 引用离模型 AABB 中心过远 → 提示 LLM 可能在编坐标。
 *  返回 null（合理）或该引用坐标。只做诊断，不做强制。 */
export function outlierWorldRef(name, p, bounds) {
  if (!bounds || !Array.isArray(bounds.center) || !Array.isArray(bounds.size)) return null;
  const refs = [];
  if (name === 'aimSeq' && Array.isArray(p?.keys)) p.keys.forEach(k => refs.push(k?.target));
  if (name === 'sweep') refs.push(p?.from, p?.to, p?.via);
  const limit = 2 * Math.max(bounds.size[0], bounds.size[1], bounds.size[2], 0.001);
  for (const r of refs) {
    if (Array.isArray(r) && r.length >= 3 && r.every(Number.isFinite)) {
      const d = Math.hypot(r[0] - bounds.center[0], r[1] - bounds.center[1], r[2] - bounds.center[2]);
      if (d > limit) return r;
    }
  }
  return null;
}

