/**
 * obb.js — 有向包围盒(OBB)计算：PCA 最小体积包围。
 * 在 gen/refine 构建 model.json 时对每个 group 计算，存入 node._obb。
 *
 * 算法:
 *   1. 收集 group 子树所有 mesh 的采样点(经 mesh pos+quat 变换到 group 局部空间)
 *      - box: 8 个角点
 *      - cyl/cone: 两端圆周各 8 点(16 点)
 *      - sphere: 中心 ± 半径的 6 个轴向点(近似)
 *   2. 子 group: 用其 _obb 的 8 个角点(经子 group offset+quat 变换)
 *   3. 对点集做 PCA: 质心 → 协方差矩阵 → 特征向量 = OBB 主轴
 *   4. 所有点投影到主轴 → 各轴 min/max → size
 *
 * 输出: { size:[w,h,d], center:[x,y,z], axes:[[x,y,z]x3] }
 *   axes: 3 个正交单位向量(PCA 特征向量), OBB 的朝向。
 *   size 最大轴对应的 axes[i] = 肢体主方向。
 *   center 在主轴方向的符号 = 延伸方向(如 y 分量<0 = 朝下延伸)。
 */

// ── Quaternion helpers ──
export function quatApply(q, v) {
  const [x, y, z, w] = q;
  const vx = v[0], vy = v[1], vz = v[2];
  const cx = y*vz - z*vy, cy = z*vx - x*vz, cz = x*vy - y*vx;
  const cx2 = y*cz - z*cy, cy2 = z*cx - x*cz, cz2 = x*cy - y*cx;
  return [vx + 2*w*cx + 2*cx2, vy + 2*w*cy + 2*cy2, vz + 2*w*cz + 2*cz2];
}

function quatMul(a, b) {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    aw*bx + ax*bw + ay*bz - az*by,
    aw*by - ax*bz + ay*bw + az*bx,
    aw*bz + ax*by - ay*bx + az*bw,
    aw*bw - ax*bx - ay*by - az*bz,
  ];
}
const IDENTITY_Q = [0, 0, 0, 1];

// ── Mesh 采样点(局部空间) ──
function meshSamplePoints(mesh) {
  const pts = [];
  const t = mesh.transform || {};
  const pos = t.pos || [0, 0, 0];
  const quat = t.quat || IDENTITY_Q;
  const type = mesh.mesh?.type;
  const g = mesh.mesh?.params || {};
  const push = (v) => pts.push(quatApply(quat, v).map((c, i) => c + pos[i]));

  if (type === 'box') {
    const hw = (g.width ?? 1)/2, hh = (g.height ?? 1)/2, hd = (g.depth ?? 1)/2;
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1])
      push([sx*hw, sy*hh, sz*hd]);
  } else if (type === 'cylinder' || type === 'cyl') {
    const r = Math.max(g.radiusTop ?? 1, g.radiusBottom ?? 1);
    const h = (g.height ?? 1)/2;
    for (const end of [-1, 1])
      for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4;
        push([Math.cos(a)*r, end*h, Math.sin(a)*r]);
      }
  } else if (type === 'cone') {
    const r = g.radius ?? 1, h = (g.height ?? 1)/2;
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4;
      push([Math.cos(a)*r, -h, Math.sin(a)*r]);  // 底面
      push([Math.cos(a)*r*0.1, h, Math.sin(a)*r*0.1]);  // 顶点附近
    }
  } else if (type === 'sphere') {
    const r = g.radius ?? 1;
    push([r,0,0]); push([-r,0,0]); push([0,r,0]); push([0,-r,0]); push([0,0,r]); push([0,0,-r]);
  } else if (type === 'torus') {
    const r = (g.radius ?? 1) + (g.tube ?? 0.3), tube = g.tube ?? 0.3;
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4;
      push([Math.cos(a)*r, tube, Math.sin(a)*r]);
      push([Math.cos(a)*r, -tube, Math.sin(a)*r]);
    }
  } else {
    push([0,0,0]); push([0.5,0,0]); push([0,0.5,0]); push([0,0,0.5]);
  }
  return pts;
}

// ── OBB 8 角点(子 group 递归用) ──
function obbCorners(obb) {
  const [ax1, ax2, ax3] = obb.axes;
  const hw = obb.size[0]/2, hh = obb.size[1]/2, hd = obb.size[2]/2;
  const c = obb.center;
  const pts = [];
  for (const s1 of [-1,1]) for (const s2 of [-1,1]) for (const s3 of [-1,1]) {
    pts.push([
      c[0] + s1*hw*ax1[0] + s2*hh*ax2[0] + s3*hd*ax3[0],
      c[1] + s1*hw*ax1[1] + s2*hh*ax2[1] + s3*hd*ax3[1],
      c[2] + s1*hw*ax1[2] + s2*hh*ax2[2] + s3*hd*ax3[2],
    ]);
  }
  return pts;
}

// ── PCA: 协方差矩阵特征分解(3x3, Jacobi 迭代) ──
function eigenDecompose3x3(m) {
  // m: [[xx,xy,xz],[xy,yy,yz],[xz,yz,zz]]
  // Jacobi 迭代求特征向量
  let a = m.map(r => [...r]);
  let v = [[1,0,0],[0,1,0],[0,0,1]];  // 特征向量(列)
  for (let iter = 0; iter < 50; iter++) {
    // 找最大非对角元素
    let maxOff = 0, p = 0, q = 1;
    for (let i = 0; i < 3; i++) for (let j = i+1; j < 3; j++) {
      if (Math.abs(a[i][j]) > maxOff) { maxOff = Math.abs(a[i][j]); p = i; q = j; }
    }
    if (maxOff < 1e-10) break;
    // 旋转
    const app = a[p][p], aqq = a[q][q], apq = a[p][q];
    const theta = (aqq - app) / (2 * apq);
    const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta*theta + 1));
    const c = 1 / Math.sqrt(t*t + 1), s = t * c;
    for (let k = 0; k < 3; k++) {
      const akp = a[k][p], akq = a[k][q];
      a[k][p] = c*akp - s*akq;
      a[k][q] = s*akp + c*akq;
    }
    for (let k = 0; k < 3; k++) {
      const apk = a[p][k], aqk = a[q][k];
      a[p][k] = c*apk - s*aqk;
      a[q][k] = s*apk + c*aqk;
    }
    for (let k = 0; k < 3; k++) {
      const vkp = v[k][p], vkq = v[k][q];
      v[k][p] = c*vkp - s*vkq;
      v[k][q] = s*vkp + c*vkq;
    }
  }
  // 特征值 = 对角
  const eigs = [a[0][0], a[1][1], a[2][2]];
  // 特征向量 = v 的列
  const axes = [
    [v[0][0], v[1][0], v[2][0]],
    [v[0][1], v[1][1], v[2][1]],
    [v[0][2], v[1][2], v[2][2]],
  ];
  return { eigs, axes };
}

/**
 * 计算一个 group 的 OBB(含子树所有 mesh)。
 * @param {Array} nodes - model.json v2 的扁平 nodes
 * @param {string} groupId - 要算 OBB 的 group id
 * @returns {{size, center, axes}} OBB(group 局部空间)
 */
export function computeOBB(nodes, groupId) {
  const childrenOf = new Map();
  for (const n of nodes) {
    if (!n.parent) continue;
    if (!childrenOf.has(n.parent)) childrenOf.set(n.parent, []);
    childrenOf.get(n.parent).push(n);
  }

  const points = [];

  function collect(id, parentQuat) {
    const kids = childrenOf.get(id) || [];
    for (const k of kids) {
      const kPos = k.transform?.pos || [0,0,0];
      const kQuat = k.transform?.quat ? quatMul(parentQuat, k.transform.quat) : parentQuat;
      if (k.mesh) {
        // mesh: 采样点经 kPos+kQuat 变换
        const tmpNode = { transform: { pos: kPos, quat: kQuat }, mesh: k.mesh };
        for (const p of meshSamplePoints(tmpNode)) points.push(p);
      } else {
        // group: 递归其子(它的局部点要经 kPos+kQuat 变换到本 group 空间)
        collect(k.id, kQuat);
        // 如果子 group 已有 _obb, 也加它的 8 角
        if (k._obb) {
          for (const c of obbCorners(k._obb)) {
            const r = quatApply(kQuat, c);
            points.push([r[0]+kPos[0], r[1]+kPos[1], r[2]+kPos[2]]);
          }
        }
      }
    }
  }
  collect(groupId, IDENTITY_Q);

  if (points.length < 4) return null;

  // 质心
  const n = points.length;
  const center = [0, 0, 0];
  for (const p of points) { center[0]+=p[0]; center[1]+=p[1]; center[2]+=p[2]; }
  center[0]/=n; center[1]/=n; center[2]/=n;

  // 协方差矩阵
  let xx=0, yy=0, zz=0, xy=0, xz=0, yz=0;
  for (const p of points) {
    const dx=p[0]-center[0], dy=p[1]-center[1], dz=p[2]-center[2];
    xx+=dx*dx; yy+=dy*dy; zz+=dz*dz; xy+=dx*dy; xz+=dx*dz; yz+=dy*dz;
  }
  const cov = [[xx/n, xy/n, xz/n], [xy/n, yy/n, yz/n], [xz/n, yz/n, zz/n]];
  const { eigs, axes } = eigenDecompose3x3(cov);

  // 投影到主轴 → size
  const mins = [Infinity, Infinity, Infinity], maxs = [-Infinity, -Infinity, -Infinity];
  for (const p of points) {
    for (let i = 0; i < 3; i++) {
      const d = p[0]*axes[i][0] + p[1]*axes[i][1] + p[2]*axes[i][2];
      mins[i] = Math.min(mins[i], d);
      maxs[i] = Math.max(maxs[i], d);
    }
  }
  const size = [
    +( (maxs[0]-mins[0]).toFixed(3)),
    +( (maxs[1]-mins[1]).toFixed(3)),
    +( (maxs[2]-mins[2]).toFixed(3)),
  ];
  // center 在主轴坐标 → 转回局部空间
  const projCenter = [(mins[0]+maxs[0])/2, (mins[1]+maxs[1])/2, (mins[2]+maxs[2])/2];
  const localCenter = [
    +( (projCenter[0]*axes[0][0] + projCenter[1]*axes[1][0] + projCenter[2]*axes[2][0]).toFixed(3)),
    +( (projCenter[0]*axes[0][1] + projCenter[1]*axes[1][1] + projCenter[2]*axes[2][1]).toFixed(3)),
    +( (projCenter[0]*axes[0][2] + projCenter[1]*axes[1][2] + projCenter[2]*axes[2][2]).toFixed(3)),
  ];

  return {
    size,
    center: localCenter,
    axes: axes.map(a => [+a[0].toFixed(4), +a[1].toFixed(4), +a[2].toFixed(4)]),
    // 辅助: 主轴(最长)索引
    _mainAxis: size.indexOf(Math.max(...size)),
  };
}

/** 对整棵树的所有 group 计算 OBB(自底向上, 子先算) */
export function computeAllOBB(nodes) {
  const groupIds = nodes.filter(n => !n.mesh).map(n => n.id);
  // 自底向上: 先算叶子(无子group)
  const hasGroupChild = new Set();
  const childrenOf = new Map();
  for (const n of nodes) {
    if (!n.parent) continue;
    if (!childrenOf.has(n.parent)) childrenOf.set(n.parent, []);
    childrenOf.get(n.parent).push(n);
  }
  for (const [pid, kids] of childrenOf) {
    if (kids.some(k => !k.mesh)) hasGroupChild.add(pid);
  }
  // 按依赖顺序(叶子group先)
  const order = [];
  const visited = new Set();
  function visit(id) {
    if (visited.has(id)) return;
    visited.add(id);
    for (const k of (childrenOf.get(id) || [])) if (!k.mesh) visit(k.id);
    order.push(id);
  }
  groupIds.forEach(visit);
  for (const gid of order) {
    const node = nodes.find(n => n.id === gid);
    if (node) node._obb = computeOBB(nodes, gid);
  }
  return nodes;
}

