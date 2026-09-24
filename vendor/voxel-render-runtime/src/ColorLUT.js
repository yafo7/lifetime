// Static LUT rendering extracted from the upstream palette module. No generation client.
import * as THREE from 'three';
const LUT_WIDTH = 256;
const DEFAULT_PALETTE_POINTS = [
  { l: 0.0, r: 0.15, g: 0.18, b: 0.22 },
  { l: 0.3, r: 0.15, g: 0.18, b: 0.22 },
  { l: 0.5, r: 0.72, g: 0.68, b: 0.52 },
  { l: 0.7, r: 0.72, g: 0.68, b: 0.52 },
  { l: 1.0, r: 0.95, g: 0.92, b: 0.82 },
];


function buildLUTTexture(points) {
  // 按 l 值排序
  const sorted = [...points].sort((a, b) => a.l - b.l);

  // 确保首尾覆盖 [0, 1]
  if (sorted.length === 0) {
    // fallback to default
    return generateDefaultLUT();
  }

  // 创建 RGBA 数据（每像素 4 字节，alpha=255）
  const data = new Uint8Array(LUT_WIDTH * 4);

  for (let i = 0; i < LUT_WIDTH; i++) {
    const luminance = i / (LUT_WIDTH - 1); // 0.0 到 1.0

    // 在控制点之间线性插值
    let r = sorted[0].r;
    let g = sorted[0].g;
    let b = sorted[0].b;

    if (luminance <= sorted[0].l) {
      r = sorted[0].r;
      g = sorted[0].g;
      b = sorted[0].b;
    } else if (luminance >= sorted[sorted.length - 1].l) {
      const last = sorted[sorted.length - 1];
      r = last.r;
      g = last.g;
      b = last.b;
    } else {
      for (let j = 0; j < sorted.length - 1; j++) {
        const a = sorted[j];
        const c = sorted[j + 1];
        if (luminance >= a.l && luminance <= c.l) {
          const t = (luminance - a.l) / (c.l - a.l);
          r = a.r + t * (c.r - a.r);
          g = a.g + t * (c.g - a.g);
          b = a.b + t * (c.b - a.b);
          break;
        }
      }
    }

    // 写入 RGBA
    const offset = i * 4;
    data[offset]     = Math.round(Math.max(0, Math.min(1, r)) * 255);
    data[offset + 1] = Math.round(Math.max(0, Math.min(1, g)) * 255);
    data[offset + 2] = Math.round(Math.max(0, Math.min(1, b)) * 255);
    data[offset + 3] = 255; // alpha
  }

  const texture = new THREE.DataTexture(
    data,
    LUT_WIDTH,
    1,
    THREE.RGBAFormat,
    THREE.UnsignedByteType
  );

  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;

  return texture;
}

/**
 * 生成默认水墨风格 LUT（同步，无需 API）
 * @returns {THREE.DataTexture}
 */
export function generateDefaultLUT() {
  return buildLUTTexture(DEFAULT_PALETTE_POINTS);
}

