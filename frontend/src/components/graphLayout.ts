// ─── Layout constants ────────────────────────────────────────────────────────

export const NODE_W = 130
export const NODE_H = 32
export const H_GAP = 16
export const LAYER_H = 120
export const PADDING_TOP = 24
export const CANVAS_WIDTH = 320

// ─── BFS layer layout ────────────────────────────────────────────────────────

export interface Pos { x: number; y: number }

export interface LayoutInput {
  nodes: { id: string }[]
  edges: { from_node_id: string; to_node_id: string }[]
}

export function computeLayout(detail: LayoutInput): Map<string, Pos> {
  const { nodes, edges } = detail
  const inDegree = new Map<string, number>()
  const children = new Map<string, string[]>()
  const parents = new Map<string, string[]>()

  for (const n of nodes) {
    inDegree.set(n.id, 0)
    children.set(n.id, [])
    parents.set(n.id, [])
  }
  for (const e of edges) {
    inDegree.set(e.to_node_id, (inDegree.get(e.to_node_id) ?? 0) + 1)
    children.get(e.from_node_id)?.push(e.to_node_id)
    parents.get(e.to_node_id)?.push(e.from_node_id)
  }

  const layer = new Map<string, number>()
  const processed = new Set<string>()
  const queue: string[] = []

  for (const n of nodes) {
    if (inDegree.get(n.id) === 0) {
      layer.set(n.id, 0)
      queue.push(n.id)
    }
  }

  // Fallback: if no roots (cycle), assign all to layer 0
  if (queue.length === 0) {
    for (const n of nodes) {
      layer.set(n.id, 0)
      queue.push(n.id)
    }
  }

  let head = 0
  while (head < queue.length) {
    const nodeId = queue[head++]
    if (processed.has(nodeId)) continue
    processed.add(nodeId)
    const nodeLayer = layer.get(nodeId) ?? 0
    for (const childId of (children.get(nodeId) ?? [])) {
      const current = layer.get(childId) ?? 0
      layer.set(childId, Math.max(current, nodeLayer + 1))
      // Enqueue when all parents processed
      const allParentsDone = (parents.get(childId) ?? []).every((p) => processed.has(p))
      if (allParentsDone && !processed.has(childId)) {
        queue.push(childId)
      }
    }
  }

  // Ensure any unprocessed nodes get a layer
  for (const n of nodes) {
    if (!layer.has(n.id)) layer.set(n.id, 0)
  }

  // Group by layer
  const layerGroups = new Map<number, string[]>()
  for (const n of nodes) {
    const l = layer.get(n.id) ?? 0
    if (!layerGroups.has(l)) layerGroups.set(l, [])
    layerGroups.get(l)!.push(n.id)
  }

  // Compute positions
  const positions = new Map<string, Pos>()
  for (const [l, ids] of layerGroups) {
    const count = ids.length
    const totalW = count * NODE_W + (count - 1) * H_GAP
    const startX = Math.max(0, (CANVAS_WIDTH - totalW) / 2)
    ids.forEach((id, i) => {
      positions.set(id, {
        x: startX + i * (NODE_W + H_GAP),
        y: PADDING_TOP + l * LAYER_H,
      })
    })
  }

  return positions
}
