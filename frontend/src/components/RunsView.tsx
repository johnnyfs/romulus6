import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  type Graph,
  type GraphRun,
  type GraphRunNode,
  type RunNodeState,
  listGraphs,
  listRuns,
  createRun,
  getRun,
  getRunById,
  syncRunNode,
  patchRunNode,
} from '../api/graphs'
import { NODE_W, NODE_H, PADDING_TOP, CANVAS_WIDTH, computeLayout } from './graphLayout'
import {
  WORKSPACE_DETAIL_PARAM_KEYS,
  mergeSearchParams,
  readStringParam,
} from './workspaceDetailSearchParams'

const STATE_COLORS: Record<RunNodeState, string> = {
  pending: 'var(--text-muted)',
  running: '#3b82f6',
  completed: '#22c55e',
  error: '#ef4444',
}

interface RunsViewProps {
  workspaceId: string
  onNavigateToGraphNode?: (graphId: string, nodeId: string) => void
  onNavigateToTemplateNode?: (templateId: string, nodeId: string) => void
}

export default function RunsView({ workspaceId, onNavigateToGraphNode, onNavigateToTemplateNode }: RunsViewProps) {
  const [searchParams, setSearchParams] = useSearchParams()
  const [graphs, setGraphs] = useState<Graph[]>([])
  const [runs, setRuns] = useState<GraphRun[]>([])
  const [runPath, setRunPath] = useState<GraphRun[]>([])
  const activeRun = runPath.length > 0 ? runPath[runPath.length - 1] : null
  const [creating, setCreating] = useState(false)
  const selectedGraphId = readStringParam(searchParams, WORKSPACE_DETAIL_PARAM_KEYS.runGraphId)
  const selectedGraphIdRef = useRef(selectedGraphId)
  useEffect(() => { selectedGraphIdRef.current = selectedGraphId }, [selectedGraphId])
  const selectedRunId = readStringParam(searchParams, WORKSPACE_DETAIL_PARAM_KEYS.runId)
  const selectedRunNodeId = readStringParam(searchParams, WORKSPACE_DETAIL_PARAM_KEYS.runNodeId)

  const updateUrlState = useCallback(
    (updates: Record<string, string | null>, replace = false) => {
      setSearchParams((prev) => mergeSearchParams(prev, updates), { replace })
    },
    [setSearchParams],
  )

  const setSelectedGraphId = useCallback(
    (graphId: string | null, replace = false) => {
      updateUrlState(
        {
          [WORKSPACE_DETAIL_PARAM_KEYS.runGraphId]: graphId,
          [WORKSPACE_DETAIL_PARAM_KEYS.runId]: null,
          [WORKSPACE_DETAIL_PARAM_KEYS.runNodeId]: null,
        },
        replace,
      )
    },
    [updateUrlState],
  )

  const setSelectedRunId = useCallback(
    (runId: string | null, replace = false) => {
      updateUrlState(
        {
          [WORKSPACE_DETAIL_PARAM_KEYS.runId]: runId,
          [WORKSPACE_DETAIL_PARAM_KEYS.runNodeId]: null,
        },
        replace,
      )
    },
    [updateUrlState],
  )

  const setSelectedRunNodeId = useCallback(
    (runNodeId: string | null) => {
      updateUrlState({ [WORKSPACE_DETAIL_PARAM_KEYS.runNodeId]: runNodeId })
    },
    [updateUrlState],
  )

  // Load graphs
  const loadGraphs = useCallback(async () => {
    const gs = await listGraphs(workspaceId)
    setGraphs(gs)
    const currentSelected = selectedGraphIdRef.current
    const hasSelectedGraph = !!currentSelected && gs.some((graph) => graph.id === currentSelected)
    if (!hasSelectedGraph) {
      setSelectedGraphId(gs[0]?.id ?? null, true)
    }
  }, [workspaceId, setSelectedGraphId])

  useEffect(() => { loadGraphs() }, [loadGraphs])

  // Load runs when graph changes
  const loadRuns = useCallback(async () => {
    if (!selectedGraphId || !graphs.some((graph) => graph.id === selectedGraphId)) {
      setRuns([])
      return
    }
    const rs = await listRuns(workspaceId, selectedGraphId)
    setRuns(rs)
  }, [graphs, workspaceId, selectedGraphId])

  useEffect(() => { loadRuns() }, [loadRuns])

  useEffect(() => {
    if (!selectedRunId) return
    if (!runs.some((run) => run.id === selectedRunId)) {
      setSelectedRunId(null, true)
    }
  }, [runs, selectedRunId, setSelectedRunId])

  // Load run detail when selection changes
  useEffect(() => {
    if (!selectedRunId || !selectedGraphId) {
      setRunPath([])
      return
    }
    const run = runs.find(r => r.id === selectedRunId)
    if (run) {
      setRunPath([run])
    }
  }, [selectedRunId, runs, selectedGraphId])

  useEffect(() => {
    if (!selectedRunNodeId || !activeRun) return
    if (!activeRun.run_nodes.some((node) => node.id === selectedRunNodeId)) {
      setSelectedRunNodeId(null)
    }
  }, [activeRun, selectedRunNodeId, setSelectedRunNodeId])

  // Poll active run if non-terminal
  useEffect(() => {
    if (!activeRun) return
    if (activeRun.state === 'completed' || activeRun.state === 'error') return

    const interval = setInterval(async () => {
      try {
        const updated =
          activeRun.graph_id && selectedGraphId && activeRun.graph_id === selectedGraphId
            ? await getRun(workspaceId, selectedGraphId, activeRun.id)
            : await getRunById(workspaceId, activeRun.id)
        setRunPath(prev => {
          if (prev.length === 0) return [updated]
          return prev.map((run, index) => (index === prev.length - 1 ? updated : run))
        })
        setRuns(prev => prev.map(r => r.id === updated.id ? updated : r))
      } catch { /* ignore poll errors */ }
    }, 2000)

    return () => clearInterval(interval)
  }, [activeRun?.id, activeRun?.state, activeRun?.graph_id, workspaceId, selectedGraphId])

  // Layout for active run
  const positions = useMemo(() => {
    if (!activeRun) return new Map()
    return computeLayout({
      nodes: activeRun.run_nodes.map(rn => ({ id: rn.id })),
      edges: activeRun.run_edges.map(re => ({
        from_node_id: re.from_run_node_id,
        to_node_id: re.to_run_node_id,
      })),
    })
  }, [activeRun])

  const maxLayer = useMemo(() => {
    let max = 0
    positions.forEach(p => { max = Math.max(max, p.y) })
    return max
  }, [positions])

  const canvasHeight = maxLayer + NODE_H + PADDING_TOP + 24

  // Create run
  const handleCreateRun = useCallback(async () => {
    if (!selectedGraphId) return
    setCreating(true)
    try {
      const run = await createRun(workspaceId, selectedGraphId)
      await loadRuns()
      setSelectedRunId(run.id)
      setRunPath([run])
    } finally {
      setCreating(false)
    }
  }, [workspaceId, selectedGraphId, loadRuns])

  const handleOpenChildRun = useCallback(async (childRunId: string) => {
    const childRun = await getRunById(workspaceId, childRunId)
    setRunPath(prev => [...prev, childRun])
  }, [workspaceId])

  const handleSelectRunAtDepth = useCallback((index: number) => {
    setRunPath(prev => prev.slice(0, index + 1))
  }, [])

  const runStateColor = (state: string) => {
    if (state === 'running') return '#3b82f6'
    if (state === 'completed') return '#22c55e'
    if (state === 'error') return '#ef4444'
    return 'var(--text-muted)'
  }

  // Selected node + edges
  const selectedRunNode: GraphRunNode | null = activeRun?.run_nodes.find(rn => rn.id === selectedRunNodeId) ?? null

  const selectedRunNodeEdges = useMemo(() => {
    if (!activeRun || !selectedRunNodeId) return { incoming: [], outgoing: [] }
    return {
      incoming: activeRun.run_edges.filter(e => e.to_run_node_id === selectedRunNodeId),
      outgoing: activeRun.run_edges.filter(e => e.from_run_node_id === selectedRunNodeId),
    }
  }, [activeRun, selectedRunNodeId])

  const nodeNameById = useCallback((nodeId: string) => {
    const node = activeRun?.run_nodes.find(rn => rn.id === nodeId)
    return node?.name || node?.node_type || '?'
  }, [activeRun])

  // "Go to source" handler
  const handleGoToSource = useCallback(() => {
    if (!selectedRunNode?.source_node_id) return
    if (selectedRunNode.source_type === 'graph_node') {
      const rootRun = runPath[0]
      if (rootRun?.graph_id && onNavigateToGraphNode) {
        onNavigateToGraphNode(rootRun.graph_id, selectedRunNode.source_node_id)
      }
    } else if (selectedRunNode.source_type === 'template_node') {
      if (activeRun?.source_template_id && onNavigateToTemplateNode) {
        onNavigateToTemplateNode(activeRun.source_template_id, selectedRunNode.source_node_id)
      }
    }
  }, [selectedRunNode, runPath, activeRun, onNavigateToGraphNode, onNavigateToTemplateNode])

  const applyRunUpdate = useCallback((updated: GraphRun) => {
    setRunPath(prev => {
      if (prev.length === 0) return [updated]
      return prev.map((run, index) => (index === prev.length - 1 ? updated : run))
    })
    setRuns(prev => prev.map(r => r.id === updated.id ? updated : r))
  }, [])

  const handleSyncNode = useCallback(async () => {
    if (!activeRun || !selectedRunNode) return
    const updated = await syncRunNode(workspaceId, activeRun.id, selectedRunNode.id)
    applyRunUpdate(updated)
  }, [workspaceId, activeRun, selectedRunNode, applyRunUpdate])

  const handlePatchNodeState = useCallback(async (newState: RunNodeState) => {
    if (!activeRun || !selectedRunNode) return
    const updated = await patchRunNode(workspaceId, activeRun.id, selectedRunNode.id, { state: newState })
    applyRunUpdate(updated)
  }, [workspaceId, activeRun, selectedRunNode, applyRunUpdate])

  const canMutateNode = selectedRunNode != null
    && selectedRunNode.state !== 'running'
    && !selectedRunNode.child_run_id

  const canSyncNode = canMutateNode
    && selectedRunNode.source_type === 'graph_node'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {/* Graph selector */}
      <div style={rs.headerBar}>
        <select
          style={rs.select}
          value={selectedGraphId ?? ''}
          onChange={(e) => {
            setSelectedGraphId(e.target.value || null)
            setRunPath([])
          }}
        >
          {graphs.length === 0 && <option value="">-- no graphs --</option>}
          {graphs.map((g) => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
        </select>
        <button
          style={rs.runBtn}
          onClick={handleCreateRun}
          disabled={!selectedGraphId || creating}
          title="Run graph"
        >
          {creating ? '...' : 'Run'}
        </button>
      </div>

      {/* Run selector */}
      <div style={rs.headerBar}>
        <select
          style={rs.select}
          value={selectedRunId ?? ''}
          onChange={(e) => setSelectedRunId(e.target.value || null)}
        >
          {runs.length === 0 && <option value="">-- no runs --</option>}
          {runs.map((r) => (
            <option key={r.id} value={r.id}>
              {new Date(r.created_at).toLocaleString()} — {r.state}
            </option>
          ))}
        </select>
        {activeRun && (
          <span style={{ ...rs.stateDot, background: runStateColor(activeRun.state) }} title={activeRun.state} />
        )}
      </div>

      {runPath.length > 1 && (
        <div style={rs.breadcrumbBar}>
          {runPath.map((run, index) => (
            <button
              key={run.id}
              style={index === runPath.length - 1 ? rs.crumbActive : rs.crumb}
              onClick={() => void handleSelectRunAtDepth(index)}
              title={run.id}
            >
              {index === 0 ? 'root' : (run.run_nodes.find((node) => node.child_run_id === runPath[index + 1]?.id)?.name ?? `subgraph ${index}`)}
            </button>
          ))}
        </div>
      )}

      {/* Visualization */}
      <div style={rs.canvasWrap}>
        {!activeRun && (
          <div style={rs.placeholder}>
            {runs.length === 0 ? 'No runs yet.\nSelect a graph and press Run.' : 'Select a run to view.'}
          </div>
        )}

        {activeRun && activeRun.run_nodes.length > 0 && (
          <div style={{ position: 'relative', height: canvasHeight, minWidth: CANVAS_WIDTH }}>
            {/* SVG edges */}
            <svg
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: canvasHeight, pointerEvents: 'none' }}
            >
              <defs>
                <marker
                  id="rv-arrow"
                  markerWidth="8"
                  markerHeight="8"
                  refX="4"
                  refY="4"
                  orient="auto"
                >
                  <path d="M0,0 L0,8 L8,4 Z" fill="var(--border)" />
                </marker>
              </defs>
              {activeRun.run_edges.map((edge) => {
                const from = positions.get(edge.from_run_node_id)
                const to = positions.get(edge.to_run_node_id)
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
                    markerEnd="url(#rv-arrow)"
                  />
                )
              })}
            </svg>

            {/* Nodes */}
            {activeRun.run_nodes.map((rn) => {
              const pos = positions.get(rn.id)
              if (!pos) return null
              const color = STATE_COLORS[rn.state]
              const isSelected = rn.id === selectedRunNodeId
              return (
                <div
                  key={rn.id}
                  onClick={() => setSelectedRunNodeId(selectedRunNodeId === rn.id ? null : rn.id)}
                  style={{
                    position: 'absolute',
                    left: pos.x,
                    top: pos.y,
                    width: NODE_W,
                    height: NODE_H,
                    background: isSelected ? 'var(--surface-2)' : 'var(--surface)',
                    border: `2px solid ${isSelected ? 'var(--accent)' : color}`,
                    borderRadius: '4px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '12px',
                    boxSizing: 'border-box',
                    overflow: 'hidden',
                    whiteSpace: 'nowrap',
                    textOverflow: 'ellipsis',
                    paddingInline: 8,
                    color: isSelected ? 'var(--accent)' : color,
                    gap: 6,
                    cursor: 'pointer',
                  }}
                  title={`${rn.name ?? rn.node_type} — ${rn.state}`}
                >
                  <span style={rs.nodeLabel}>{rn.name || rn.node_type}</span>
                  {rn.child_run_id && (
                    <button
                      style={rs.childRunBtn}
                      title="Open child run"
                      onClick={(e) => {
                        e.stopPropagation()
                        void handleOpenChildRun(rn.child_run_id!)
                      }}
                    >
                      ↗
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Read-only inspector */}
      {selectedRunNode && (
        <div style={rs.inspector}>
          <div style={rs.inspectorTitle}>RUN NODE</div>
          <div style={rs.inspectorRow}>
            <span style={rs.inspectorLabel}>Name:</span>
            <span style={rs.inspectorValue}>{selectedRunNode.name || selectedRunNode.node_type}</span>
          </div>
          <div style={rs.inspectorRow}>
            <span style={rs.inspectorLabel}>Type:</span>
            <span style={rs.inspectorValue}>{selectedRunNode.node_type}</span>
          </div>
          <div style={rs.inspectorRow}>
            <span style={rs.inspectorLabel}>State:</span>
            {canMutateNode ? (
              <select
                style={{ ...rs.inspectorSelect, color: STATE_COLORS[selectedRunNode.state] }}
                value={selectedRunNode.state}
                onChange={(e) => void handlePatchNodeState(e.target.value as RunNodeState)}
              >
                <option value="pending">pending</option>
                <option value="completed">completed</option>
                <option value="error">error</option>
              </select>
            ) : (
              <span style={{ ...rs.inspectorValue, color: STATE_COLORS[selectedRunNode.state] }}>
                {selectedRunNode.state}
              </span>
            )}
          </div>

          {selectedRunNode.agent_config && (
            <>
              <div style={{ ...rs.inspectorTitle, marginTop: 6 }}>AGENT CONFIG</div>
              <div style={rs.inspectorRow}>
                <span style={rs.inspectorLabel}>Agent:</span>
                <span style={rs.inspectorValue}>{selectedRunNode.agent_config.agent_type}</span>
              </div>
              <div style={rs.inspectorRow}>
                <span style={rs.inspectorLabel}>Model:</span>
                <span style={rs.inspectorValue}>{selectedRunNode.agent_config.model}</span>
              </div>
              {selectedRunNode.agent_config.prompt && (
                <div style={{ ...rs.inspectorRow, alignItems: 'flex-start' }}>
                  <span style={{ ...rs.inspectorLabel, marginTop: 2 }}>Prompt:</span>
                  <span style={{ ...rs.inspectorValue, whiteSpace: 'pre-wrap', maxHeight: 80, overflowY: 'auto' }}>
                    {selectedRunNode.agent_config.prompt}
                  </span>
                </div>
              )}
              {(selectedRunNode.agent_config.agent_type === 'opencode' || selectedRunNode.agent_config.agent_type === 'claude_code') && selectedRunNode.agent_config.graph_tools && (
                <div style={rs.inspectorRow}>
                  <span style={rs.inspectorLabel} />
                  <span style={{ ...rs.inspectorValue, color: 'var(--text-dim)' }}>graph tools enabled</span>
                </div>
              )}
            </>
          )}

          {selectedRunNode.command_config && (
            <>
              <div style={{ ...rs.inspectorTitle, marginTop: 6 }}>COMMAND</div>
              <div style={{ ...rs.inspectorRow, alignItems: 'flex-start' }}>
                <span style={{ ...rs.inspectorValue, fontFamily: 'monospace', whiteSpace: 'pre-wrap', maxHeight: 80, overflowY: 'auto' }}>
                  {selectedRunNode.command_config.command}
                </span>
              </div>
            </>
          )}

          {selectedRunNode.output_schema && (
            <>
              <div style={{ ...rs.inspectorTitle, marginTop: 6 }}>OUTPUT SCHEMA</div>
              <div style={{ ...rs.inspectorRow, alignItems: 'flex-start' }}>
                <span style={{ ...rs.inspectorValue, fontFamily: 'monospace', whiteSpace: 'pre-wrap', maxHeight: 100, overflowY: 'auto' }}>
                  {JSON.stringify(selectedRunNode.output_schema, null, 2)}
                </span>
              </div>
            </>
          )}

          {selectedRunNode.output && (
            <>
              <div style={{ ...rs.inspectorTitle, marginTop: 6 }}>OUTPUT</div>
              {Object.entries(selectedRunNode.output).map(([key, value]) => {
                const isImage = selectedRunNode.output_schema?.[key] === 'image' && typeof value === 'string'
                return (
                  <div key={key} style={{ ...rs.inspectorRow, alignItems: 'flex-start', marginBottom: 4 }}>
                    <span style={{ ...rs.inspectorLabel, marginTop: 2 }}>{key}:</span>
                    {isImage ? (
                      <img
                        src={value as string}
                        alt={key}
                        style={{ maxWidth: '100%', maxHeight: 200, borderRadius: 4, objectFit: 'contain' }}
                      />
                    ) : (
                      <span style={{ ...rs.inspectorValue, fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
                        {JSON.stringify(value)}
                      </span>
                    )}
                  </div>
                )
              })}
            </>
          )}

          {/* Dependencies */}
          {selectedRunNodeEdges.incoming.length > 0 && (
            <>
              <div style={{ ...rs.inspectorTitle, marginTop: 6 }}>DEPENDENCIES</div>
              {selectedRunNodeEdges.incoming.map((edge) => (
                <div key={edge.id} style={rs.inspectorRow}>
                  <span style={rs.inspectorValue}>{nodeNameById(edge.from_run_node_id)}</span>
                </div>
              ))}
            </>
          )}

          {/* Dependents */}
          {selectedRunNodeEdges.outgoing.length > 0 && (
            <>
              <div style={{ ...rs.inspectorTitle, marginTop: 6 }}>DEPENDENTS</div>
              {selectedRunNodeEdges.outgoing.map((edge) => (
                <div key={edge.id} style={rs.inspectorRow}>
                  <span style={rs.inspectorValue}>{nodeNameById(edge.to_run_node_id)}</span>
                </div>
              ))}
            </>
          )}

          {/* Action buttons */}
          <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
            {selectedRunNode.source_node_id && (
              <button style={rs.goToSourceBtn} onClick={handleGoToSource}>
                Go to {selectedRunNode.source_type === 'graph_node' ? 'graph' : 'template'} →
              </button>
            )}
            {canSyncNode && (
              <button style={rs.syncBtn} onClick={() => void handleSyncNode()}>
                Sync from source
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const rs: Record<string, React.CSSProperties> = {
  headerBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    padding: '6px 8px',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0,
  },
  select: {
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
  runBtn: {
    padding: '4px 10px',
    background: 'var(--accent)',
    color: '#ffffff',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '12px',
    fontWeight: 600,
    flexShrink: 0,
  },
  stateDot: {
    width: 10,
    height: 10,
    borderRadius: '50%',
    flexShrink: 0,
    display: 'inline-block',
  },
  breadcrumbBar: {
    display: 'flex',
    gap: 6,
    padding: '6px 8px',
    borderBottom: '1px solid var(--border)',
    flexWrap: 'wrap',
  },
  crumb: {
    padding: '2px 8px',
    borderRadius: 999,
    border: '1px solid var(--border)',
    background: 'var(--surface-2)',
    color: 'var(--text)',
    cursor: 'pointer',
    fontSize: '11px',
  },
  crumbActive: {
    padding: '2px 8px',
    borderRadius: 999,
    border: '1px solid var(--accent)',
    background: 'color-mix(in srgb, var(--accent) 18%, var(--surface) 82%)',
    color: 'var(--text)',
    cursor: 'pointer',
    fontSize: '11px',
    fontWeight: 600,
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
    fontSize: '13px',
    whiteSpace: 'pre-wrap',
  },
  nodeLabel: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  childRunBtn: {
    border: '1px solid currentColor',
    borderRadius: 4,
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    fontSize: '10px',
    lineHeight: 1,
    padding: '2px 4px',
    flexShrink: 0,
  },
  inspector: {
    borderTop: '1px solid var(--border)',
    padding: '8px 10px',
    background: 'var(--surface)',
    flexShrink: 0,
    maxHeight: '45%',
    overflowY: 'auto',
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
    width: '42px',
    fontSize: '12px',
  },
  inspectorValue: {
    flex: 1,
    fontSize: '12px',
    color: 'var(--text)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  inspectorSelect: {
    flex: 1,
    padding: '2px 4px',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    background: 'var(--surface-2)',
    fontSize: '12px',
    outline: 'none',
    fontWeight: 600,
  },
  goToSourceBtn: {
    padding: '4px 10px',
    background: 'var(--accent)',
    color: '#fff',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '12px',
    fontWeight: 600,
  },
  syncBtn: {
    padding: '4px 10px',
    background: 'var(--surface-2)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '12px',
    fontWeight: 600,
  },
}
