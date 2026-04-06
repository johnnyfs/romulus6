import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  type Graph,
  type GraphRun,
  type RunNodeState,
  listGraphs,
  listRuns,
  createRun,
  getRun,
  getRunById,
} from '../api/graphs'
import { NODE_W, NODE_H, PADDING_TOP, CANVAS_WIDTH, computeLayout } from './graphLayout'

const STATE_COLORS: Record<RunNodeState, string> = {
  pending: 'var(--text-muted)',
  running: '#3b82f6',
  completed: '#22c55e',
  error: '#ef4444',
}

export default function RunsView({ workspaceId }: { workspaceId: string }) {
  const [graphs, setGraphs] = useState<Graph[]>([])
  const [selectedGraphId, setSelectedGraphId] = useState<string | null>(null)
  const [runs, setRuns] = useState<GraphRun[]>([])
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [activeRun, setActiveRun] = useState<GraphRun | null>(null)
  const [runPath, setRunPath] = useState<GraphRun[]>([])
  const [creating, setCreating] = useState(false)

  // Load graphs
  const loadGraphs = useCallback(async () => {
    const gs = await listGraphs(workspaceId)
    setGraphs(gs)
    if (gs.length > 0 && !selectedGraphId) setSelectedGraphId(gs[0].id)
  }, [workspaceId, selectedGraphId])

  useEffect(() => { loadGraphs() }, [loadGraphs])

  // Load runs when graph changes
  const loadRuns = useCallback(async () => {
    if (!selectedGraphId) { setRuns([]); return }
    const rs = await listRuns(workspaceId, selectedGraphId)
    setRuns(rs)
  }, [workspaceId, selectedGraphId])

  useEffect(() => { loadRuns() }, [loadRuns])

  // Load run detail when selection changes
  useEffect(() => {
    if (!selectedRunId || !selectedGraphId) {
      setActiveRun(null)
      setRunPath([])
      return
    }
    const run = runs.find(r => r.id === selectedRunId)
    if (run) {
      setActiveRun(run)
      setRunPath([run])
    }
  }, [selectedRunId, runs, selectedGraphId])

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
        setActiveRun(updated)
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
    setActiveRun(childRun)
    setRunPath(prev => [...prev, childRun])
  }, [workspaceId])

  const handleSelectRunAtDepth = useCallback(async (index: number) => {
    setRunPath(prev => {
      const next = prev.slice(0, index + 1)
      const selected = next[next.length - 1] ?? null
      setActiveRun(selected)
      return next
    })
  }, [])

  const runStateColor = (state: string) => {
    if (state === 'running') return '#3b82f6'
    if (state === 'completed') return '#22c55e'
    if (state === 'error') return '#ef4444'
    return 'var(--text-muted)'
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {/* Graph selector */}
      <div style={rs.headerBar}>
        <select
          style={rs.select}
          value={selectedGraphId ?? ''}
          onChange={(e) => {
            setSelectedGraphId(e.target.value || null)
            setSelectedRunId(null)
            setActiveRun(null)
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
              return (
                <div
                  key={rn.id}
                  style={{
                    position: 'absolute',
                    left: pos.x,
                    top: pos.y,
                    width: NODE_W,
                    height: NODE_H,
                    background: 'var(--surface)',
                    border: `2px solid ${color}`,
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
                    color,
                    gap: 6,
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
}
