import { useCallback, useEffect, useMemo, useState } from 'react'
import type { TaskTemplate, SubgraphTemplate, SubgraphTemplateDetail, SubgraphTemplateNode, SubgraphTemplateNodeType, TaskTemplateArgType } from '../api/templates'
import {
  addSubgraphTemplateEdge,
  addSubgraphTemplateNode,
  createSubgraphTemplate,
  deleteSubgraphTemplate,
  deleteSubgraphTemplateEdge,
  deleteSubgraphTemplateNode,
  getSubgraphTemplate,
  listSubgraphTemplates,
  listTaskTemplates,
  patchSubgraphTemplateNode,
  updateSubgraphTemplate,
} from '../api/templates'

const NODE_W = 130
const NODE_H = 32
const H_GAP = 16
const LAYER_H = 80
const PADDING_TOP = 24
const CANVAS_WIDTH = 320

interface Pos { x: number; y: number }

function computeLayout(nodes: { id: string }[], edges: { from_node_id: string; to_node_id: string }[]): Map<string, Pos> {
  const inDegree = new Map<string, number>()
  const children = new Map<string, string[]>()
  const parents = new Map<string, string[]>()
  for (const n of nodes) { inDegree.set(n.id, 0); children.set(n.id, []); parents.set(n.id, []) }
  for (const e of edges) {
    inDegree.set(e.to_node_id, (inDegree.get(e.to_node_id) ?? 0) + 1)
    children.get(e.from_node_id)?.push(e.to_node_id)
    parents.get(e.to_node_id)?.push(e.from_node_id)
  }
  const layer = new Map<string, number>()
  const processed = new Set<string>()
  const queue: string[] = []
  for (const n of nodes) { if (inDegree.get(n.id) === 0) { layer.set(n.id, 0); queue.push(n.id) } }
  if (queue.length === 0) for (const n of nodes) { layer.set(n.id, 0); queue.push(n.id) }
  let head = 0
  while (head < queue.length) {
    const nodeId = queue[head++]
    if (processed.has(nodeId)) continue
    processed.add(nodeId)
    const nodeLayer = layer.get(nodeId) ?? 0
    for (const childId of (children.get(nodeId) ?? [])) {
      layer.set(childId, Math.max(layer.get(childId) ?? 0, nodeLayer + 1))
      if ((parents.get(childId) ?? []).every((p) => processed.has(p)) && !processed.has(childId)) queue.push(childId)
    }
  }
  for (const n of nodes) { if (!layer.has(n.id)) layer.set(n.id, 0) }
  const layerGroups = new Map<number, string[]>()
  for (const n of nodes) { const l = layer.get(n.id) ?? 0; if (!layerGroups.has(l)) layerGroups.set(l, []); layerGroups.get(l)!.push(n.id) }
  const positions = new Map<string, Pos>()
  for (const [l, ids] of layerGroups) {
    const count = ids.length; const totalW = count * NODE_W + (count - 1) * H_GAP; const startX = Math.max(0, (CANVAS_WIDTH - totalW) / 2)
    ids.forEach((id, i) => { positions.set(id, { x: startX + i * (NODE_W + H_GAP), y: PADDING_TOP + l * LAYER_H }) })
  }
  return positions
}

export default function SubgraphTemplatesPanel({ workspaceId }: { workspaceId: string }) {
  const [templates, setTemplates] = useState<SubgraphTemplate[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [detail, setDetail] = useState<SubgraphTemplateDetail | null>(null)
  const [mutating, setMutating] = useState(false)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null)
  const [taskTemplates, setTaskTemplates] = useState<TaskTemplate[]>([])
  const [allSubgraphs, setAllSubgraphs] = useState<SubgraphTemplate[]>([])

  // Inspector state
  const [editNodeName, setEditNodeName] = useState('')
  const [editNodeType, setEditNodeType] = useState<SubgraphTemplateNodeType>('task_template')
  const [editTaskTemplateId, setEditTaskTemplateId] = useState('')
  const [editRefSubgraphId, setEditRefSubgraphId] = useState('')

  const loadList = useCallback(async () => {
    const ts = await listSubgraphTemplates(workspaceId)
    setTemplates(ts)
    setAllSubgraphs(ts)
    return ts
  }, [workspaceId])

  const loadDetail = useCallback(async (id: string) => {
    const d = await getSubgraphTemplate(workspaceId, id)
    setDetail(d)
    return d
  }, [workspaceId])

  useEffect(() => {
    loadList().then((ts) => { if (ts.length > 0) setActiveId(ts[0].id) })
    listTaskTemplates(workspaceId).then(setTaskTemplates)
  }, [loadList, workspaceId])

  useEffect(() => {
    if (activeId) {
      setSelectedNodeId(null)
      loadDetail(activeId)
    } else {
      setDetail(null)
    }
  }, [activeId, loadDetail])

  useEffect(() => {
    if (!selectedNodeId || !detail) return
    const node = detail.nodes.find((n) => n.id === selectedNodeId)
    if (node) {
      setEditNodeName(node.name ?? '')
      setEditNodeType(node.node_type)
      setEditTaskTemplateId(node.task_template_id ?? '')
      setEditRefSubgraphId(node.ref_subgraph_template_id ?? '')
    }
  }, [selectedNodeId, detail])

  const positions = useMemo(() => {
    if (!detail) return new Map<string, Pos>()
    return computeLayout(detail.nodes, detail.edges)
  }, [detail])

  const canvasHeight = useMemo(() => {
    if (!positions.size) return 100
    let maxY = 0
    for (const pos of positions.values()) maxY = Math.max(maxY, pos.y)
    return maxY + NODE_H + 40
  }, [positions])

  async function handleCreate() {
    const name = window.prompt('Subgraph template name:')
    if (!name?.trim()) return
    setMutating(true)
    try {
      const t = await createSubgraphTemplate(workspaceId, { name: name.trim() })
      await loadList()
      setActiveId(t.id)
    } finally { setMutating(false) }
  }

  async function handleDelete() {
    if (!activeId) return
    if (!window.confirm('Delete this subgraph template?')) return
    setMutating(true)
    try {
      await deleteSubgraphTemplate(workspaceId, activeId)
      const ts = await loadList()
      setActiveId(ts.length > 0 ? ts[0].id : null)
    } finally { setMutating(false) }
  }

  async function handleAddNode() {
    if (!activeId || mutating) return
    setMutating(true)
    try {
      await addSubgraphTemplateNode(workspaceId, activeId, { node_type: 'task_template' })
      await loadDetail(activeId)
    } finally { setMutating(false) }
  }

  async function handleDeleteNode(nodeId: string) {
    if (!activeId || mutating) return
    setMutating(true)
    try {
      await deleteSubgraphTemplateNode(workspaceId, activeId, nodeId)
      if (selectedNodeId === nodeId) setSelectedNodeId(null)
      await loadDetail(activeId)
    } finally { setMutating(false) }
  }

  async function handleAddChild(nodeId: string) {
    if (!activeId || mutating) return
    setMutating(true)
    try {
      const newNode = await addSubgraphTemplateNode(workspaceId, activeId, { node_type: 'task_template' })
      try {
        await addSubgraphTemplateEdge(workspaceId, activeId, nodeId, newNode.id)
      } catch {
        await deleteSubgraphTemplateNode(workspaceId, activeId, newNode.id)
      }
      await loadDetail(activeId)
    } finally { setMutating(false) }
  }

  async function handleDeleteEdge(edgeId: string) {
    if (!activeId || mutating) return
    setMutating(true)
    try {
      await deleteSubgraphTemplateEdge(workspaceId, activeId, edgeId)
      await loadDetail(activeId)
    } finally { setMutating(false) }
  }

  async function handleSaveNode() {
    if (!activeId || !selectedNodeId) return
    setMutating(true)
    try {
      await patchSubgraphTemplateNode(workspaceId, activeId, selectedNodeId, {
        name: editNodeName || undefined,
        node_type: editNodeType,
        task_template_id: editNodeType === 'task_template' ? (editTaskTemplateId || undefined) : undefined,
        ref_subgraph_template_id: editNodeType === 'subgraph_template' ? (editRefSubgraphId || undefined) : undefined,
      })
      await loadDetail(activeId)
    } catch (err) {
      alert(String(err))
    } finally { setMutating(false) }
  }

  const selectedNode = detail?.nodes.find((n) => n.id === selectedNodeId) ?? null

  return (
    <div style={s.wrap}>
      {/* Header */}
      <div style={s.headerBar}>
        <select style={s.select} value={activeId ?? ''} onChange={(e) => setActiveId(e.target.value || null)} disabled={mutating}>
          {templates.length === 0 && <option value="">-- no templates --</option>}
          {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <button style={s.iconBtn} onClick={handleCreate} disabled={mutating} title="New">+</button>
        <button style={{ ...s.iconBtn, opacity: activeId ? 1 : 0.4 }} onClick={handleDelete} disabled={!activeId || mutating} title="Delete">x</button>
      </div>

      {/* Canvas */}
      <div style={s.canvasWrap} onMouseLeave={() => setHoveredNodeId(null)}>
        {detail && detail.nodes.length === 0 && (
          <div style={s.placeholder}>
            No nodes.
            <button style={{ ...s.addBtn, marginTop: 8 }} onClick={handleAddNode} disabled={mutating}>[ + Add Node ]</button>
          </div>
        )}

        {detail && detail.nodes.length > 0 && (
          <div style={{ position: 'relative', width: CANVAS_WIDTH, height: canvasHeight, margin: '0 auto' }}>
            {/* SVG edges */}
            <svg style={{ position: 'absolute', top: 0, left: 0, width: CANVAS_WIDTH, height: canvasHeight, pointerEvents: 'none' }}>
              <defs>
                <marker id="stp-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                  <path d="M0,0 L6,3 L0,6 Z" fill="var(--border)" />
                </marker>
              </defs>
              {detail.edges.map((edge) => {
                const fp = positions.get(edge.from_node_id)
                const tp = positions.get(edge.to_node_id)
                if (!fp || !tp) return null
                const fx = fp.x + NODE_W / 2, fy = fp.y + NODE_H
                const tx = tp.x + NODE_W / 2, ty = tp.y
                const cy = (fy + ty) / 2
                return (
                  <path
                    key={edge.id}
                    d={`M${fx},${fy} C${fx},${cy} ${tx},${cy} ${tx},${ty}`}
                    fill="none" stroke="var(--border)" strokeWidth="1.5" markerEnd="url(#stp-arrow)"
                  />
                )
              })}
            </svg>

            {/* Edge midpoint delete buttons */}
            {detail.edges.map((edge) => {
              const fp = positions.get(edge.from_node_id)
              const tp = positions.get(edge.to_node_id)
              if (!fp || !tp) return null
              const mx = (fp.x + tp.x) / 2 + NODE_W / 2 - 8
              const my = (fp.y + NODE_H + tp.y) / 2 - 8
              return (
                <button
                  key={`del-${edge.id}`}
                  style={{ ...s.plusBtn, left: mx, top: my, background: 'var(--danger)', zIndex: 4 }}
                  onClick={() => handleDeleteEdge(edge.id)}
                  title="Delete edge"
                >x</button>
              )
            })}

            {/* Nodes */}
            {detail.nodes.map((node) => {
              const pos = positions.get(node.id)
              if (!pos) return null
              const isSelected = node.id === selectedNodeId
              const isHovered = node.id === hoveredNodeId
              const label = node.name || node.node_type
              return (
                <div key={node.id}>
                  <div
                    style={{
                      position: 'absolute', left: pos.x, top: pos.y, width: NODE_W, height: NODE_H,
                      background: isSelected ? 'var(--surface-2)' : 'var(--surface)',
                      border: `1px solid ${isSelected ? 'var(--accent)' : 'var(--border)'}`,
                      borderRadius: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '11px', cursor: 'pointer', zIndex: 2, overflow: 'hidden', textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap', padding: '0 4px',
                    }}
                    onClick={() => setSelectedNodeId(node.id === selectedNodeId ? null : node.id)}
                    onMouseEnter={() => setHoveredNodeId(node.id)}
                  >
                    {label}
                  </div>
                  {isHovered && (
                    <>
                      <button
                        style={{ ...s.plusBtn, left: pos.x + NODE_W / 2 - 8, top: pos.y + NODE_H + 2 }}
                        onClick={() => handleAddChild(node.id)}
                        title="Add child"
                      >+</button>
                      <button
                        style={{ ...s.plusBtn, left: pos.x + NODE_W + 2, top: pos.y + NODE_H / 2 - 8, background: 'var(--danger)' }}
                        onClick={() => handleDeleteNode(node.id)}
                        title="Delete node"
                      >x</button>
                    </>
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
          <div style={s.inspTitle}>Node</div>
          <div style={s.row}>
            <span style={s.label}>Name</span>
            <input style={s.input} value={editNodeName} onChange={(e) => setEditNodeName(e.target.value)} />
          </div>
          <div style={s.row}>
            <span style={s.label}>Type</span>
            <select style={s.sel} value={editNodeType} onChange={(e) => setEditNodeType(e.target.value as SubgraphTemplateNodeType)}>
              <option value="task_template">task_template</option>
              <option value="subgraph_template">subgraph_template</option>
            </select>
          </div>
          {editNodeType === 'task_template' && (
            <div style={s.row}>
              <span style={s.label}>Task</span>
              <select style={s.sel} value={editTaskTemplateId} onChange={(e) => setEditTaskTemplateId(e.target.value)}>
                <option value="">-- select --</option>
                {taskTemplates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          )}
          {editNodeType === 'subgraph_template' && (
            <div style={s.row}>
              <span style={s.label}>Sub</span>
              <select style={s.sel} value={editRefSubgraphId} onChange={(e) => setEditRefSubgraphId(e.target.value)}>
                <option value="">-- select --</option>
                {allSubgraphs.filter((t) => t.id !== activeId).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          )}
          <button style={s.saveBtn} onClick={handleSaveNode} disabled={mutating}>Save Node</button>
          <button style={s.deleteBtn} onClick={() => selectedNodeId && handleDeleteNode(selectedNodeId)} disabled={mutating}>
            [ Delete Node ]
          </button>
        </div>
      )}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  wrap: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  headerBar: {
    display: 'flex', alignItems: 'center', gap: '4px', padding: '6px 8px',
    borderBottom: '1px solid var(--border)', flexShrink: 0,
  },
  select: {
    flex: 1, padding: '4px 8px', border: '1px solid var(--border)', borderRadius: '4px',
    background: 'var(--surface-2)', color: 'var(--text)', outline: 'none', fontSize: '12px', minWidth: 0,
  },
  iconBtn: {
    padding: '4px 8px', background: 'transparent', color: 'var(--text-dim)',
    border: '1px solid var(--border)', borderRadius: '4px', cursor: 'pointer',
    fontSize: '14px', lineHeight: '1', flexShrink: 0,
  },
  canvasWrap: { flex: 1, overflowY: 'auto', overflowX: 'auto', position: 'relative' },
  placeholder: {
    color: 'var(--text-muted)', padding: '24px 12px', textAlign: 'center',
    display: 'flex', flexDirection: 'column', alignItems: 'center', fontSize: '13px',
  },
  addBtn: {
    background: 'transparent', color: 'var(--accent)', border: '1px solid var(--border)',
    borderRadius: '4px', cursor: 'pointer', fontSize: '12px', padding: '4px 10px',
  },
  plusBtn: {
    position: 'absolute', width: '16px', height: '16px', background: 'var(--accent)', color: '#fff',
    border: 'none', borderRadius: '3px', cursor: 'pointer', fontSize: '14px', lineHeight: '14px',
    padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10,
  },
  inspector: {
    borderTop: '1px solid var(--border)', padding: '8px 10px', background: 'var(--surface)', flexShrink: 0,
  },
  inspTitle: {
    color: 'var(--text-muted)', marginBottom: '6px', fontSize: '11px', fontWeight: 600,
    textTransform: 'uppercase' as const, letterSpacing: '0.08em',
  },
  row: { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' },
  label: { color: 'var(--text-dim)', flexShrink: 0, width: '36px', fontSize: '12px' },
  input: {
    flex: 1, padding: '3px 7px', border: '1px solid var(--border)', borderRadius: '4px',
    background: 'var(--surface-2)', color: 'var(--text)', outline: 'none', fontSize: '12px',
  },
  sel: {
    flex: 1, padding: '3px 7px', border: '1px solid var(--border)', borderRadius: '4px',
    background: 'var(--surface-2)', color: 'var(--text)', outline: 'none', fontSize: '12px',
  },
  saveBtn: {
    marginTop: '6px', padding: '4px 10px', background: 'var(--accent)', color: '#fff',
    border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', width: '100%',
  },
  deleteBtn: {
    marginTop: '4px', padding: '3px 8px', background: 'transparent', color: 'var(--danger)',
    border: '1px solid var(--danger)', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', width: '100%',
  },
}
