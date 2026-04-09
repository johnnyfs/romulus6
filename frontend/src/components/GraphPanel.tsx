import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAutoResize } from '../hooks/useAutoResize'
import { useSearchParams } from 'react-router-dom'
import {
  type Graph,
  type GraphDetail,
  type NodeType,
  addEdge,
  addNode,
  createGraph,
  deleteGraph,
  deleteEdge,
  deleteNode,
  getGraph,
  listGraphs,
  patchNode,
} from '../api/graphs'
import type { SchemaTemplate, TaskTemplate, SubgraphTemplate, SubgraphTemplateDetail } from '../api/templates'
import { DEFAULT_MODEL_BY_AGENT_TYPE, SUPPORTED_MODELS_BY_AGENT_TYPE, type AgentType } from '../api/models'
import { buildTypeOptions, listSchemaTemplates, listTaskTemplates, listSubgraphTemplates, getSubgraphTemplate } from '../api/templates'
import { NODE_W, NODE_H, CANVAS_WIDTH, computeLayout, type Pos } from './graphLayout'
import RunsView from './RunsView'
import TemplatesView from './TemplatesView'
import {
  WORKSPACE_DETAIL_PARAM_KEYS,
  mergeSearchParams,
  readEnumParam,
  readStringParam,
} from './workspaceDetailSearchParams'

function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function GraphPanel({ workspaceId, width }: { workspaceId: string; width?: number }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const [graphs, setGraphs] = useState<Graph[]>([])
  const [detail, setDetail] = useState<GraphDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [mutating, setMutating] = useState(false)
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null)
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null)
  const [newDepFrom, setNewDepFrom] = useState<string>('')
  const [newDeptTo, setNewDeptTo] = useState<string>('')
  const [editName, setEditName] = useState('')
  const [editType, setEditType] = useState<NodeType>('agent')
  const [editAgentType, setEditAgentType] = useState<AgentType>('opencode')
  const [editModel, setEditModel] = useState(DEFAULT_MODEL_BY_AGENT_TYPE.opencode)
  const [editPrompt, setEditPrompt] = useState('')
  const [editCommand, setEditCommand] = useState('')
  const promptRef = useAutoResize(editPrompt, 300, 60)
  const commandRef = useAutoResize(editCommand, 300, 80)
  const [editGraphTools, setEditGraphTools] = useState(false)
  const [editTaskTemplateId, setEditTaskTemplateId] = useState('')
  const [editSubgraphTemplateId, setEditSubgraphTemplateId] = useState('')
  const [editBindings, setEditBindings] = useState<Record<string, string>>({})
  const [editOutputSchema, setEditOutputSchema] = useState<Record<string, string>>({})
  const [nodeDirty, setNodeDirty] = useState(false)
  const [taskTemplates, setTaskTemplates] = useState<TaskTemplate[]>([])
  const [subgraphTemplates, setSubgraphTemplates] = useState<SubgraphTemplate[]>([])
  const [schemaTemplates, setSchemaTemplates] = useState<SchemaTemplate[]>([])
  const outputTypeOptions = useMemo(() => buildTypeOptions(schemaTemplates), [schemaTemplates])
  const [sgDetailCache, setSgDetailCache] = useState<Record<string, SubgraphTemplateDetail>>({})
  const sgDetailCacheRef = useRef(sgDetailCache)
  useEffect(() => { sgDetailCacheRef.current = sgDetailCache }, [sgDetailCache])

  const activeTab = readEnumParam(
    searchParams,
    WORKSPACE_DETAIL_PARAM_KEYS.panelTab,
    ['graph', 'runs', 'templates'] as const,
    'graph',
  )
  const activeGraphId = readStringParam(searchParams, WORKSPACE_DETAIL_PARAM_KEYS.graphId)
  const selectedNodeId = readStringParam(searchParams, WORKSPACE_DETAIL_PARAM_KEYS.graphNodeId)

  const setPanelState = useCallback(
    (updates: Record<string, string | null>, replace = false) => {
      setSearchParams((prev) => mergeSearchParams(prev, updates), { replace })
    },
    [setSearchParams],
  )

  const setActiveTab = useCallback(
    (tab: 'graph' | 'runs' | 'templates') => {
      setPanelState({ [WORKSPACE_DETAIL_PARAM_KEYS.panelTab]: tab })
    },
    [setPanelState],
  )

  const setActiveGraphId = useCallback(
    (graphId: string | null) => {
      setPanelState({
        [WORKSPACE_DETAIL_PARAM_KEYS.graphId]: graphId,
        [WORKSPACE_DETAIL_PARAM_KEYS.graphNodeId]: null,
      })
    },
    [setPanelState],
  )

  const setSelectedNodeId = useCallback(
    (nodeId: string | null) => {
      setPanelState({ [WORKSPACE_DETAIL_PARAM_KEYS.graphNodeId]: nodeId })
    },
    [setPanelState],
  )

  function markDirty<T>(setter: (v: T) => void) {
    return (v: T) => { setter(v); setNodeDirty(true) }
  }

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

  // Load graphs and templates on mount / workspace change
  useEffect(() => {
    loadGraphs()
    listTaskTemplates(workspaceId).then(setTaskTemplates)
    listSubgraphTemplates(workspaceId).then(setSubgraphTemplates)
    listSchemaTemplates(workspaceId).then(setSchemaTemplates)
  }, [loadGraphs, workspaceId])

  // Auto-select first graph if current selection is invalid
  useEffect(() => {
    if (graphs.length === 0) return
    const hasActiveGraph = !!activeGraphId && graphs.some((g) => g.id === activeGraphId)
    if (!hasActiveGraph) {
      setPanelState(
        {
          [WORKSPACE_DETAIL_PARAM_KEYS.graphId]: graphs[0]?.id ?? null,
          [WORKSPACE_DETAIL_PARAM_KEYS.graphNodeId]: null,
        },
        true,
      )
    }
  }, [graphs, activeGraphId, setPanelState])

  useEffect(() => {
    if (activeGraphId && graphs.some((graph) => graph.id === activeGraphId)) {
      loadDetail(activeGraphId)
    } else {
      setDetail(null)
    }
  }, [activeGraphId, graphs, loadDetail])

  useEffect(() => {
    if (!selectedNodeId || !detail) return
    if (!detail.nodes.some((node) => node.id === selectedNodeId)) {
      setSelectedNodeId(null)
    }
  }, [detail, selectedNodeId, setSelectedNodeId])

  // Seed inspector when selection changes
  useEffect(() => {
    if (!selectedNodeId || !detail) return
    setNewDepFrom('')
    setNewDeptTo('')
    const node = detail.nodes.find((n) => n.id === selectedNodeId)
    if (node) {
      setEditName(node.name ?? '')
      setEditType(node.node_type)
      if (node.agent_config) {
        setEditAgentType(node.agent_config.agent_type)
        setEditModel(node.agent_config.model)
        setEditPrompt(node.agent_config.prompt)
        setEditGraphTools((node.agent_config.agent_type === 'opencode' || node.agent_config.agent_type === 'codex' || node.agent_config.agent_type === 'claude_code') ? (node.agent_config.graph_tools ?? false) : false)
      } else {
        setEditAgentType('opencode')
        setEditModel(DEFAULT_MODEL_BY_AGENT_TYPE.opencode)
        setEditPrompt('')
        setEditGraphTools(false)
      }
      if (node.command_config) {
        setEditCommand(node.command_config.command)
      } else {
        setEditCommand('')
      }
      setEditTaskTemplateId(node.task_template_id ?? '')
      setEditSubgraphTemplateId(node.subgraph_template_id ?? '')
      setEditBindings(node.argument_bindings ?? {})
      setEditOutputSchema(node.output_schema ?? {})
      setNodeDirty(false)
    }
  }, [selectedNodeId, detail])

  // Fetch subgraph template detail for argument bindings
  useEffect(() => {
    if (editSubgraphTemplateId && !sgDetailCacheRef.current[editSubgraphTemplateId]) {
      getSubgraphTemplate(workspaceId, editSubgraphTemplateId).then(d => {
        setSgDetailCache(prev => ({ ...prev, [d.id]: d }))
      }).catch(() => {})
    }
  }, [editSubgraphTemplateId, workspaceId])

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

  const selectedNodeEdges = useMemo(() => {
    if (!detail || !selectedNodeId) {
      return {
        incoming: [] as GraphDetail['edges'],
        outgoing: [] as GraphDetail['edges'],
      }
    }
    return {
      incoming: detail.edges.filter((e) => e.to_node_id === selectedNodeId),
      outgoing: detail.edges.filter((e) => e.from_node_id === selectedNodeId),
    }
  }, [detail, selectedNodeId])

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
      await addNode(workspaceId, activeGraphId, 'agent', nextNodeName('agent'))
      await loadDetail(activeGraphId)
    } finally {
      setMutating(false)
    }
  }

  async function handleAddParent(nodeId: string) {
    if (!activeGraphId || mutating) return
    setMutating(true)
    try {
      const newNode = await addNode(workspaceId, activeGraphId, 'agent', nextNodeName('agent'))
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
      const newNode = await addNode(workspaceId, activeGraphId, 'agent', nextNodeName('agent'))
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
      const newNode = await addNode(workspaceId, activeGraphId, 'agent', nextNodeName('agent'))
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

  const upstreamRefs = useMemo(() => {
    if (!detail || !selectedNodeId) return []
    const parentIds = detail.edges
      .filter(e => e.to_node_id === selectedNodeId)
      .map(e => e.from_node_id)
    return detail.nodes
      .filter(n => parentIds.includes(n.id) && n.name)
      .map(n => ({ name: n.name!, slug: slugify(n.name!), fields: Object.keys(n.output_schema ?? {}) }))
  }, [detail, selectedNodeId])

  const refTemplateArgs = useMemo(() => {
    if (editType === 'task_template' && editTaskTemplateId) {
      return taskTemplates.find(t => t.id === editTaskTemplateId)?.arguments ?? []
    }
    if (editType === 'subgraph_template' && editSubgraphTemplateId) {
      const cached = sgDetailCache[editSubgraphTemplateId]
      return cached?.arguments?.filter(a => !(a as any).deleted) ?? []
    }
    return []
  }, [editType, editTaskTemplateId, editSubgraphTemplateId, taskTemplates, sgDetailCache])

  const modelOptions = useMemo(
    () => SUPPORTED_MODELS_BY_AGENT_TYPE[editAgentType],
    [editAgentType],
  )

  async function handleSaveNode() {
    if (!selectedNodeId || !activeGraphId) return
    const patch: Record<string, any> = {
      name: editName || undefined,
      node_type: editType,
    }
    if (editType === 'agent') {
      patch.agent_config = editAgentType === 'pydantic'
        ? { agent_type: 'pydantic', model: editModel, prompt: editPrompt }
        : { agent_type: editAgentType, model: editModel, prompt: editPrompt, graph_tools: editGraphTools }
      if (Object.keys(editOutputSchema).length > 0) patch.output_schema = editOutputSchema
    } else if (editType === 'command') {
      patch.command_config = { command: editCommand }
      if (Object.keys(editOutputSchema).length > 0) patch.output_schema = editOutputSchema
    } else if (editType === 'task_template') {
      patch.task_template_id = editTaskTemplateId || undefined
      if (Object.keys(editBindings).length > 0) patch.argument_bindings = editBindings
    } else if (editType === 'subgraph_template') {
      patch.subgraph_template_id = editSubgraphTemplateId || undefined
      if (Object.keys(editBindings).length > 0) patch.argument_bindings = editBindings
    }
    try {
      const updated = await patchNode(workspaceId, activeGraphId, selectedNodeId, patch)
      setDetail((prev) =>
        prev ? { ...prev, nodes: prev.nodes.map((n) => (n.id === updated.id ? updated : n)) } : prev,
      )
      setNodeDirty(false)
    } catch (err) {
      alert(String(err))
    }
  }

  async function handleDeleteNode(nodeId: string) {
    if (!activeGraphId || mutating) return
    setMutating(true)
    try {
      await deleteNode(workspaceId, activeGraphId, nodeId)
      if (selectedNodeId === nodeId) setSelectedNodeId(null)
      await loadDetail(activeGraphId)
    } finally {
      setMutating(false)
    }
  }

  async function handleDeleteEdge(edgeId: string) {
    if (!activeGraphId || mutating) return
    setMutating(true)
    try {
      await deleteEdge(workspaceId, activeGraphId, edgeId)
      await loadDetail(activeGraphId)
    } finally {
      setMutating(false)
    }
  }

  async function handleInsertNodeOnEdge(edgeId: string, fromNodeId: string, toNodeId: string) {
    if (!activeGraphId || mutating) return
    setMutating(true)
    try {
      const newNode = await addNode(workspaceId, activeGraphId, 'agent', nextNodeName('agent'))
      await deleteEdge(workspaceId, activeGraphId, edgeId)
      await addEdge(workspaceId, activeGraphId, fromNodeId, newNode.id)
      await addEdge(workspaceId, activeGraphId, newNode.id, toNodeId)
      await loadDetail(activeGraphId)
    } catch (err) {
      alert(`Failed to insert node: ${String(err)}`)
      await loadDetail(activeGraphId)
    } finally {
      setMutating(false)
    }
  }

  async function handleAddEdgeFromInspector(fromNodeId: string, toNodeId: string) {
    if (!activeGraphId || mutating || fromNodeId === toNodeId) return
    setMutating(true)
    try {
      await addEdge(workspaceId, activeGraphId, fromNodeId, toNodeId)
      await loadDetail(activeGraphId)
    } catch (err) {
      alert(`Cannot add edge: ${String(err)}`)
    } finally {
      setMutating(false)
    }
  }

  // ── Navigation callbacks (from RunsView) ──────────────────────────────────

  const handleNavigateToGraphNode = useCallback((graphId: string, nodeId: string) => {
    setPanelState({
      [WORKSPACE_DETAIL_PARAM_KEYS.panelTab]: 'graph',
      [WORKSPACE_DETAIL_PARAM_KEYS.graphId]: graphId,
      [WORKSPACE_DETAIL_PARAM_KEYS.graphNodeId]: nodeId,
    })
  }, [setPanelState])

  const handleNavigateToTemplateNode = useCallback((templateId: string, nodeId: string) => {
    setPanelState({
      [WORKSPACE_DETAIL_PARAM_KEYS.panelTab]: 'templates',
      [WORKSPACE_DETAIL_PARAM_KEYS.templatesSubTab]: 'subgraphs',
      [WORKSPACE_DETAIL_PARAM_KEYS.subgraphTemplateId]: templateId,
      [WORKSPACE_DETAIL_PARAM_KEYS.templateNodeId]: nodeId,
    })
  }, [setPanelState])

  // ── Render ────────────────────────────────────────────────────────────────

  const selectedNode = detail?.nodes.find((n) => n.id === selectedNodeId) ?? null
  const detailNodes = detail?.nodes ?? []

  return (
    <div style={width !== undefined ? { ...s.panel, width } : s.panel}>
      {/* Tab bar */}
      <div style={s.tabBar}>
        <button
          style={activeTab === 'graph' ? { ...s.tab, ...s.tabActive } : s.tab}
          onClick={() => setActiveTab('graph')}
        >
          Graph
        </button>
        <button
          style={activeTab === 'runs' ? { ...s.tab, ...s.tabActive } : s.tab}
          onClick={() => setActiveTab('runs')}
        >
          Runs
        </button>
        <button
          style={activeTab === 'templates' ? { ...s.tab, ...s.tabActive } : s.tab}
          onClick={() => setActiveTab('templates')}
        >
          Templates
        </button>
      </div>

      {activeTab === 'runs' ? (
        <RunsView
          workspaceId={workspaceId}
          onNavigateToGraphNode={handleNavigateToGraphNode}
          onNavigateToTemplateNode={handleNavigateToTemplateNode}
        />
      ) : activeTab === 'templates' ? (
        <TemplatesView workspaceId={workspaceId} />
      ) : (
      <>
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

            {/* Edge midpoint buttons */}
            {detail.edges.map((edge) => {
              const from = positions.get(edge.from_node_id)
              const to = positions.get(edge.to_node_id)
              if (!from || !to) return null
              const fx = from.x + NODE_W / 2
              const fy = from.y + NODE_H
              const tx = to.x + NODE_W / 2
              const ty = to.y
              const mx = (fx + tx) / 2
              const my = (fy + ty) / 2
              const isEdgeHovered = edge.id === hoveredEdgeId

              return (
                <div
                  key={`edge-btns-${edge.id}`}
                  style={{ position: 'absolute', left: mx - 20, top: my - 8, zIndex: 4 }}
                  onMouseEnter={() => setHoveredEdgeId(edge.id)}
                  onMouseLeave={() => setHoveredEdgeId(null)}
                >
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button
                      style={{
                        ...s.edgeMidBtn,
                        background: isEdgeHovered ? 'var(--accent)' : 'var(--surface)',
                        color: isEdgeHovered ? '#fff' : 'var(--text-muted)',
                        borderColor: isEdgeHovered ? 'var(--accent)' : 'var(--border)',
                      }}
                      onMouseDown={(e) => {
                        e.stopPropagation()
                        handleInsertNodeOnEdge(edge.id, edge.from_node_id, edge.to_node_id)
                      }}
                      title="Insert node on this edge"
                    >
                      +
                    </button>
                    <button
                      style={{
                        ...s.edgeMidBtn,
                        background: isEdgeHovered ? 'var(--danger)' : 'var(--surface)',
                        color: isEdgeHovered ? '#fff' : 'var(--text-muted)',
                        borderColor: isEdgeHovered ? 'var(--danger)' : 'var(--border)',
                      }}
                      onMouseDown={(e) => {
                        e.stopPropagation()
                        handleDeleteEdge(edge.id)
                      }}
                      title="Delete edge"
                    >
                      ×
                    </button>
                  </div>
                </div>
              )
            })}

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
                      ? SUPPORTED_MODELS_BY_AGENT_TYPE[node.agent_config.agent_type as AgentType]?.find(m => m.value === node.agent_config!.model)?.label ?? 'agent'
                      : node.node_type)}
                  </div>

                  {/* Delete node button (inside node, right side) */}
                  {isHovered && (
                    <button
                      style={{
                        ...s.nodeDeleteBtn,
                        left: pos.x + NODE_W - 20,
                        top: pos.y + (NODE_H - 16) / 2,
                      }}
                      onMouseDown={(e) => { e.stopPropagation(); handleDeleteNode(node.id) }}
                      title="Delete node"
                    >
                      ×
                    </button>
                  )}

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

      {/* Inspector — draft and save */}
      {selectedNode && (
        <div style={s.inspector}>
          <div style={s.inspectorTitle}>NODE{nodeDirty ? ' *' : ''}</div>
          <div style={s.inspectorRow}>
            <label style={s.inspectorLabel}>Name:</label>
            <input style={s.inspectorInput} value={editName}
              onChange={(e) => markDirty(setEditName)(e.target.value)}
              placeholder={selectedNode.node_type} />
          </div>
          {editName && (
            <div style={{ ...s.inspectorRow, opacity: 0.5, fontSize: '11px' }}>
              <label style={s.inspectorLabel}>Slug:</label>
              <span style={{ fontFamily: 'monospace' }}>{slugify(editName)}</span>
            </div>
          )}
          <div style={s.inspectorRow}>
            <label style={s.inspectorLabel}>Type:</label>
            <select style={s.inspectorSelect} value={editType}
              onChange={(e) => markDirty(setEditType)(e.target.value as NodeType)}>
              <option value="agent">agent</option>
              <option value="command">command</option>
              <option value="task_template">task_template</option>
              <option value="subgraph_template">subgraph_template</option>
            </select>
          </div>
          {editType === 'agent' && (
            <>
              <div style={s.inspectorRow}>
                <label style={s.inspectorLabel} htmlFor="graph-node-agent-type">Agent:</label>
                <select
                  id="graph-node-agent-type"
                  style={s.inspectorSelect}
                  value={editAgentType}
                  onChange={(e) => {
                    const nextType = e.target.value as AgentType
                    markDirty(setEditAgentType)(nextType)
                    setEditModel(DEFAULT_MODEL_BY_AGENT_TYPE[nextType])
                    if (nextType !== 'opencode' && nextType !== 'codex' && nextType !== 'claude_code') {
                      setEditGraphTools(false)
                    }
                  }}
                >
                  <option value="opencode">opencode</option>
                  <option value="pydantic">pydantic</option>
                  <option value="codex">codex</option>
                  <option value="claude_code">claude_code</option>
                </select>
              </div>
              <div style={s.inspectorRow}>
                <label style={s.inspectorLabel} htmlFor="graph-node-model">Model:</label>
                <select style={s.inspectorSelect} value={editModel}
                  id="graph-node-model"
                  onChange={(e) => markDirty(setEditModel)(e.target.value)}>
                  {modelOptions.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </div>
              <div style={{ ...s.inspectorRow, alignItems: 'flex-start' }}>
                <label style={{ ...s.inspectorLabel, marginTop: 4 }} htmlFor="graph-node-prompt">Prompt:</label>
                <textarea ref={promptRef} style={{ ...s.inspectorInput, minHeight: 60, resize: 'none', fontFamily: 'inherit' }}
                  id="graph-node-prompt"
                  value={editPrompt} onChange={(e) => markDirty(setEditPrompt)(e.target.value)}
                  placeholder="Enter agent prompt..." />
              </div>
              {(editAgentType === 'opencode' || editAgentType === 'codex' || editAgentType === 'claude_code') && (
                <div style={s.inspectorRow}>
                  <label style={s.inspectorLabel}>
                    <input type="checkbox" checked={editGraphTools}
                      onChange={(e) => markDirty(setEditGraphTools)(e.target.checked)}
                      style={{ marginRight: 6 }} />
                    Graph Editor
                  </label>
                </div>
              )}
            </>
          )}
          {editType === 'command' && (
            <div style={{ ...s.inspectorRow, alignItems: 'flex-start' }}>
              <label style={{ ...s.inspectorLabel, marginTop: 4 }}>Command:</label>
              <textarea ref={commandRef} style={{ ...s.inspectorInput, minHeight: 80, resize: 'none', fontFamily: 'monospace' }}
                value={editCommand} onChange={(e) => markDirty(setEditCommand)(e.target.value)}
                placeholder="Enter bash command(s)..." />
            </div>
          )}
          {editType === 'task_template' && (
            <>
              <div style={s.inspectorRow}>
                <label style={s.inspectorLabel}>Task:</label>
                <select style={s.inspectorSelect} value={editTaskTemplateId}
                  onChange={(e) => markDirty(setEditTaskTemplateId)(e.target.value)}>
                  <option value="">-- select --</option>
                  {taskTemplates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
              {refTemplateArgs.length > 0 && (
                <>
                  <div style={{ ...s.inspectorTitle, marginTop: 6 }}>BINDINGS</div>
                  {refTemplateArgs.map((arg) => (
                    <div key={arg.id} style={s.bindingRow}>
                      <label style={s.bindingLabel}>{arg.name}</label>
                      <input style={s.inspectorInput}
                        value={editBindings[arg.name] ?? ''}
                        onChange={(e) => { setEditBindings(prev => ({ ...prev, [arg.name]: e.target.value })); setNodeDirty(true) }}
                        placeholder={arg.default_value ?? `{{ ${arg.name} }}`} />
                    </div>
                  ))}
                </>
              )}
            </>
          )}
          {editType === 'subgraph_template' && (
            <>
              <div style={s.inspectorRow}>
                <label style={s.inspectorLabel}>Sub:</label>
                <select style={s.inspectorSelect} value={editSubgraphTemplateId}
                  onChange={(e) => markDirty(setEditSubgraphTemplateId)(e.target.value)}>
                  <option value="">-- select --</option>
                  {subgraphTemplates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
              {refTemplateArgs.length > 0 && (
                <>
                  <div style={{ ...s.inspectorTitle, marginTop: 6 }}>BINDINGS</div>
                  {refTemplateArgs.map((arg) => (
                    <div key={arg.id} style={s.bindingRow}>
                      <label style={s.bindingLabel}>{arg.name}</label>
                      <input style={s.inspectorInput}
                        value={editBindings[arg.name] ?? ''}
                        onChange={(e) => { setEditBindings(prev => ({ ...prev, [arg.name]: e.target.value })); setNodeDirty(true) }}
                        placeholder={arg.default_value ?? `{{ ${arg.name} }}`} />
                    </div>
                  ))}
                </>
              )}
            </>
          )}
          {/* Output Schema (agent + command) */}
          {(editType === 'agent' || editType === 'command') && (
            <>
              <div style={{ ...s.inspectorTitle, marginTop: 8 }}>OUTPUT SCHEMA</div>
              {Object.entries(editOutputSchema).map(([field, type]) => (
                <div key={field} style={{ ...s.inspectorRow, gap: 4 }}>
                  <input style={{ ...s.inspectorInput, flex: 2 }} value={field} readOnly
                    title={field} />
                  <select style={{ ...s.inspectorSelect, flex: 1 }} value={type}
                    onChange={(e) => {
                      setEditOutputSchema(prev => ({ ...prev, [field]: e.target.value }))
                      setNodeDirty(true)
                    }}>
                    {outputTypeOptions.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                  </select>
                  <button style={s.edgeDeleteBtn}
                    onClick={() => {
                      setEditOutputSchema(prev => {
                        const next = { ...prev }
                        delete next[field]
                        return next
                      })
                      setNodeDirty(true)
                    }}>x</button>
                </div>
              ))}
              <button style={{ ...s.addFirstBtn, fontSize: '11px', marginTop: 2 }}
                onClick={() => {
                  const name = window.prompt('Field name:')
                  if (!name?.trim()) return
                  setEditOutputSchema(prev => ({ ...prev, [name.trim()]: 'string' }))
                  setNodeDirty(true)
                }}>
                [ + Add Field ]
              </button>
            </>
          )}
          {/* Upstream output references */}
          {(editType === 'agent' || editType === 'command') && upstreamRefs.length > 0 && (
            <div style={{ marginTop: 6, fontSize: '11px', color: 'var(--text-muted)', padding: '0 4px' }}>
              <div style={{ fontWeight: 600, marginBottom: 2 }}>Available refs:</div>
              {upstreamRefs.map(ref => (
                ref.fields.length > 0
                  ? ref.fields.map(field => (
                    <div key={`${ref.slug}.${field}`} style={{ fontFamily: 'monospace', marginBottom: 1 }}>
                      {'{{ '}{ref.slug}.{field}{' }}'}
                    </div>
                  ))
                  : (
                    <div key={ref.slug} style={{ fontFamily: 'monospace', marginBottom: 1, opacity: 0.65 }}>
                      {ref.slug} has no declared output schema yet
                    </div>
                  )
              ))}
            </div>
          )}
          <div style={{ display: 'flex', gap: 4, marginTop: 6, marginBottom: 4 }}>
            <button style={{ ...s.saveNodeBtn, opacity: nodeDirty ? 1 : 0.5 }}
              onClick={handleSaveNode} disabled={!nodeDirty || mutating}>
              Save
            </button>
          </div>
          {/* Dependencies (incoming edges — nodes that must run before this one) */}
          <div style={{ ...s.inspectorTitle, marginTop: 8 }}>DEPENDENCIES</div>
          {selectedNodeEdges.incoming.map((edge) => (
            <div key={edge.id} style={s.inspectorRow}>
              <select
                style={{ ...s.inspectorSelect, flex: 1 }}
                value={edge.from_node_id}
                disabled
              >
                {detailNodes.map((n) => (
                  <option key={n.id} value={n.id}>{n.name || n.node_type}</option>
                ))}
              </select>
              <button
                style={s.edgeDeleteBtn}
                onMouseDown={() => handleDeleteEdge(edge.id)}
                disabled={mutating}
                title="Remove dependency"
              >
                ×
              </button>
            </div>
          ))}
          <div style={s.inspectorRow}>
            <select
              style={{ ...s.inspectorSelect, flex: 1 }}
              value={newDepFrom}
              onChange={(e) => setNewDepFrom(e.target.value)}
            >
              <option value="">add dependency...</option>
              {detailNodes.filter((n) => n.id !== selectedNodeId).map((n) => (
                <option key={n.id} value={n.id}>{n.name || n.node_type}</option>
              ))}
            </select>
            <button
              style={{
                ...s.edgeMidBtn,
                background: newDepFrom ? 'var(--accent)' : 'var(--surface-2)',
                color: newDepFrom ? '#fff' : 'var(--text-muted)',
                borderColor: newDepFrom ? 'var(--accent)' : 'var(--border)',
              }}
              onMouseDown={() => {
                if (newDepFrom && selectedNodeId) handleAddEdgeFromInspector(newDepFrom, selectedNodeId)
              }}
              disabled={!newDepFrom || mutating}
              title="Add dependency"
            >
              +
            </button>
          </div>

          {/* Dependents (outgoing edges — nodes that run after this one) */}
          <div style={{ ...s.inspectorTitle, marginTop: 8 }}>DEPENDENTS</div>
          {selectedNodeEdges.outgoing.map((edge) => (
            <div key={edge.id} style={s.inspectorRow}>
              <select
                style={{ ...s.inspectorSelect, flex: 1 }}
                value={edge.to_node_id}
                disabled
              >
                {detailNodes.map((n) => (
                  <option key={n.id} value={n.id}>{n.name || n.node_type}</option>
                ))}
              </select>
              <button
                style={s.edgeDeleteBtn}
                onMouseDown={() => handleDeleteEdge(edge.id)}
                disabled={mutating}
                title="Remove dependent"
              >
                ×
              </button>
            </div>
          ))}
          <div style={s.inspectorRow}>
            <select
              style={{ ...s.inspectorSelect, flex: 1 }}
              value={newDeptTo}
              onChange={(e) => setNewDeptTo(e.target.value)}
            >
              <option value="">add dependent...</option>
              {detailNodes.filter((n) => n.id !== selectedNodeId).map((n) => (
                <option key={n.id} value={n.id}>{n.name || n.node_type}</option>
              ))}
            </select>
            <button
              style={{
                ...s.edgeMidBtn,
                background: newDeptTo ? 'var(--accent)' : 'var(--surface-2)',
                color: newDeptTo ? '#fff' : 'var(--text-muted)',
                borderColor: newDeptTo ? 'var(--accent)' : 'var(--border)',
              }}
              onMouseDown={() => {
                if (newDeptTo && selectedNodeId) handleAddEdgeFromInspector(selectedNodeId, newDeptTo)
              }}
              disabled={!newDeptTo || mutating}
              title="Add dependent"
            >
              +
            </button>
          </div>

          <button style={s.deleteNodeBtn} onClick={() => selectedNodeId && handleDeleteNode(selectedNodeId)} disabled={mutating}>
            [ Delete Node ]
          </button>
        </div>
      )}
      </>
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
  tabBar: {
    display: 'flex',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0,
  },
  tab: {
    flex: 1,
    padding: '8px 12px 6px',
    textAlign: 'center' as const,
    fontSize: '11px',
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.08em',
    cursor: 'pointer',
    color: 'var(--text-muted)',
    background: 'transparent',
    border: 'none',
    borderBottom: '2px solid transparent',
  },
  tabActive: {
    color: 'var(--accent)',
    borderBottom: '2px solid var(--accent)',
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
  bindingRow: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '2px',
    marginBottom: '6px',
  },
  bindingLabel: {
    color: 'var(--text-dim)',
    fontSize: '11px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
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
  saveNodeBtn: {
    flex: 1,
    padding: '4px 10px',
    background: 'var(--accent)',
    color: '#fff',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
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
  nodeDeleteBtn: {
    position: 'absolute',
    width: 16,
    height: 16,
    background: 'var(--danger)',
    color: '#ffffff',
    border: 'none',
    borderRadius: '3px',
    cursor: 'pointer',
    fontSize: '11px',
    lineHeight: '14px',
    padding: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  edgeMidBtn: {
    width: 16,
    height: 16,
    border: '1px solid var(--border)',
    borderRadius: '3px',
    cursor: 'pointer',
    fontSize: '11px',
    lineHeight: '14px',
    padding: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  edgeDeleteBtn: {
    width: 16,
    height: 16,
    background: 'transparent',
    color: 'var(--danger)',
    border: '1px solid var(--danger)',
    borderRadius: '3px',
    cursor: 'pointer',
    fontSize: '11px',
    lineHeight: '14px',
    padding: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
}
