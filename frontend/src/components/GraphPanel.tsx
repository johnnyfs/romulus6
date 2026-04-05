import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  type Graph,
  type GraphDetail,
  type AgentConfig,
  type GraphNode,
  type NodeType,
  addEdge,
  addNode,
  createGraph,
  deleteGraph,
  deleteNode,
  getGraph,
  listGraphs,
  patchNode,
} from '../api/graphs'

// ─── Layout constants ────────────────────────────────────────────────────────

const NODE_W = 130
const NODE_H = 32
const H_GAP = 16
const LAYER_H = 80
const PADDING_TOP = 24
const CANVAS_WIDTH = 320

const MODEL_OPTIONS = [
  { value: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { value: 'anthropic/claude-opus-4-6', label: 'Claude Opus 4.6' },
  { value: 'anthropic/claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  { value: 'openai/gpt-4o', label: 'GPT-4o' },
  { value: 'openai/gpt-4o-mini', label: 'GPT-4o Mini' },
  { value: 'openai/o3-mini', label: 'o3 Mini' },
]

// ─── BFS layer layout ────────────────────────────────────────────────────────

interface Pos { x: number; y: number }

function computeLayout(detail: GraphDetail): Map<string, Pos> {
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

// ─── Component ───────────────────────────────────────────────────────────────

export default function GraphPanel({ workspaceId, width }: { workspaceId: string; width?: number }) {
  const [graphs, setGraphs] = useState<Graph[]>([])
  const [activeGraphId, setActiveGraphId] = useState<string | null>(null)
  const [detail, setDetail] = useState<GraphDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [mutating, setMutating] = useState(false)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editType, setEditType] = useState<NodeType>('nop')
  const [editModel, setEditModel] = useState(MODEL_OPTIONS[0].value)
  const [editPrompt, setEditPrompt] = useState('')

  // ── Data loading ─────────────────────────────────────────────────────────

  const loadGraphs = useCallback(async () => {
    const gs = await listGraphs(workspaceId)
    setGraphs(gs)
    return gs
  }, [workspaceId])

  const loadDetail = useCallback(async (graphId: string) => {
    setLoading(true)
    try {
      const d = await getGraph(workspaceId, graphId)
      setDetail(d)
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => {
    loadGraphs().then((gs) => {
      if (gs.length > 0) setActiveGraphId(gs[0].id)
    })
  }, [loadGraphs])

  useEffect(() => {
    if (activeGraphId) {
      setSelectedNodeId(null)
      loadDetail(activeGraphId)
    } else {
      setDetail(null)
    }
  }, [activeGraphId, loadDetail])

  // Seed inspector when selection changes
  useEffect(() => {
    if (!selectedNodeId || !detail) return
    const node = detail.nodes.find((n) => n.id === selectedNodeId)
    if (node) {
      setEditName(node.name ?? '')
      setEditType(node.node_type)
      if (node.agent_config) {
        setEditModel(node.agent_config.model)
        setEditPrompt(node.agent_config.prompt)
      } else {
        setEditModel(MODEL_OPTIONS[0].value)
        setEditPrompt('')
      }
    }
  }, [selectedNodeId, detail])

  // ── Layout ───────────────────────────────────────────────────────────────

  const positions = useMemo(() => {
    if (!detail) return new Map<string, Pos>()
    return computeLayout(detail)
  }, [detail])

  const canvasHeight = useMemo(() => {
    if (!positions.size) return 100
    let maxY = 0
    for (const pos of positions.values()) maxY = Math.max(maxY, pos.y)
    return maxY + NODE_H + 40
  }, [positions])

  // ── Actions ───────────────────────────────────────────────────────────────

  async function handleCreateGraph() {
    const name = window.prompt('Graph name:')
    if (!name?.trim()) return
    setMutating(true)
    try {
      const g = await createGraph(workspaceId, name.trim())
      const gs = await loadGraphs()
      setActiveGraphId(g.id)
      setGraphs(gs)
      setDetail(g)
    } finally {
      setMutating(false)
    }
  }

  async function handleDeleteGraph() {
    if (!activeGraphId) return
    if (!window.confirm('Delete this graph?')) return
    setMutating(true)
    try {
      await deleteGraph(workspaceId, activeGraphId)
      const gs = await loadGraphs()
      setGraphs(gs)
      if (gs.length > 0) {
        setActiveGraphId(gs[0].id)
      } else {
        setActiveGraphId(null)
        setDetail(null)
      }
    } finally {
      setMutating(false)
    }
  }

  function nextNodeName(base: string): string {
    const existingNames = new Set((detail?.nodes ?? []).map((n) => n.name ?? n.node_type))
    if (!existingNames.has(base)) return base
    let n = 2
    while (existingNames.has(`${base} ${n}`)) n++
    return `${base} ${n}`
  }

  async function handleAddStandaloneNode() {
    if (!activeGraphId) return
    setMutating(true)
    try {
      await addNode(workspaceId, activeGraphId, nextNodeName('nop'))
      await loadDetail(activeGraphId)
    } finally {
      setMutating(false)
    }
  }

  async function handleAddParent(nodeId: string) {
    if (!activeGraphId || mutating) return
    setMutating(true)
    try {
      const newNode = await addNode(workspaceId, activeGraphId, nextNodeName('nop'))
      try {
        await addEdge(workspaceId, activeGraphId, newNode.id, nodeId)
      } catch (err) {
        alert(`Cannot add dependency: ${String(err)}`)
        await deleteNode(workspaceId, activeGraphId, newNode.id)
      }
      await loadDetail(activeGraphId)
    } finally {
      setMutating(false)
    }
  }

  async function handleAddSibling(nodeId: string) {
    if (!activeGraphId || mutating || !detail) return
    setMutating(true)
    try {
      const newNode = await addNode(workspaceId, activeGraphId, nextNodeName('nop'))
      const parentIds = detail.edges
        .filter((e) => e.to_node_id === nodeId)
        .map((e) => e.from_node_id)
      for (const parentId of parentIds) {
        try {
          await addEdge(workspaceId, activeGraphId, parentId, newNode.id)
        } catch {
          // skip if this edge would create a cycle (shouldn't happen for siblings)
        }
      }
      await loadDetail(activeGraphId)
    } finally {
      setMutating(false)
    }
  }

  async function handleAddChild(nodeId: string) {
    if (!activeGraphId || mutating) return
    setMutating(true)
    try {
      const newNode = await addNode(workspaceId, activeGraphId, nextNodeName('nop'))
      try {
        await addEdge(workspaceId, activeGraphId, nodeId, newNode.id)
      } catch (err) {
        alert(`Cannot add dependent: ${String(err)}`)
        await deleteNode(workspaceId, activeGraphId, newNode.id)
      }
      await loadDetail(activeGraphId)
    } finally {
      setMutating(false)
    }
  }

  async function handleSaveName() {
    if (!selectedNodeId || !activeGraphId || !detail) return
    const node = detail.nodes.find((n) => n.id === selectedNodeId)
    if (!node || node.name === (editName || null)) return
    const updated = await patchNode(workspaceId, activeGraphId, selectedNodeId, {
      name: editName || undefined,
    })
    setDetail((prev) =>
      prev
        ? { ...prev, nodes: prev.nodes.map((n) => (n.id === updated.id ? updated : n)) }
        : prev,
    )
  }

  async function handleSaveType(val: NodeType) {
    if (!selectedNodeId || !activeGraphId) return
    const patch: { node_type: NodeType; agent_config?: AgentConfig } = { node_type: val }
    if (val === 'agent') {
      patch.agent_config = { agent_type: 'opencode', model: editModel, prompt: editPrompt }
    }
    const updated = await patchNode(workspaceId, activeGraphId, selectedNodeId, patch)
    setDetail((prev) =>
      prev
        ? { ...prev, nodes: prev.nodes.map((n) => (n.id === updated.id ? updated : n)) }
        : prev,
    )
  }

  async function handleSaveAgentConfig(overrides?: Partial<AgentConfig>) {
    if (!selectedNodeId || !activeGraphId) return
    const config: AgentConfig = {
      agent_type: 'opencode',
      model: overrides?.model ?? editModel,
      prompt: overrides?.prompt ?? editPrompt,
    }
    const updated = await patchNode(workspaceId, activeGraphId, selectedNodeId, {
      agent_config: config,
    })
    setDetail((prev) =>
      prev
        ? { ...prev, nodes: prev.nodes.map((n) => (n.id === updated.id ? updated : n)) }
        : prev,
    )
  }

  async function handleDeleteSelectedNode() {
    if (!selectedNodeId || !activeGraphId) return
    setMutating(true)
    try {
      await deleteNode(workspaceId, activeGraphId, selectedNodeId)
      setSelectedNodeId(null)
      await loadDetail(activeGraphId)
    } finally {
      setMutating(false)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const selectedNode = detail?.nodes.find((n) => n.id === selectedNodeId) ?? null

  return (
    <div style={width !== undefined ? { ...s.panel, width } : s.panel}>
      {/* Title */}
      <div style={s.title}>GRAPHS</div>

      {/* Header bar: selector + new + delete */}
      <div style={s.headerBar}>
        <select
          style={s.graphSelect}
          value={activeGraphId ?? ''}
          onChange={(e) => setActiveGraphId(e.target.value || null)}
          disabled={mutating}
        >
          {graphs.length === 0 && <option value="">-- no graphs --</option>}
          {graphs.map((g) => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
        </select>
        <button style={s.iconBtn} onClick={handleCreateGraph} disabled={mutating} title="New graph">
          +
        </button>
        <button
          style={{ ...s.iconBtn, opacity: activeGraphId ? 1 : 0.4 }}
          onClick={handleDeleteGraph}
          disabled={!activeGraphId || mutating}
          title="Delete graph"
        >
          ×
        </button>
      </div>

      {/* Canvas area */}
      <div
        style={s.canvasWrap}
        onMouseLeave={() => setHoveredNodeId(null)}
      >
        {loading && <div style={s.placeholder}>LOADING...</div>}

        {!loading && !detail && graphs.length === 0 && (
          <div style={s.placeholder}>No graphs.{'\n'}Press + to create one.</div>
        )}

        {!loading && detail && detail.nodes.length === 0 && (
          <div style={s.placeholder}>
            No nodes.
            <button style={{ ...s.addFirstBtn, marginTop: 8 }} onClick={handleAddStandaloneNode} disabled={mutating}>
              [ + Add Node ]
            </button>
          </div>
        )}

        {!loading && detail && detail.nodes.length > 0 && (
          <div style={{ position: 'relative', height: canvasHeight, minWidth: CANVAS_WIDTH }}>
            {/* SVG edges */}
            <svg
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: canvasHeight, pointerEvents: 'none' }}
            >
              <defs>
                <marker
                  id="gp-arrow"
                  markerWidth="8"
                  markerHeight="8"
                  refX="4"
                  refY="4"
                  orient="auto"
                >
                  <path d="M0,0 L0,8 L8,4 Z" fill="var(--border)" />
                </marker>
              </defs>
              {detail.edges.map((edge) => {
                const from = positions.get(edge.from_node_id)
                const to = positions.get(edge.to_node_id)
                if (!from || !to) return null
                const fx = from.x + NODE_W / 2
                const fy = from.y + NODE_H
                const tx = to.x + NODE_W / 2
                const ty = to.y
                const cy = (fy + ty) / 2
                return (
                  <path
                    key={edge.id}
                    d={`M${fx},${fy} C${fx},${cy} ${tx},${cy} ${tx},${ty}`}
                    stroke="var(--border)"
                    strokeWidth="1.5"
                    fill="none"
                    markerEnd="url(#gp-arrow)"
                  />
                )
              })}
            </svg>

            {/* Nodes */}
            {detail.nodes.map((node) => {
              const pos = positions.get(node.id)
              if (!pos) return null
              const isSelected = node.id === selectedNodeId
              const isHovered = node.id === hoveredNodeId

              return (
                <div key={node.id} style={{ position: 'absolute', left: 0, top: 0, zIndex: isHovered ? 5 : 1 }}>
                  {/* Add parent button */}
                  {isHovered && (
                    <button
                      style={{
                        ...s.plusBtn,
                        left: pos.x + NODE_W / 2 - 8,
                        top: pos.y - 18,
                      }}
                      onMouseDown={(e) => { e.stopPropagation(); handleAddParent(node.id) }}
                      title="Add dependency (parent)"
                    >
                      +
                    </button>
                  )}

                  {/* Node box */}
                  <div
                    style={{
                      position: 'absolute',
                      left: pos.x,
                      top: pos.y,
                      width: NODE_W,
                      height: NODE_H,
                      background: isSelected ? 'var(--surface-2)' : 'var(--surface)',
                      border: `1px solid ${isSelected ? 'var(--accent)' : 'var(--border)'}`,
                      borderRadius: '4px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer',
                      fontSize: '12px',
                      userSelect: 'none',
                      boxSizing: 'border-box',
                      overflow: 'hidden',
                      whiteSpace: 'nowrap',
                      textOverflow: 'ellipsis',
                      paddingInline: 8,
                      color: isSelected ? 'var(--accent)' : 'var(--text)',
                    }}
                    onClick={() => setSelectedNodeId(node.id === selectedNodeId ? null : node.id)}
                    onMouseEnter={() => setHoveredNodeId(node.id)}
                  >
                    {node.name || (node.agent_config
                      ? MODEL_OPTIONS.find(m => m.value === node.agent_config!.model)?.label ?? 'agent'
                      : node.node_type)}
                  </div>

                  {/* Add sibling left button */}
                  {isHovered && (
                    <button
                      style={{
                        ...s.plusBtn,
                        left: pos.x - 18,
                        top: pos.y + NODE_H / 2 - 8,
                      }}
                      onMouseDown={(e) => { e.stopPropagation(); handleAddSibling(node.id) }}
                      title="Add sibling (same parents)"
                    >
                      +
                    </button>
                  )}

                  {/* Add sibling right button */}
                  {isHovered && (
                    <button
                      style={{
                        ...s.plusBtn,
                        left: pos.x + NODE_W + 2,
                        top: pos.y + NODE_H / 2 - 8,
                      }}
                      onMouseDown={(e) => { e.stopPropagation(); handleAddSibling(node.id) }}
                      title="Add sibling (same parents)"
                    >
                      +
                    </button>
                  )}

                  {/* Add child button */}
                  {isHovered && (
                    <button
                      style={{
                        ...s.plusBtn,
                        left: pos.x + NODE_W / 2 - 8,
                        top: pos.y + NODE_H + 2,
                      }}
                      onMouseDown={(e) => { e.stopPropagation(); handleAddChild(node.id) }}
                      title="Add dependent (child)"
                    >
                      +
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Inspector */}
      {selectedNode && (
        <div style={s.inspector}>
          <div style={s.inspectorTitle}>NODE INSPECTOR</div>
          <div style={s.inspectorRow}>
            <label style={s.inspectorLabel}>Name:</label>
            <input
              style={s.inspectorInput}
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onBlur={handleSaveName}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSaveName() }}
              placeholder={selectedNode.node_type}
            />
          </div>
          <div style={s.inspectorRow}>
            <label style={s.inspectorLabel}>Type:</label>
            <select
              style={s.inspectorSelect}
              value={editType}
              onChange={(e) => {
                const val = e.target.value as NodeType
                setEditType(val)
                handleSaveType(val)
              }}
            >
              <option value="nop">nop</option>
              <option value="agent">agent</option>
            </select>
          </div>
          {editType === 'agent' && (
            <>
              <div style={s.inspectorRow}>
                <label style={s.inspectorLabel}>Model:</label>
                <select
                  style={s.inspectorSelect}
                  value={editModel}
                  onChange={(e) => {
                    setEditModel(e.target.value)
                    handleSaveAgentConfig({ model: e.target.value })
                  }}
                >
                  {MODEL_OPTIONS.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              </div>
              <div style={{ ...s.inspectorRow, alignItems: 'flex-start' }}>
                <label style={{ ...s.inspectorLabel, marginTop: 4 }}>Prompt:</label>
                <textarea
                  style={{ ...s.inspectorInput, minHeight: 60, resize: 'vertical', fontFamily: 'inherit' }}
                  value={editPrompt}
                  onChange={(e) => setEditPrompt(e.target.value)}
                  onBlur={() => handleSaveAgentConfig()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      handleSaveAgentConfig()
                    }
                  }}
                  placeholder="Enter agent prompt..."
                />
              </div>
            </>
          )}
          <button style={s.deleteNodeBtn} onClick={handleDeleteSelectedNode} disabled={mutating}>
            [ Delete Node ]
          </button>
        </div>
      )}
    </div>
  )
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  panel: {
    width: '340px',
    flexShrink: 0,
    background: 'var(--surface)',
    display: 'flex',
    flexDirection: 'column',
    borderLeft: '1px solid var(--border)',
    overflow: 'hidden',
    fontSize: '13px',
    color: 'var(--text)',
  },
  title: {
    color: 'var(--text-muted)',
    fontSize: '11px',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    padding: '8px 12px 4px',
    flexShrink: 0,
    borderBottom: '1px solid var(--border)',
  },
  headerBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    padding: '6px 8px',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0,
  },
  graphSelect: {
    flex: 1,
    padding: '4px 8px',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    background: 'var(--surface-2)',
    color: 'var(--text)',
    outline: 'none',
    fontSize: '12px',
    minWidth: 0,
  },
  iconBtn: {
    padding: '4px 8px',
    background: 'transparent',
    color: 'var(--text-dim)',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '14px',
    lineHeight: 1,
    flexShrink: 0,
  },
  canvasWrap: {
    flex: 1,
    overflowY: 'auto',
    overflowX: 'auto',
    position: 'relative',
  },
  placeholder: {
    color: 'var(--text-muted)',
    padding: '24px 12px',
    textAlign: 'center',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    fontSize: '13px',
    whiteSpace: 'pre-wrap',
  },
  addFirstBtn: {
    background: 'transparent',
    color: 'var(--accent)',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '12px',
    padding: '4px 10px',
  },
  plusBtn: {
    position: 'absolute',
    width: '16px',
    height: '16px',
    background: 'var(--accent)',
    color: '#ffffff',
    border: 'none',
    borderRadius: '3px',
    cursor: 'pointer',
    fontSize: '14px',
    lineHeight: '14px',
    padding: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  inspector: {
    borderTop: '1px solid var(--border)',
    padding: '8px 10px',
    background: 'var(--surface)',
    flexShrink: 0,
  },
  inspectorTitle: {
    color: 'var(--text-muted)',
    marginBottom: '6px',
    fontSize: '11px',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
  },
  inspectorRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    marginBottom: '4px',
  },
  inspectorLabel: {
    color: 'var(--text-dim)',
    flexShrink: 0,
    width: '36px',
    fontSize: '12px',
  },
  inspectorInput: {
    flex: 1,
    padding: '3px 7px',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    background: 'var(--surface-2)',
    color: 'var(--text)',
    outline: 'none',
    fontSize: '12px',
  },
  inspectorSelect: {
    flex: 1,
    padding: '3px 7px',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    background: 'var(--surface-2)',
    color: 'var(--text)',
    outline: 'none',
    fontSize: '12px',
  },
  deleteNodeBtn: {
    marginTop: '4px',
    padding: '3px 8px',
    background: 'transparent',
    color: 'var(--danger)',
    border: '1px solid var(--danger)',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '12px',
  },
}
