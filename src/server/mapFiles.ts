import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import {
  normalizeMap,
  type EditableMap,
} from "../client/rendering/map/shared/map";
import {
  normalizeRenderScheme,
  type RenderScheme,
} from "../client/rendering/map/shared/renderScheme";
import {
  decodeWorldForgeTransfer,
  renderSchemeHdriFile,
} from "../client/rendering/map/shared/scenePackage";
import type { MapResource } from "../shared/maps";
const MAX_EXPANDED = 128 * 1024 * 1024;
export function decodeMapFile(
  bytes: Uint8Array,
  existing?: MapResource,
): Omit<MapResource, "id" | "updatedAt"> {
  let resource: Omit<MapResource, "id" | "updatedAt">;
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    let size = 0;
    const files = unzipSync(bytes, {
      filter: (entry) => {
        if (
          entry.name.includes("\\") ||
          entry.name.startsWith("/") ||
          entry.name.split("/").includes("..") ||
          entry.name.includes(":")
        )
          throw new Error("地图包包含不安全路径");
        size += entry.originalSize;
        if (size > MAX_EXPANDED) throw new Error("地图包解压后超过 128 MB");
        return true;
      },
    });
    const manifest = JSON.parse(
      strFromU8(files["manifest.json"] ?? new Uint8Array()),
    );
    if (manifest.kind === "lifetime-scene" && manifest.schemaVersion === 1) {
      const doc = JSON.parse(
        strFromU8(files["scene.json"] ?? new Uint8Array()),
      );
      validateRawMap(doc.map);
      resource = {
        name: doc.name,
        map: normalizeMap(doc.map),
        scheme: doc.scheme ? normalizeRenderScheme(doc.scheme) : null,
      };
      if (doc.hdriFile) {
        const hdri = files[`hdri/${doc.hdriFile}`];
        if (!hdri) throw new Error("地图包缺少 HDRI");
        resource.hdri = {
          file: doc.hdriFile,
          base64: Buffer.from(hdri).toString("base64"),
        };
      }
    } else {
      if (manifest.kind !== "worldforge-scene" || manifest.schemaVersion !== 1)
        throw new Error("不支持的场景包版本");
      validateRawMap(
        JSON.parse(strFromU8(files[manifest.files?.map] ?? new Uint8Array())),
      );
      const transfer = decodeWorldForgeTransfer(bytes);
      if (transfer.kind !== "scene") throw new Error("场景包格式无效");
      resource = {
        name: transfer.map.name,
        map: transfer.map,
        scheme: transfer.renderScheme,
      };
      if (transfer.hdri)
        resource.hdri = {
          file: transfer.hdri.file,
          base64: Buffer.from(transfer.hdri.bytes).toString("base64"),
        };
    }
  } else {
    const input = JSON.parse(strFromU8(bytes));
    if (input.kind === "worldforge-map") validateRawMap(input.map);
    const transfer = decodeWorldForgeTransfer(bytes);
    if (transfer.kind === "render-scheme") {
      if (!existing) throw new Error("请先打开地图，再导入渲染方案");
      resource = {
        name: existing.name,
        map: structuredClone(existing.map),
        scheme: transfer.renderScheme,
        hdri: existing.hdri,
      };
    } else if (transfer.kind === "map") {
      if (transfer.map.renderSchemeId)
        throw new Error(
          "地图引用了单独保存的渲染方案，请从原项目导出完整场景 ZIP 后导入",
        );
      resource = { name: transfer.map.name, map: transfer.map, scheme: null };
    } else throw new Error("不支持的地图文件");
  }
  validateMapResource(resource);
  return resource;
}
export function validateMapResource(
  resource: Pick<MapResource, "map" | "scheme" | "hdri">,
): void {
  if (
    !resource.map ||
    !Array.isArray(resource.map.assets) ||
    !Array.isArray(resource.map.objects)
  )
    throw new Error("地图数据无效");
  if (
    resource.hdri &&
    (!/^[^<>:"|?*\\/]+\.(hdr|exr|png|jpe?g)$/i.test(resource.hdri.file) ||
      resource.hdri.file.includes(".."))
  )
    throw new Error("环境贴图文件名无效");
  const ids = new Set(resource.map.assets.map((a) => a.id));
  for (const asset of resource.map.assets) {
    if (!(asset.modelJson as { nodes?: unknown[] })?.nodes?.length)
      throw new Error(
        `地图缺少模型资源：${asset.name}。请导入内含模型的完整场景包`,
      );
  }
  for (const object of resource.map.objects)
    if (object.assetId && !ids.has(object.assetId))
      throw new Error(`地图对象缺少资源：${object.name}`);
  const hdri = resource.scheme && renderSchemeHdriFile(resource.scheme);
  if (hdri && (resource.hdri?.file !== hdri || !resource.hdri.base64))
    throw new Error(`缺少环境贴图 ${hdri}，请导入包含 HDRI 的完整场景 ZIP`);
}
function validateRawMap(value: unknown): void {
  const map = value as Partial<EditableMap> | null;
  if (
    !map ||
    typeof map.name !== "string" ||
    !Array.isArray(map.assets) ||
    !Array.isArray(map.objects) ||
    !map.terrain ||
    !Array.isArray(map.terrain.heights)
  )
    throw new Error("地图文件缺少必要数据");
}
export function encodeMapFile(resource: MapResource): Uint8Array {
  validateMapResource(resource);
  const files: Record<string, Uint8Array> = {
    "manifest.json": strToU8(
      JSON.stringify({ kind: "lifetime-scene", schemaVersion: 1 }),
    ),
    "scene.json": strToU8(
      JSON.stringify({
        name: resource.name,
        map: resource.map,
        scheme: resource.scheme,
        hdriFile: resource.hdri?.file,
      }),
    ),
  };
  if (resource.hdri)
    files[`hdri/${resource.hdri.file}`] = Buffer.from(
      resource.hdri.base64,
      "base64",
    );
  return zipSync(files);
}
