/** Validate the backend's flat, parent-local v2 model without rewriting its source. */
export function validateActorModel(value: unknown): void {
  const model = value as { nodes?: Array<{ id: string; parent?: string; transform?: Record<string, unknown>; mesh?: { type?: string } }> };
  if (!model || !Array.isArray(model.nodes) || !model.nodes.length) throw new Error('模型缺少 nodes 数据');
  const nodes = new Map(model.nodes.map((node) => [node?.id, node]));
  if (nodes.size !== model.nodes.length) throw new Error('模型节点 ID 重复');
  for (const node of model.nodes) {
    if (!node || typeof node.id !== 'string' || !node.id) throw new Error('模型节点 ID 无效');
    const seen = new Set([node.id]);
    let parent = node.parent;
    while (parent) {
      if (!nodes.has(parent)) throw new Error(`模型缺少父节点：${parent}`);
      if (seen.has(parent)) throw new Error('模型层级存在循环');
      seen.add(parent);
      parent = nodes.get(parent)?.parent;
    }
    for (const [key, length] of [['pos', 3], ['quat', 4], ['scale', 3]] as const) {
      const vector = node.transform?.[key];
      if (vector !== undefined && (!Array.isArray(vector) || vector.length !== length || !vector.every(Number.isFinite))) {
        throw new Error(`模型 ${node.id} 的 ${key} 无效`);
      }
    }
    if (node.mesh && !['box', 'sphere', 'cylinder', 'cone', 'torus', 'wedge', 'tri', 'patch', 'icosahedron', 'dodecahedron', 'octahedron'].includes(node.mesh.type ?? '')) {
      throw new Error(`不支持的模型几何体：${node.mesh.type}`);
    }
  }
}
