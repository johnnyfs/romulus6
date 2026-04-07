import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { SUPPORTED_MODELS_BY_AGENT_TYPE } from '../api/models'
import type { TaskTemplate, TaskTemplateArgument, SubgraphTemplate, SubgraphTemplateDetail, SubgraphTemplateNodeType } from '../api/templates'
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
import {
  WORKSPACE_DETAIL_PARAM_KEYS,
  mergeSearchParams,
  readStringParam,
} from './workspaceDetailSearchParams'

const NODE_W = 130
const NODE_H = 32
const H_GAP = 16
const LAYER_H = 80
const PADDING_TOP = 24
const CANVAS_WIDTH = 320

const MODEL_OPTIONS = SUPPORTED_MODELS_BY_AGENT_TYPE.opencode

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
  const [searchParams, setSearchParams] = useSearchParams()
  const [templates, setTemplates] = useState<SubgraphTemplate[]>([])
  const [detail, setDetail] = useState<SubgraphTemplateDetail | null>(null)
  const [editLabel, setEditLabel] = useState('')
  const [mutating, setMutating] = useState(false)
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null)
  const [taskTemplates, setTaskTemplates] = useState<TaskTemplate[]>([])
  const [allSubgraphs, setAllSubgraphs] = useState<SubgraphTemplate[]>([])

  // Draft state for node inspector
  const [editNodeName, setEditNodeName] = useState('')
  const [editNodeType, setEditNodeType] = useState<SubgraphTemplateNodeType>('agent')
  const [editModel, setEditModel] = useState(MODEL_OPTIONS[0].value)
  const [editPrompt, setEditPrompt] = useState('')
  const [editCommand, setEditCommand] = useState('')
  const [editGraphTools, setEditGraphTools] = useState(false)
  const [editTaskTemplateId, setEditTaskTemplateId] = useState('')
  const [editRefSubgraphId, setEditRefSubgraphId] = useState('')
  const [editBindings, setEditBindings] = useState<Record<string, string>>({})
  const [nodeDirty, setNodeDirty] = useState(false)

  // Draft state for subgraph template arguments
  const [editArgs, setEditArgs] = useState<{ name: string; arg_type: TaskTemplateArgument['arg_type']; default_value: string; min_value: string; max_value: string; enum_options: string[] }[]>([])
  const [showArgs, setShowArgs] = useState(false)
  const [argsDirty, setArgsDirty] = useState(false)

  // Cache of fetched subgraph template details (for argument lists)
  const [sgDetailCache, setSgDetailCache] = useState<Record<string, SubgraphTemplateDetail>>({})
  const activeId = readStringParam(searchParams, WORKSPACE_DETAIL_PARAM_KEYS.subgraphTemplateId)
  const selectedNodeId = readStringParam(searchParams, WORKSPACE_DETAIL_PARAM_KEYS.templateNodeId)

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

  const updateUrlState = useCallback(
    (updates: Record<string, string | null>, replace = false) => {
      setSearchParams((prev) => mergeSearchParams(prev, updates), { replace })
    },
    [setSearchParams],
  )

  const setActiveId = useCallback(
    (templateId: string | null, replace = false) => {
      updateUrlState(
        {
          [WORKSPACE_DETAIL_PARAM_KEYS.subgraphTemplateId]: templateId,
          [WORKSPACE_DETAIL_PARAM_KEYS.templateNodeId]: null,
        },
        replace,
      )
    },
    [updateUrlState],
  )

  const setSelectedNodeId = useCallback(
    (nodeId: string | null) => {
      updateUrlState({ [WORKSPACE_DETAIL_PARAM_KEYS.templateNodeId]: nodeId })
    },
    [updateUrlState],
  )

  useEffect(() => {
    loadList().then((ts) => {
      const hasActiveTemplate = !!activeId && ts.some((template) => template.id === activeId)
      if (hasActiveTemplate) return
      setActiveId(ts[0]?.id ?? null, true)
    })
    listTaskTemplates(workspaceId).then(setTaskTemplates)
  }, [activeId, loadList, setActiveId, workspaceId])

  useEffect(() => {
    if (activeId && templates.some((template) => template.id === activeId)) {
      setNodeDirty(false)
      loadDetail(activeId).then(d => {
        if (d) {
          setEditLabel(d.label ?? '')
          setEditArgs(d.arguments.filter(a => !(a as any).deleted).map(a => ({
            name: a.name, arg_type: a.arg_type, default_value: a.default_value ?? '',
            min_value: a.min_value != null ? String(a.min_value) : '',
            max_value: a.max_value != null ? String(a.max_value) : '',
            enum_options: a.enum_options ?? [],
          })))
          setArgsDirty(false)
        }
      })
    } else {
      setDetail(null)
      setEditLabel('')
      setEditArgs([])
      setArgsDirty(false)
    }
  }, [activeId, loadDetail, templates])

  useEffect(() => {
    if (!selectedNodeId || !detail) return
    if (!detail.nodes.some((node) => node.id === selectedNodeId)) {
      setSelectedNodeId(null)
    }
  }, [detail, selectedNodeId, setSelectedNodeId])

  // Seed inspector draft when selection changes
  useEffect(() => {
    if (!selectedNodeId || !detail) return
    const node = detail.nodes.find((n) => n.id === selectedNodeId)
    if (node) {
      setEditNodeName(node.name ?? '')
      setEditNodeType(node.node_type)
      setEditModel(node.agent_config?.model ?? MODEL_OPTIONS[0].value)
      setEditPrompt(node.agent_config?.prompt ?? '')
      setEditGraphTools(node.agent_config?.graph_tools ?? false)
      setEditCommand(node.command_config?.command ?? '')
      setEditTaskTemplateId(node.task_template_id ?? '')
      setEditRefSubgraphId(node.ref_subgraph_template_id ?? '')
      setEditBindings(node.argument_bindings ?? {})
      setNodeDirty(false)
    }
  }, [selectedNodeId, detail])

  // Fetch subgraph detail for argument bindings when a subgraph ref is selected
  useEffect(() => {
    if (editRefSubgraphId && !sgDetailCache[editRefSubgraphId]) {
      getSubgraphTemplate(workspaceId, editRefSubgraphId).then(d => {
        setSgDetailCache(prev => ({ ...prev, [d.id]: d }))
      }).catch(() => {})
    }
  }, [editRefSubgraphId, workspaceId, sgDetailCache])

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

  // Arguments for the currently selected template reference (task or subgraph)
  const refTemplateArgs: TaskTemplateArgument[] = useMemo(() => {
    if (editNodeType === 'task_template' && editTaskTemplateId) {
      return taskTemplates.find(t => t.id === editTaskTemplateId)?.arguments ?? []
    }
    if (editNodeType === 'subgraph_template' && editRefSubgraphId) {
      const cached = sgDetailCache[editRefSubgraphId]
      return cached?.arguments?.filter(a => !(a as any).deleted) ?? []
    }
    return []
  }, [editNodeType, editTaskTemplateId, editRefSubgraphId, taskTemplates, sgDetailCache])

  // Mark node dirty on any edit
  function editNode<T>(setter: (v: T) => void) {
    return (v: T) => { setter(v); setNodeDirty(true) }
  }

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
      await addSubgraphTemplateNode(workspaceId, activeId, { node_type: 'agent' })
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
      const newNode = await addSubgraphTemplateNode(workspaceId, activeId, { node_type: 'agent' })
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
    const patch: Record<string, any> = {
      name: editNodeName || undefined,
      node_type: editNodeType,
    }
    if (editNodeType === 'agent') {
      patch.agent_config = { agent_type: 'opencode', model: editModel, prompt: editPrompt, graph_tools: editGraphTools }
    } else if (editNodeType === 'command') {
      patch.command_config = { command: editCommand }
    } else if (editNodeType === 'task_template') {
      patch.task_template_id = editTaskTemplateId || undefined
      if (Object.keys(editBindings).length > 0) patch.argument_bindings = editBindings
    } else if (editNodeType === 'subgraph_template') {
      patch.ref_subgraph_template_id = editRefSubgraphId || undefined
      if (Object.keys(editBindings).length > 0) patch.argument_bindings = editBindings
    }
    try {
      await patchSubgraphTemplateNode(workspaceId, activeId, selectedNodeId, patch)
      await loadDetail(activeId)
      setNodeDirty(false)
    } catch (err) {
      alert(String(err))
    } finally { setMutating(false) }
  }

  async function handleSaveArgs() {
    if (!activeId || !detail) return
    setMutating(true)
    try {
      await updateSubgraphTemplate(workspaceId, activeId, {
        name: detail.name,
        label: editLabel || undefined,
        nodes: detail.nodes.map((n) => ({
          node_type: n.node_type,
          name: n.name ?? undefined,
          agent_config: n.agent_config ?? undefined,
          command_config: n.command_config ?? undefined,
          task_template_id: n.task_template_id ?? undefined,
          ref_subgraph_template_id: n.ref_subgraph_template_id ?? undefined,
          argument_bindings: n.argument_bindings ?? undefined,
        })),
        edges: detail.nodes.length > 0 ? detail.edges.map(e => ({
          from_index: detail.nodes.findIndex(n => n.id === e.from_node_id),
          to_index: detail.nodes.findIndex(n => n.id === e.to_node_id),
        })).filter(e => e.from_index >= 0 && e.to_index >= 0) : [],
        arguments: editArgs.filter(a => a.name.trim()).map(a => ({
          name: a.name.trim(),
          arg_type: a.arg_type,
          default_value: a.default_value || undefined,
          min_value: a.min_value ? parseFloat(a.min_value) : undefined,
          max_value: a.max_value ? parseFloat(a.max_value) : undefined,
          enum_options: a.enum_options.length > 0 ? a.enum_options : undefined,
        })),
      })
      await loadDetail(activeId)
      setArgsDirty(false)
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

      {/* Label */}
      {detail && (
        <div style={{ padding: '4px 8px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', whiteSpace: 'nowrap' }}>Label</span>
            <input style={s.input} value={editLabel} onChange={(e) => { setEditLabel(e.target.value); setArgsDirty(true) }} placeholder="e.g. Process {{ item }}" />
          </div>
        </div>
      )}

      {/* Arguments section (collapsible) */}
      {detail && (
        <div style={{ borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', padding: '4px 8px', cursor: 'pointer' }}
            onClick={() => setShowArgs(!showArgs)}>
            <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', flex: 1 }}>
              Arguments ({editArgs.length}){argsDirty ? ' *' : ''}
            </span>
            <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{showArgs ? '▼' : '▶'}</span>
          </div>
          {showArgs && (
            <div style={{ padding: '0 8px 6px' }}>
              {editArgs.map((arg, i) => (
                <div key={i} style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 3, alignItems: 'center' }}>
                  <input style={{ ...s.input, flex: 2 }} value={arg.name} placeholder="name"
                    onChange={(e) => { const a = [...editArgs]; a[i] = { ...a[i], name: e.target.value }; setEditArgs(a); setArgsDirty(true) }} />
                  <select style={{ ...s.sel, flex: 1 }} value={arg.arg_type}
                    onChange={(e) => { const a = [...editArgs]; a[i] = { ...a[i], arg_type: e.target.value as any }; setEditArgs(a); setArgsDirty(true) }}>
                    <option value="string">string</option>
                    <option value="model_type">model</option>
                    <option value="boolean">boolean</option>
                    <option value="number">number</option>
                    <option value="enum">enum</option>
                  </select>
                  <input style={{ ...s.input, flex: 2 }} value={arg.default_value} placeholder="default"
                    onChange={(e) => { const a = [...editArgs]; a[i] = { ...a[i], default_value: e.target.value }; setEditArgs(a); setArgsDirty(true) }} />
                  <button style={{ ...s.iconBtn, padding: '2px 6px', fontSize: '11px' }}
                    onClick={() => { const a = [...editArgs]; a.splice(i, 1); setEditArgs(a); setArgsDirty(true) }}>x</button>
                  {arg.arg_type === 'number' && (
                    <div style={{ display: 'flex', gap: 4, width: '100%' }}>
                      <input style={{ ...s.input, flex: 1 }} type="number" value={arg.min_value} placeholder="min"
                        onChange={(e) => { const a = [...editArgs]; a[i] = { ...a[i], min_value: e.target.value }; setEditArgs(a); setArgsDirty(true) }} />
                      <input style={{ ...s.input, flex: 1 }} type="number" value={arg.max_value} placeholder="max"
                        onChange={(e) => { const a = [...editArgs]; a[i] = { ...a[i], max_value: e.target.value }; setEditArgs(a); setArgsDirty(true) }} />
                    </div>
                  )}
                  {arg.arg_type === 'enum' && (
                    <input style={{ ...s.input, width: '100%' }} placeholder="options (comma-separated)"
                      value={arg.enum_options.join(', ')}
                      onChange={(e) => { const a = [...editArgs]; a[i] = { ...a[i], enum_options: e.target.value.split(',').map(s => s.trim()).filter(Boolean) }; setEditArgs(a); setArgsDirty(true) }} />
                  )}
                </div>
              ))}
              <div style={{ display: 'flex', gap: 4, marginTop: 2 }}>
                <button style={{ ...s.addBtn, flex: 1 }}
                  onClick={() => { setEditArgs([...editArgs, { name: '', arg_type: 'string', default_value: '', min_value: '', max_value: '', enum_options: [] }]); setArgsDirty(true) }}>
                  + Add
                </button>
                {argsDirty && (
                  <button style={{ ...s.saveBtn, flex: 1 }}
                    onClick={handleSaveArgs} disabled={mutating}>
                    Save
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

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
                  <path key={edge.id} d={`M${fx},${fy} C${fx},${cy} ${tx},${cy} ${tx},${ty}`}
                    fill="none" stroke="var(--border)" strokeWidth="1.5" markerEnd="url(#stp-arrow)" />
                )
              })}
            </svg>

            {detail.edges.map((edge) => {
              const fp = positions.get(edge.from_node_id)
              const tp = positions.get(edge.to_node_id)
              if (!fp || !tp) return null
              const mx = (fp.x + tp.x) / 2 + NODE_W / 2 - 8
              const my = (fp.y + NODE_H + tp.y) / 2 - 8
              return (
                <button key={`del-${edge.id}`}
                  style={{ ...s.plusBtn, left: mx, top: my, background: 'var(--danger)', zIndex: 4 }}
                  onClick={() => handleDeleteEdge(edge.id)} title="Delete edge">x</button>
              )
            })}

            {detail.nodes.map((node) => {
              const pos = positions.get(node.id)
              if (!pos) return null
              const isSelected = node.id === selectedNodeId
              const isHovered = node.id === hoveredNodeId
              const label = node.name || node.node_type
              return (
                <div key={node.id}>
                  <div style={{
                    position: 'absolute', left: pos.x, top: pos.y, width: NODE_W, height: NODE_H,
                    background: isSelected ? 'var(--surface-2)' : 'var(--surface)',
                    border: `1px solid ${isSelected ? 'var(--accent)' : 'var(--border)'}`,
                    borderRadius: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '11px', cursor: 'pointer', zIndex: 2, overflow: 'hidden', textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap', padding: '0 4px',
                  }}
                    onClick={() => setSelectedNodeId(node.id === selectedNodeId ? null : node.id)}
                    onMouseEnter={() => setHoveredNodeId(node.id)}
                  >{label}</div>
                  {isHovered && (
                    <>
                      <button style={{ ...s.plusBtn, left: pos.x + NODE_W / 2 - 8, top: pos.y + NODE_H + 2 }}
                        onClick={() => handleAddChild(node.id)} title="Add child">+</button>
                      <button style={{ ...s.plusBtn, left: pos.x + NODE_W + 2, top: pos.y + NODE_H / 2 - 8, background: 'var(--danger)' }}
                        onClick={() => handleDeleteNode(node.id)} title="Delete node">x</button>
                    </>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Node Inspector — draft and save */}
      {selectedNode && (
        <div style={s.inspector}>
          <div style={s.inspTitle}>NODE{nodeDirty ? ' *' : ''}</div>
          <div style={s.row}>
            <span style={s.label}>Name</span>
            <input style={s.input} value={editNodeName}
              onChange={e => editNode(setEditNodeName)(e.target.value)}
              placeholder={selectedNode.node_type} />
          </div>
          <div style={s.row}>
            <span style={s.label}>Type</span>
            <select style={s.sel} value={editNodeType}
              onChange={e => editNode(setEditNodeType)(e.target.value as SubgraphTemplateNodeType)}>
              <option value="agent">agent</option>
              <option value="command">command</option>
              <option value="task_template">task_template</option>
              <option value="subgraph_template">subgraph_template</option>
            </select>
          </div>

          {editNodeType === 'agent' && (
            <>
              <div style={s.row}>
                <span style={s.label}>Model</span>
                <select style={s.sel} value={editModel}
                  onChange={e => editNode(setEditModel)(e.target.value)}>
                  {MODEL_OPTIONS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </div>
              <div style={{ ...s.row, alignItems: 'flex-start' }}>
                <span style={{ ...s.label, marginTop: 4 }}>Prompt</span>
                <textarea style={{ ...s.input, minHeight: 60, resize: 'vertical', fontFamily: 'inherit' }}
                  value={editPrompt} onChange={e => editNode(setEditPrompt)(e.target.value)}
                  placeholder="Enter agent prompt..." />
              </div>
              <div style={s.row}>
                <label style={s.label}>
                  <input type="checkbox" checked={editGraphTools}
                    onChange={e => editNode(setEditGraphTools)(e.target.checked)}
                    style={{ marginRight: 4 }} />
                  Graph Editor
                </label>
              </div>
            </>
          )}

          {editNodeType === 'command' && (
            <div style={{ ...s.row, alignItems: 'flex-start' }}>
              <span style={{ ...s.label, marginTop: 4 }}>Cmd</span>
              <textarea style={{ ...s.input, minHeight: 80, resize: 'vertical', fontFamily: 'monospace' }}
                value={editCommand} onChange={e => editNode(setEditCommand)(e.target.value)}
                placeholder="Enter bash command(s)..." />
            </div>
          )}

          {editNodeType === 'task_template' && (
            <>
              <div style={s.row}>
                <span style={s.label}>Task</span>
                <select style={s.sel} value={editTaskTemplateId}
                  onChange={e => editNode(setEditTaskTemplateId)(e.target.value)}>
                  <option value="">-- select --</option>
                  {taskTemplates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
              {refTemplateArgs.length > 0 && (
                <>
                  <div style={{ ...s.inspTitle, marginTop: 6 }}>BINDINGS</div>
                  {refTemplateArgs.map((arg) => (
                    <div key={arg.id} style={s.row}>
                      <span style={s.label} title={arg.name}>{arg.name.slice(0, 6)}</span>
                      <input style={s.input}
                        value={editBindings[arg.name] ?? ''}
                        onChange={e => { setEditBindings(prev => ({ ...prev, [arg.name]: e.target.value })); setNodeDirty(true) }}
                        placeholder={arg.default_value ?? `{{ ${arg.name} }}`} />
                    </div>
                  ))}
                </>
              )}
            </>
          )}

          {editNodeType === 'subgraph_template' && (
            <>
              <div style={s.row}>
                <span style={s.label}>Sub</span>
                <select style={s.sel} value={editRefSubgraphId}
                  onChange={e => editNode(setEditRefSubgraphId)(e.target.value)}>
                  <option value="">-- select --</option>
                  {allSubgraphs.filter((t) => t.id !== activeId).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
              {refTemplateArgs.length > 0 && (
                <>
                  <div style={{ ...s.inspTitle, marginTop: 6 }}>BINDINGS</div>
                  {refTemplateArgs.map((arg) => (
                    <div key={arg.id} style={s.row}>
                      <span style={s.label} title={arg.name}>{arg.name.slice(0, 6)}</span>
                      <input style={s.input}
                        value={editBindings[arg.name] ?? ''}
                        onChange={e => { setEditBindings(prev => ({ ...prev, [arg.name]: e.target.value })); setNodeDirty(true) }}
                        placeholder={arg.default_value ?? `{{ ${arg.name} }}`} />
                    </div>
                  ))}
                </>
              )}
            </>
          )}

          <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
            <button style={{ ...s.saveBtn, flex: 1, opacity: nodeDirty ? 1 : 0.5 }}
              onClick={handleSaveNode} disabled={mutating || !nodeDirty}>
              Save
            </button>
            <button style={{ ...s.deleteBtn, flex: 0 }}
              onClick={() => selectedNodeId && handleDeleteNode(selectedNodeId)} disabled={mutating}>
              Delete
            </button>
          </div>
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
  label: { color: 'var(--text-dim)', flexShrink: 0, width: '40px', fontSize: '12px' },
  input: {
    flex: 1, padding: '3px 7px', border: '1px solid var(--border)', borderRadius: '4px',
    background: 'var(--surface-2)', color: 'var(--text)', outline: 'none', fontSize: '12px',
  },
  sel: {
    flex: 1, padding: '3px 7px', border: '1px solid var(--border)', borderRadius: '4px',
    background: 'var(--surface-2)', color: 'var(--text)', outline: 'none', fontSize: '12px',
  },
  saveBtn: {
    padding: '4px 10px', background: 'var(--accent)', color: '#fff',
    border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px',
  },
  deleteBtn: {
    padding: '4px 10px', background: 'transparent', color: 'var(--danger)',
    border: '1px solid var(--danger)', borderRadius: '4px', cursor: 'pointer', fontSize: '12px',
  },
}
