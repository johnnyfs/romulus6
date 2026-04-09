import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAutoResize } from '../hooks/useAutoResize'
import { useFeed, type ActivityBlock } from '../hooks/useFeed'
import { useWorkspaceEvents } from '../hooks/useWorkspaceEvents'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  type Agent,
  type AgentEvent,
  createAgent,
  deleteAgent,
  dismissAgent,
  listAgents,
  sendFeedback,
  sendMessage,
} from '../api/agents'
import { getSandboxDebugSummary, type SandboxDebugSummary } from '../api/sandboxes'
import {
  DEFAULT_MODEL_BY_AGENT_TYPE,
  PYDANTIC_SCHEMA_OPTIONS,
  SANDBOX_MODE_OPTIONS,
  SUPPORTED_MODELS_BY_AGENT_TYPE,
  type AgentType,
  type PydanticSchemaId,
  type SandboxMode,
} from '../api/models'
import { getWorkspace, type Workspace } from '../api/workspaces'
import AgentCard from '../components/AgentCard'
import ErrorBoundary from '../components/ErrorBoundary'
import FeedbackRequest from '../components/FeedbackRequest'
import { MarkdownMessage } from '../components/MarkdownMessage'
import GraphPanel from '../components/GraphPanel'
import {
  WORKSPACE_DETAIL_PARAM_KEYS,
  type WorkspaceDetailTab,
  mergeSearchParams,
  readBooleanParam,
  readEnumParam,
  readStringParam,
} from '../components/workspaceDetailSearchParams'

const AGENT_COLORS = [
  '#2dd4bf', '#f97066', '#a78bfa', '#84cc16', '#f59e0b', '#e879a8',
  '#38bdf8', '#f97316', '#34d399', '#f472b6', '#818cf8', '#fbbf24',
]

// ─── Event rendering ─────────────────────────────────────────────────────────

function renderActivityEvent(event: AgentEvent): string {
  switch (event.type) {
    case 'file.edit':
      return `✎ ${String(event.data.path ?? 'file')}`
    case 'tool.use': {
      const tool = String(event.data.tool ?? 'tool')
      const args = event.data.args as Record<string, unknown> | undefined
      if (args && typeof args === 'object') {
        const keys = Object.keys(args)
        if (keys.length > 0) {
          const preview = keys.map((k) => `${k}=${JSON.stringify(args[k])}`).join(', ')
          return `⚙ ${tool}(${preview.length > 80 ? preview.slice(0, 77) + '…' : preview})`
        }
      }
      return `⚙ ${tool}`
    }
    case 'command.output': {
      const out = String(event.data.stdout ?? '').trim()
      const err = String(event.data.stderr ?? '').trim()
      const preview = (out || err).slice(0, 80)
      return `$ ${preview}`
    }
    case 'run.node.completed': {
      const nodeName = String(event.data.node_name ?? 'node')
      const schema = event.data.output_schema as Record<string, string> | undefined
      const hasImages = schema && Object.values(schema).includes('image')
      return `✓ ${nodeName}${hasImages ? ' 🖼' : ''}`
    }
    default:
      return event.type
  }
}

function ToolUseDetail({ event }: { event: AgentEvent }) {
  const [expanded, setExpanded] = useState(false)
  const tool = String(event.data.tool ?? 'tool')
  const args = event.data.args as Record<string, unknown> | undefined
  const stdout = event.data.stdout ? String(event.data.stdout) : null
  const hasDetail = (args && Object.keys(args).length > 0) || stdout

  return (
    <div>
      <span
        style={{ ...hist.accent, cursor: hasDetail ? 'pointer' : 'default' }}
        onClick={hasDetail ? () => setExpanded((v) => !v) : undefined}
      >
        {hasDetail && <span style={{ fontSize: '10px', marginRight: '4px' }}>{expanded ? '∨' : '›'}</span>}
        ⚙ {tool}
      </span>
      {expanded && (
        <div style={{ marginTop: '4px' }}>
          {args && Object.keys(args).length > 0 && (
            <pre style={hist.pre}>{JSON.stringify(args, null, 2)}</pre>
          )}
          {stdout && (
            <pre style={{ ...hist.pre, marginTop: '4px' }}>
              {stdout}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

function NodeOutputDetail({ event }: { event: AgentEvent }) {
  const [expanded, setExpanded] = useState(false)
  const nodeName = String(event.data.node_name ?? 'node')
  const output = event.data.output as Record<string, unknown> | undefined
  const schema = event.data.output_schema as Record<string, string> | undefined
  const hasOutput = output && Object.keys(output).length > 0

  return (
    <div>
      <span
        style={{ ...hist.accent, cursor: hasOutput ? 'pointer' : 'default' }}
        onClick={hasOutput ? () => setExpanded((v) => !v) : undefined}
      >
        {hasOutput && <span style={{ fontSize: '10px', marginRight: '4px' }}>{expanded ? '∨' : '›'}</span>}
        ✓ {nodeName}
        {!expanded && schema && Object.entries(schema).some(([, t]) => t === 'image') && output && (
          <span style={{ marginLeft: 6 }}>
            {Object.entries(schema).filter(([, t]) => t === 'image').map(([k]) => {
              const val = output[k]
              return typeof val === 'string' ? (
                <img key={k} src={val} alt={k}
                  style={{ height: 20, width: 20, objectFit: 'cover', borderRadius: 2, verticalAlign: 'middle', marginLeft: 2 }} />
              ) : null
            })}
          </span>
        )}
      </span>
      {expanded && output && (
        <div style={{ marginTop: '4px' }}>
          {Object.entries(output).map(([key, value]) => {
            const isImage = schema?.[key] === 'image' && typeof value === 'string'
            return (
              <div key={key} style={{ marginBottom: 4 }}>
                <span style={{ color: 'var(--text-dim)', fontSize: '11px' }}>{key}: </span>
                {isImage ? (
                  <img src={value as string} alt={key}
                    style={{ maxWidth: '100%', maxHeight: 300, borderRadius: 4, display: 'block', marginTop: 2 }} />
                ) : (
                  <pre style={hist.pre}>{JSON.stringify(value, null, 2)}</pre>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function renderActivityHistory(event: AgentEvent): React.ReactNode {
  switch (event.type) {
    case 'file.edit':
      return <span style={hist.accent}>✎ {String(event.data.path ?? 'file')}</span>
    case 'tool.use':
      return <ToolUseDetail event={event} />
    case 'command.output':
      return (
        <pre style={hist.pre}>
          {String(event.data.stdout ?? '')}
          {event.data.stderr ? `\n[stderr]\n${String(event.data.stderr)}` : ''}
        </pre>
      )
    case 'run.node.completed':
      return <NodeOutputDetail event={event} />
    default:
      return <span style={hist.dim}>{event.type}</span>
  }
}

const hist: Record<string, React.CSSProperties> = {
  accent: { color: 'var(--accent)' },
  dim: { color: 'var(--text-muted)', fontStyle: 'italic' },
  pre: {
    margin: '4px 0 0 0',
    padding: '6px 10px',
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    color: 'var(--text-dim)',
    fontFamily: "'Menlo', 'Consolas', monospace",
    fontSize: '12px',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
  },
}

// ─── Activity block component ─────────────────────────────────────────────────

function ActivityLine({
  block,
  expanded,
  onToggle,
  sourceLabel,
  color,
}: {
  block: ActivityBlock
  expanded: boolean
  onToggle: () => void
  sourceLabel: string
  color?: string
}) {
  return (
    <div style={styles.activityWrap}>
      <div style={styles.activityRow}>
        <button style={styles.chevron} onClick={onToggle} title="Toggle history">
          {expanded ? '∨' : '›'}
        </button>
        <span style={{ ...styles.activityPrefix, color: color ?? 'var(--text-dim)' }}>{sourceLabel}</span>
        <span style={styles.activityLatest}>
          {renderActivityEvent(block.latest)}
        </span>
      </div>
      {expanded && (
        <div style={styles.historyList}>
          {block.history.map((ev) => (
            <div key={ev.id} style={styles.historyItem}>
              {renderActivityHistory(ev)}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function WorkspaceDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [agents, setAgents] = useState<Agent[]>([])
  const [workspaceEventsVersion, setWorkspaceEventsVersion] = useState(0)
  const activeTab = readEnumParam(
    searchParams,
    WORKSPACE_DETAIL_PARAM_KEYS.workspaceTab,
    ['activity', 'sandboxes'] as const,
    'activity',
  )
  const selectedAgentId = readStringParam(searchParams, WORKSPACE_DETAIL_PARAM_KEYS.agentId)
  const setSelectedAgentId = useCallback(
    (agentId: string | null) => {
      setSearchParams(
        (prev) => mergeSearchParams(prev, { [WORKSPACE_DETAIL_PARAM_KEYS.agentId]: agentId }),
        { replace: true },
      )
    },
    [setSearchParams],
  )
  const {
    eventMap, setEventMap,
    agentBusy,
    agentTerminal, setAgentTerminal,
    agentWaiting, setAgentWaiting,
    resolvedFeedback, setResolvedFeedback,
    streamStatus,
  } = useWorkspaceEvents(
    id,
    !!workspace,
    (msg) => setPageError(msg),
    workspaceEventsVersion,
  )
  const [expandedBlocks, setExpandedBlocks] = useState<Set<string>>(new Set())
  const [showForm, setShowForm] = useState(false)
  const [formAgentType, setFormAgentType] = useState<AgentType>('opencode')
  const [formModel, setFormModel] = useState(DEFAULT_MODEL_BY_AGENT_TYPE.opencode)
  const [formSchemaId, setFormSchemaId] = useState<PydanticSchemaId>('structured_response_v1')
  const [formPrompt, setFormPrompt] = useState('')
  const [formName, setFormName] = useState('')
  const [formGraphTools, setFormGraphTools] = useState(false)
  const [formSandboxMode, setFormSandboxMode] = useState<SandboxMode>('read-only')
  const [creating, setCreating] = useState(false)
  const [chatInput, setChatInput] = useState('')
  const chatRef = useAutoResize(chatInput, 144)
  const promptRef = useAutoResize(formPrompt, 234, 60)
  const [targetAgentId, setTargetAgentId] = useState<string | null>(null)
  // Fall back to selected agent or first non-dismissed agent
  const effectiveTargetId = (() => {
    if (targetAgentId && agents.find((a) => a.id === targetAgentId && !a.dismissed)) return targetAgentId
    if (selectedAgentId && agents.find((a) => a.id === selectedAgentId && !a.dismissed)) return selectedAgentId
    const first = agents.find((a) => !a.dismissed)
    return first?.id ?? null
  })()
  const [userMessages, setUserMessages] = useState<
    { agentId: string; prompt: string; timestamp: string; isDispatch?: boolean }[]
  >(() => {
    try {
      const stored = localStorage.getItem(`user-messages-${id}`)
      return stored ? JSON.parse(stored) : []
    } catch (err) {
      console.warn('Failed to parse stored user messages:', err)
      return []
    }
  })
  const feedBottomRef = useRef<HTMLDivElement>(null)
  const isNearBottom = useRef(true)
  const showDeadMessages = readBooleanParam(
    searchParams,
    WORKSPACE_DETAIL_PARAM_KEYS.showDeadMessages,
    true,
  )
  const showDismissedAgents = readBooleanParam(
    searchParams,
    WORKSPACE_DETAIL_PARAM_KEYS.showDismissedAgents,
    true,
  )
  const [collapsedRuns, setCollapsedRuns] = useState<Set<string>>(new Set())
  const [graphWidth, setGraphWidth] = useState(340)
  const [sandboxDebug, setSandboxDebug] = useState<SandboxDebugSummary | null>(null)
  const [sandboxDebugLoading, setSandboxDebugLoading] = useState(false)
  const [pageError, setPageError] = useState<string | null>(null)
  const hideFailedWorkers = readBooleanParam(
    searchParams,
    WORKSPACE_DETAIL_PARAM_KEYS.hideFailedWorkers,
    false,
  )
  const isDragging = useRef(false)
  const dragStartX = useRef(0)
  const dragStartWidth = useRef(0)

  // ── Data loading ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (!id) return
    let cancelled = false

    void Promise.all([getWorkspace(id), listAgents(id)])
      .then(([ws, agts]) => {
        if (cancelled) return
        setWorkspace(ws)
        setAgents(agts)
        setPageError(null)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        const msg = error instanceof Error ? error.message : ''
        if (msg.includes('not found') || msg.includes('Not found')) {
          navigate('/workspaces', { replace: true })
          return
        }
        setPageError(msg || 'Failed to load workspace')
      })

    return () => {
      cancelled = true
    }
  }, [id, navigate])

  useEffect(() => {
    if (id) localStorage.setItem(`user-messages-${id}`, JSON.stringify(userMessages))
  }, [id, userMessages])

  // Initialize list/feed visibility params if absent
  useEffect(() => {
    setSearchParams((prev) => {
      if (
        prev.get(WORKSPACE_DETAIL_PARAM_KEYS.workspaceTab) != null &&
        prev.get(WORKSPACE_DETAIL_PARAM_KEYS.showDeadMessages) != null &&
        prev.get(WORKSPACE_DETAIL_PARAM_KEYS.showDismissedAgents) != null
      ) {
        return prev
      }
      return mergeSearchParams(prev, {
        [WORKSPACE_DETAIL_PARAM_KEYS.workspaceTab]: 'activity',
        [WORKSPACE_DETAIL_PARAM_KEYS.showDeadMessages]: '1',
        [WORKSPACE_DETAIL_PARAM_KEYS.showDismissedAgents]: '1',
      })
    }, { replace: true })
  }, [id, setSearchParams])

  useEffect(() => {
    if (isNearBottom.current) {
      feedBottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [eventMap, userMessages])

  const loadSandboxDebug = useCallback(async () => {
    if (!id) return
    setSandboxDebugLoading(true)
    try {
      setSandboxDebug(await getSandboxDebugSummary(id))
      setPageError(null)
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'Failed to load sandbox details')
    } finally {
      setSandboxDebugLoading(false)
    }
  }, [id])

  useEffect(() => {
    if (!id || !workspace || activeTab !== 'sandboxes') return
    loadSandboxDebug().catch((err) => console.warn('Sandbox debug load failed:', err))
    const interval = window.setInterval(() => {
      loadSandboxDebug().catch((err) => console.warn('Sandbox debug poll failed:', err))
    }, 5000)
    return () => window.clearInterval(interval)
  }, [activeTab, id, workspace, loadSandboxDebug])

  // ── Feed building ─────────────────────────────────────────────────────────

  // Dead agent IDs for filter (must be before `feed` which depends on it)
  const dismissedAgentIds = useMemo(() => {
    return new Set(agents.filter((a) => a.dismissed).map((a) => a.id))
  }, [agents])

  const knownAgentIds = useMemo(() => {
    return new Set(agents.map((a) => a.id))
  }, [agents])

  // NOTE: Do NOT prune userMessages when knownAgentIds changes — the agents
  // list can temporarily be stale (e.g., after page reload before listAgents
  // returns) and pruning would permanently destroy messages from localStorage.

  const agentColorMap = useMemo(() => {
    const map: Record<string, string> = {}
    const sorted = [...agents].sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''))
    sorted.forEach((agent, i) => {
      map[agent.id] = AGENT_COLORS[i % AGENT_COLORS.length]
    })
    return map
  }, [agents])

  function agentColor(agentId: string, event?: AgentEvent): string {
    return event?.display_color ?? agentColorMap[agentId] ?? 'var(--accent)'
  }

  const feed = useFeed({ eventMap, userMessages, showDeadMessages, dismissedAgentIds, resolvedFeedback, knownAgentIds })

  // ── Helpers ───────────────────────────────────────────────────────────────

  function agentName(agentId: string): string {
    const a = agents.find((x) => x.id === agentId)
    if (!a) return 'agent'
    return a.name ?? `${a.agent_type}/${a.model?.split('/')[1] ?? 'agent'}`
  }

  function eventLabel(event: AgentEvent, fallbackId?: string): string {
    if (event.display_label) return `${event.display_label}:`
    if (event.agent_id) return `${agentName(event.agent_id)}:`
    if (fallbackId) return `${agentName(fallbackId)}:`
    return 'event:'
  }

  // Partition agents into ad-hoc and run-grouped
  const adHocAgents = useMemo(() => agents.filter((a) => !a.graph_run_id), [agents])
  const visibleAdHocAgents = useMemo(
    () => adHocAgents.filter((a) => showDismissedAgents || !a.dismissed),
    [adHocAgents, showDismissedAgents],
  )
  const runAgentGroups = useMemo(() => {
    const groups = new Map<string, Agent[]>()
    for (const a of agents) {
      if (!a.graph_run_id) continue
      const list = groups.get(a.graph_run_id) ?? []
      list.push(a)
      groups.set(a.graph_run_id, list)
    }
    return groups
  }, [agents])
  const visibleRunAgentGroups = useMemo(() => {
    const groups = new Map<string, Agent[]>()
    for (const [runId, runAgents] of runAgentGroups.entries()) {
      const visible = runAgents.filter((a) => showDismissedAgents || !a.dismissed)
      if (visible.length > 0) groups.set(runId, visible)
    }
    return groups
  }, [runAgentGroups, showDismissedAgents])

  function replaceAgent(updatedAgent: Agent) {
    setAgents((prev) => prev.map((agent) => (agent.id === updatedAgent.id ? updatedAgent : agent)))
  }

  function removeAgentHistory(agentId: string) {
    setEventMap((prev) =>
      Object.fromEntries(
        Object.entries(prev).filter(
          ([streamKey, events]) =>
            streamKey !== `agent:${agentId}` &&
            !events.some((event) => event.agent_id === agentId),
        ),
      ),
    )
    setUserMessages((prev) => prev.filter((m) => m.agentId !== agentId))
    setResolvedFeedback((prev) =>
      Object.fromEntries(
        Object.entries(prev).filter(([feedbackId]) =>
          !Object.values(eventMap).flat().some(
            (event) => event.agent_id === agentId && String(event.data?.feedback_id ?? '') === feedbackId,
          ),
        ),
      ),
    )
  }


  function toggleBlock(blockId: string) {
    setExpandedBlocks((prev) => {
      const next = new Set(prev)
      if (next.has(blockId)) next.delete(blockId)
      else next.add(blockId)
      return next
    })
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  async function handleCreateAgent(
    prompt: string,
    model: string,
    name: string,
    graphTools: boolean = false,
    agentType: AgentType = 'opencode',
    schemaId: PydanticSchemaId = 'structured_response_v1',
    sandboxMode: SandboxMode = 'read-only',
  ) {
    if (!id || !prompt.trim()) return
    setCreating(true)
    try {
      const body =
        agentType === 'pydantic'
          ? {
              agent_type: 'pydantic' as const,
              model,
              prompt: prompt.trim(),
              name: name.trim() || undefined,
              schema_id: schemaId,
            }
          : agentType === 'codex'
          ? {
              agent_type: 'codex' as const,
              model,
              prompt: prompt.trim(),
              name: name.trim() || undefined,
              graph_tools: graphTools || undefined,
              sandbox_mode: sandboxMode,
            }
          : agentType === 'claude_code'
          ? {
              agent_type: 'claude_code' as const,
              model,
              prompt: prompt.trim(),
              name: name.trim() || undefined,
              graph_tools: graphTools || undefined,
            }
          : {
              agent_type: 'opencode' as const,
              model,
              prompt: prompt.trim(),
              name: name.trim() || undefined,
              graph_tools: graphTools || undefined,
            }
      const agent = await createAgent(id, body)
      setAgents((prev) => [...prev, agent])
      setUserMessages((prev) => [
        ...prev,
        { agentId: agent.id, prompt: prompt.trim(), timestamp: new Date().toISOString(), isDispatch: true },
      ])
      setSelectedAgentId(agent.id)
      setShowForm(false)
      setFormPrompt('')
      setFormName('')
      setFormGraphTools(false)
      setFormSandboxMode('read-only')
      setFormAgentType('opencode')
      setFormModel(DEFAULT_MODEL_BY_AGENT_TYPE.opencode)
      setFormSchemaId('structured_response_v1')
    } catch (err) {
      setPageError(err instanceof Error ? err.message : 'Failed to create agent')
    } finally {
      setCreating(false)
    }
  }

  async function handleChatSend() {
    const targetId = effectiveTargetId
    if (!id || !chatInput.trim() || !targetId) return
    setCreating(true)
    try {
      setUserMessages((prev) => [
        ...prev,
        { agentId: targetId, prompt: chatInput.trim(), timestamp: new Date().toISOString() },
      ])
      await sendMessage(id, targetId, chatInput.trim())
      setAgentTerminal((prev) => ({ ...prev, [targetId]: false }))
      setChatInput('')
    } catch (err) {
      setPageError(err instanceof Error ? err.message : 'Failed to send message')
    } finally {
      setCreating(false)
    }
  }

  const workspaceName = workspace?.name ?? '…'

  const setActiveTab = useCallback(
    (tab: WorkspaceDetailTab) => {
      setSearchParams(
        (prev) => mergeSearchParams(prev, { [WORKSPACE_DETAIL_PARAM_KEYS.workspaceTab]: tab }),
        { replace: false },
      )
    },
    [setSearchParams],
  )

  // ── Graph panel resize ────────────────────────────────────────────────────

  const handleGraphDragStart = (e: React.MouseEvent) => {
    isDragging.current = true
    dragStartX.current = e.clientX
    dragStartWidth.current = graphWidth
    e.preventDefault()
  }

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return
      const delta = dragStartX.current - e.clientX
      setGraphWidth(Math.max(180, Math.min(800, dragStartWidth.current + delta)))
    }
    const onMouseUp = () => { isDragging.current = false }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={styles.page}>
      {/* Header */}
      <div style={styles.header}>
        <Link to="/workspaces" style={styles.back}>← Back</Link>
        <span style={styles.headerSep}>/</span>
        <span style={styles.title}>{workspaceName}</span>
      </div>

      {pageError ? <div style={styles.errorBanner}>{pageError}</div> : null}
      {(streamStatus === 'reconnecting' || streamStatus === 'error') && (
        <div style={styles.reconnectBanner}>
          {streamStatus === 'reconnecting' ? 'Reconnecting to event stream…' : 'Event stream disconnected — retrying…'}
        </div>
      )}

      {/* Body */}
      <div style={styles.body}>
        {/* Sidebar */}
        <div style={styles.sidebar}>
          <div style={styles.sidebarHeader}>
            <span style={styles.sidebarLabel}>Agents</span>
            <label style={styles.sidebarDismissedToggle}>
              <input
                type="checkbox"
                checked={showDismissedAgents}
                onChange={(e) => {
                  setSearchParams(
                    (prev) =>
                      mergeSearchParams(prev, {
                        [WORKSPACE_DETAIL_PARAM_KEYS.showDismissedAgents]: e.target.checked ? '1' : '0',
                      }),
                    { replace: false },
                  )
                }}
              />
              dismissed
            </label>
          </div>

          <button style={styles.newAgentBtn} onClick={() => setShowForm((v) => !v)}>
            {showForm ? '✕ Close' : '+ New agent'}
          </button>

          {showForm && (
            <div style={styles.form}>
              <div style={styles.formRow}>
                <label style={styles.label} htmlFor="agent-type-select">Type</label>
                <select
                  id="agent-type-select"
                  style={styles.select}
                  value={formAgentType}
                  onChange={(e) => {
                    const nextType = e.target.value as AgentType
                    setFormAgentType(nextType)
                    setFormModel(DEFAULT_MODEL_BY_AGENT_TYPE[nextType])
                    if (nextType !== 'codex') setFormSandboxMode('read-only')
                  }}
                >
                  <option value="opencode">OpenCode</option>
                  <option value="pydantic">Pydantic</option>
                  <option value="codex">Codex</option>
                  <option value="claude_code">Claude Code</option>
                </select>
              </div>
              <div style={styles.formRow}>
                <label style={styles.label} htmlFor="agent-model-select">Model</label>
                <select
                  id="agent-model-select"
                  style={styles.select}
                  value={formModel}
                  onChange={(e) => setFormModel(e.target.value)}
                >
                  {SUPPORTED_MODELS_BY_AGENT_TYPE[formAgentType].map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              </div>
              {formAgentType === 'pydantic' && (
                <div style={styles.formRow}>
                  <label style={styles.label} htmlFor="agent-schema-select">Schema</label>
                  <select
                    id="agent-schema-select"
                    style={styles.select}
                    value={formSchemaId}
                    onChange={(e) => setFormSchemaId(e.target.value as PydanticSchemaId)}
                  >
                    {PYDANTIC_SCHEMA_OPTIONS.map((schema) => (
                      <option key={schema.value} value={schema.value}>{schema.label}</option>
                    ))}
                  </select>
                </div>
              )}
              {formAgentType === 'codex' && (
                <div style={styles.formRow}>
                  <label style={styles.label} htmlFor="agent-sandbox-mode-select">Sandbox</label>
                  <select
                    id="agent-sandbox-mode-select"
                    style={styles.select}
                    value={formSandboxMode}
                    onChange={(e) => setFormSandboxMode(e.target.value as SandboxMode)}
                  >
                    {SANDBOX_MODE_OPTIONS.map((mode) => (
                      <option key={mode.value} value={mode.value}>{mode.label}</option>
                    ))}
                  </select>
                </div>
              )}
              <div style={styles.formRow}>
                <label style={styles.label} htmlFor="agent-name-input">Name (optional)</label>
                <input
                  id="agent-name-input"
                  style={styles.input}
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="agent name"
                />
              </div>
              <div style={styles.formRow}>
                <label style={styles.label} htmlFor="agent-prompt-input">Prompt</label>
                <textarea
                  ref={promptRef}
                  id="agent-prompt-input"
                  style={{ ...styles.textarea, resize: 'none' }}
                  value={formPrompt}
                  onChange={(e) => setFormPrompt(e.target.value)}
                  placeholder="What should this agent do?"
                />
              </div>
              {(formAgentType === 'opencode' || formAgentType === 'codex' || formAgentType === 'claude_code') && (
                <div style={styles.formRow}>
                  <label style={styles.label}>
                    <input
                      type="checkbox"
                      checked={formGraphTools}
                      onChange={(e) => setFormGraphTools(e.target.checked)}
                      style={{ marginRight: 6 }}
                    />
                    Graph Editor
                  </label>
                </div>
              )}
              <button
                style={{ ...styles.submitBtn, opacity: creating || !formPrompt.trim() ? 0.4 : 1 }}
                disabled={creating || !formPrompt.trim()}
                onClick={() => handleCreateAgent(formPrompt, formModel, formName, formGraphTools, formAgentType, formSchemaId, formSandboxMode)}
              >
                {creating ? 'Dispatching…' : 'Dispatch'}
              </button>
            </div>
          )}

          <div style={styles.agentList}>
            {visibleAdHocAgents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                selected={selectedAgentId === agent.id}
                isRunning={!agentTerminal[agent.id]}
                color={agentColorMap[agent.id]}
                onClick={() => setSelectedAgentId(agent.id)}
                onDismiss={async () => {
                  if (!id) return
                  const updated = await dismissAgent(id, agent.id, !agent.dismissed)
                  replaceAgent(updated)
                }}
                onDelete={async () => {
                  if (!id) return
                  if (!agent.dismissed) return
                  await deleteAgent(id, agent.id)
                  setAgents((prev) => prev.filter((a) => a.id !== agent.id))
                  removeAgentHistory(agent.id)
                  if (selectedAgentId === agent.id) setSelectedAgentId(null)
                }}
              />
            ))}

            {Array.from(visibleRunAgentGroups.entries()).map(([runId, runAgents]) => (
              <div key={runId}>
                <button
                  style={styles.runGroupHeader}
                  onClick={() => setCollapsedRuns((prev) => {
                    const next = new Set(prev)
                    if (next.has(runId)) next.delete(runId)
                    else next.add(runId)
                    return next
                  })}
                >
                  <span>{collapsedRuns.has(runId) ? '›' : '∨'}</span>
                  <span style={styles.runGroupLabel}>Run {runId.slice(0, 8)}</span>
                </button>
                {!collapsedRuns.has(runId) && runAgents.map((agent) => (
                  <AgentCard
                    key={agent.id}
                    agent={agent}
                    selected={selectedAgentId === agent.id}
                    isRunning={!agentTerminal[agent.id]}
                    isRunAgent
                    color={agentColorMap[agent.id]}
                    onClick={() => setSelectedAgentId(agent.id)}
                    onDismiss={async () => {
                      if (!id) return
                      const updated = await dismissAgent(id, agent.id, !agent.dismissed)
                      replaceAgent(updated)
                    }}
                    onDelete={async () => {
                      if (!id) return
                      if (!agent.dismissed) return
                      await deleteAgent(id, agent.id)
                      setAgents((prev) => prev.filter((a) => a.id !== agent.id))
                      removeAgentHistory(agent.id)
                      if (selectedAgentId === agent.id) setSelectedAgentId(null)
                    }}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* Main feed */}
        <div style={styles.main}>
          <div style={styles.tabBar}>
            <button
              style={{
                ...styles.tabButton,
                ...(activeTab === 'activity' ? styles.tabButtonActive : {}),
              }}
              onClick={() => setActiveTab('activity')}
            >
              Activity
            </button>
            <button
              style={{
                ...styles.tabButton,
                ...(activeTab === 'sandboxes' ? styles.tabButtonActive : {}),
              }}
              onClick={() => setActiveTab('sandboxes')}
            >
              Sandboxes
            </button>
          </div>

          {activeTab === 'activity' ? (
            <>
              <div style={styles.filterBar}>
                <label style={styles.filterLabel}>
                  <input
                    type="checkbox"
                    checked={showDeadMessages}
                    onChange={(e) => {
                      setSearchParams(
                        (prev) =>
                          mergeSearchParams(prev, {
                            [WORKSPACE_DETAIL_PARAM_KEYS.showDeadMessages]: e.target.checked ? '1' : '0',
                          }),
                        { replace: false },
                      )
                    }}
                    style={{ marginRight: 6 }}
                  />
                  Show dismissed agent messages
                </label>
              </div>
              <div
                style={styles.feed}
                onScroll={(e) => {
                  const el = e.currentTarget
                  isNearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
                }}
              >
                {feed.length === 0 && (
                  <div style={styles.empty}>
                    No events yet. Dispatch an agent to get started.
                  </div>
                )}

                {feed.map((item) => {
                  const itemKey = item.kind === 'activity' ? item.block.blockId : item.key

                  if (item.kind === 'user') {
                    return (
                      <ErrorBoundary key={itemKey} resetKey={itemKey}>
                        <div style={styles.userBubbleWrap}>
                          <div style={styles.userBubble}>
                            <div style={styles.userBubbleHeader}>
                              you → {agentName(item.agentId)}
                              {item.isDispatch && <span style={styles.dispatchBadge}>prompt</span>}
                            </div>
                            <MarkdownMessage content={item.prompt} />
                          </div>
                        </div>
                      </ErrorBoundary>
                    )
                  }

                  if (item.kind === 'message') {
                    const agent = agents.find((a) => a.id === item.agentId)
                    const color = agentColor(item.agentId, item.event)
                    const isDismissed = agent?.dismissed ?? false
                    return (
                      <ErrorBoundary key={itemKey} resetKey={itemKey}>
                        <div style={{ ...styles.agentBubbleWrap, opacity: isDismissed ? 0.45 : 1 }}>
                          <div style={{ ...styles.agentBubble, borderLeft: `3px solid ${color}` }}>
                            <div style={{ ...styles.agentBubbleHeader, color }}>
                              {agentName(item.agentId)}
                            </div>
                            <MarkdownMessage
                              content={String(item.event.data.accumulated ?? item.event.data.delta ?? '')}
                            />
                          </div>
                        </div>
                      </ErrorBoundary>
                    )
                  }

                  if (item.kind === 'feedback') {
                    return (
                      <ErrorBoundary key={itemKey} resetKey={itemKey}>
                        <FeedbackRequest
                          event={item.event}
                          agentLabel={agentName(item.agentId)}
                          color={agentColor(item.agentId)}
                          resolved={item.resolved}
                          resolvedResponse={item.resolvedResponse}
                          disabled={!!agentTerminal[item.agentId]}
                          onRespond={async (feedbackId, feedbackType, response) => {
                            if (!id) return
                            await sendFeedback(id, item.agentId, feedbackId, feedbackType, response)
                            setResolvedFeedback((prev) => ({ ...prev, [feedbackId]: response }))
                            setAgentWaiting((prev) => ({ ...prev, [item.agentId]: false }))
                          }}
                        />
                      </ErrorBoundary>
                    )
                  }

                  return (
                    <ErrorBoundary key={itemKey} resetKey={itemKey}>
                      <ActivityLine
                        block={item.block}
                        expanded={expandedBlocks.has(item.block.blockId)}
                        onToggle={() => toggleBlock(item.block.blockId)}
                        sourceLabel={eventLabel(item.block.latest).replace(/:$/, '')}
                        color={agentColorMap[item.block.latest.agent_id ?? ''] ?? undefined}
                      />
                    </ErrorBoundary>
                  )
                })}

                <div ref={feedBottomRef} />
              </div>

              {agents.some((a) => !agentTerminal[a.id]) && (
                <div style={styles.statusBar}>
                  {agents
                    .filter((a) => !agentTerminal[a.id])
                    .map((a) => (
                      <span key={a.id} style={styles.statusItem}>
                        <span style={styles.statusName}>{agentName(a.id)}</span>
                        {agentWaiting[a.id] ? (
                          <span style={styles.statusWaiting}>awaiting input</span>
                        ) : agentBusy[a.id] ? (
                          <span style={styles.statusDots}>
                            <span className="pulse-dot-1">·</span>
                            <span className="pulse-dot-2">·</span>
                            <span className="pulse-dot-3">·</span>
                          </span>
                        ) : (
                          <span style={styles.statusDotsIdle}>···</span>
                        )}
                      </span>
                    ))}
                </div>
              )}

              <div style={styles.inputBar}>
                <select
                  style={styles.targetSelect}
                  value={effectiveTargetId ?? ''}
                  onChange={(e) => setTargetAgentId(e.target.value || null)}
                  disabled={!effectiveTargetId}
                >
                  {!effectiveTargetId && <option value="">No agents</option>}
                  {agents.filter((a) => !a.dismissed).map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name ?? `${a.agent_type}/${a.model?.split('/')[1] ?? 'agent'}`}
                    </option>
                  ))}
                </select>
                <textarea
                  ref={chatRef}
                  rows={1}
                  style={styles.chatInput}
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder={effectiveTargetId ? 'Send a message…' : 'Create an agent first…'}
                  disabled={!effectiveTargetId}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      handleChatSend()
                    }
                  }}
                />
                <button
                  style={{ ...styles.sendBtn, opacity: creating || !chatInput.trim() || !effectiveTargetId ? 0.4 : 1 }}
                  disabled={creating || !chatInput.trim() || !effectiveTargetId}
                  onClick={handleChatSend}
                >
                  Send
                </button>
              </div>
            </>
          ) : (
            <div style={styles.debugPane}>
              <div style={styles.debugHeader}>
                <div style={styles.debugSummaryGrid}>
                  <div style={styles.debugMetricCard}>
                    <div style={styles.debugMetricValue}>{sandboxDebug?.worker_count ?? '—'}</div>
                    <div style={styles.debugMetricLabel}>workers</div>
                  </div>
                  <div style={styles.debugMetricCard}>
                    <div style={styles.debugMetricValue}>{sandboxDebug?.attached_worker_count ?? '—'}</div>
                    <div style={styles.debugMetricLabel}>attached</div>
                  </div>
                  <div style={styles.debugMetricCard}>
                    <div style={styles.debugMetricValue}>{sandboxDebug?.sandbox_count ?? '—'}</div>
                    <div style={styles.debugMetricLabel}>sandboxes</div>
                  </div>
                  <div style={styles.debugMetricCard}>
                    <div style={styles.debugMetricValue}>{sandboxDebug?.active_agent_count ?? '—'}</div>
                    <div style={styles.debugMetricLabel}>live agents</div>
                  </div>
                  <div style={styles.debugMetricCard}>
                    <div style={styles.debugMetricValue}>{sandboxDebug?.dismissed_agent_count ?? '—'}</div>
                    <div style={styles.debugMetricLabel}>dismissed agents</div>
                  </div>
                </div>
                <button style={styles.refreshButton} onClick={() => loadSandboxDebug()}>
                  {sandboxDebugLoading ? 'Refreshing…' : 'Refresh'}
                </button>
              </div>

              <div style={styles.debugScroll}>
                <section style={styles.debugSection}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <h3 style={styles.debugSectionTitle}>Workers</h3>
                    <label style={styles.sidebarDismissedToggle}>
                      <input
                        type="checkbox"
                        checked={hideFailedWorkers}
                        onChange={(e) =>
                          setSearchParams(
                            (prev) =>
                              mergeSearchParams(prev, {
                                [WORKSPACE_DETAIL_PARAM_KEYS.hideFailedWorkers]: e.target.checked
                                  ? '1'
                                  : null,
                              }),
                            { replace: true },
                          )
                        }
                      />
                      hide failed
                    </label>
                  </div>
                  <div style={styles.debugTable}>
                    <div style={styles.debugTableHeader}>
                      <span>worker</span>
                      <span>status</span>
                      <span>lease</span>
                      <span>agents</span>
                      <span>heartbeat</span>
                    </div>
                    {(sandboxDebug?.workers ?? [])
                      .filter((w) => !hideFailedWorkers || w.is_healthy)
                      .sort((a, b) => {
                        const aTime = a.last_heartbeat_at ?? ''
                        const bTime = b.last_heartbeat_at ?? ''
                        return bTime.localeCompare(aTime)
                      })
                      .map((worker) => (
                      <div key={worker.id} style={styles.debugTableRow}>
                        <div>
                          <div style={styles.debugPrimary}>{worker.pod_name ?? worker.id.slice(0, 8)}</div>
                          <div style={styles.debugSecondary}>{worker.worker_url ?? worker.id}</div>
                        </div>
                        <div>
                          <span style={{
                            ...styles.debugBadge,
                            background: worker.is_healthy ? 'rgba(47, 133, 90, 0.18)' : 'rgba(220, 38, 38, 0.18)',
                            color: worker.is_healthy ? '#7dd3a6' : '#fca5a5',
                          }}>
                            {worker.status}
                          </span>
                        </div>
                        <div>
                          <div style={styles.debugPrimary}>{worker.sandbox_name ?? 'idle'}</div>
                          <div style={styles.debugSecondary}>{worker.active_lease_id ? worker.active_lease_id.slice(0, 8) : 'no lease'}</div>
                        </div>
                        <div>
                          <div style={styles.debugPrimary}>{worker.live_agent_count} live</div>
                          <div style={styles.debugSecondary}>{worker.dismissed_agent_count} dismissed</div>
                        </div>
                        <div style={styles.debugSecondary}>{worker.last_heartbeat_at ?? 'never'}</div>
                      </div>
                    ))}
                  </div>
                </section>

                <section style={styles.debugSection}>
                  <h3 style={styles.debugSectionTitle}>Sandboxes</h3>
                  {(sandboxDebug?.sandboxes ?? []).map((sandbox) => (
                    <div key={sandbox.id} style={styles.debugCard}>
                      <div style={styles.debugCardHeader}>
                        <div>
                          <div style={styles.debugPrimary}>{sandbox.name}</div>
                          <div style={styles.debugSecondary}>
                            worker {sandbox.worker_id ? sandbox.worker_id.slice(0, 8) : 'none'} · lease {sandbox.current_lease_id ? sandbox.current_lease_id.slice(0, 8) : 'none'}
                          </div>
                        </div>
                        <div style={styles.debugCounts}>
                          <span style={styles.debugBadge}>{sandbox.active_agent_count} live</span>
                          <span style={styles.debugBadgeMuted}>{sandbox.dismissed_agent_count} dismissed</span>
                        </div>
                      </div>
                      {sandbox.agents.length > 0 ? (
                        <div style={styles.debugAgentList}>
                          {sandbox.agents.map((agent) => (
                            <div key={agent.id} style={styles.debugAgentRow}>
                              <div>
                                <div style={styles.debugPrimary}>{agent.name}</div>
                                <div style={styles.debugSecondary}>{agent.agent_type} · {agent.model}</div>
                              </div>
                              <div style={styles.debugCounts}>
                                <span style={agent.dismissed ? styles.debugBadgeMuted : styles.debugBadge}>{agent.status}</span>
                                <span style={styles.debugSecondary}>{agent.session_id ? agent.session_id.slice(0, 8) : 'no session'}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div style={styles.debugEmptyRow}>No agents in this sandbox.</div>
                      )}
                    </div>
                  ))}
                </section>

                <section style={styles.debugSection}>
                  <h3 style={styles.debugSectionTitle}>Unassigned Agents</h3>
                  {(sandboxDebug?.unassigned_agents ?? []).length > 0 ? (
                    <div style={styles.debugCard}>
                      {(sandboxDebug?.unassigned_agents ?? []).map((agent) => (
                        <div key={agent.id} style={styles.debugAgentRow}>
                          <div>
                            <div style={styles.debugPrimary}>{agent.name}</div>
                            <div style={styles.debugSecondary}>{agent.agent_type} · {agent.model}</div>
                          </div>
                          <div style={styles.debugCounts}>
                            <span style={agent.dismissed ? styles.debugBadgeMuted : styles.debugBadge}>{agent.status}</span>
                            <span style={styles.debugSecondary}>{agent.dismissed ? 'dismissed' : 'no sandbox'}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={styles.debugEmptyRow}>No unassigned agents.</div>
                  )}
                </section>
              </div>
            </div>
          )}
        </div>

        {/* Drag handle */}
        {id && (
          <div
            onMouseDown={handleGraphDragStart}
            style={{
              width: 5,
              flexShrink: 0,
              cursor: 'col-resize',
              background: 'var(--border)',
              transition: 'background 0.15s',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'var(--border)')}
          />
        )}

        {/* Graph editor panel */}
        {id && (
          <ErrorBoundary resetKey={id}>
            <GraphPanel
              workspaceId={id}
              width={graphWidth}
              onRunsChanged={() => setWorkspaceEventsVersion((value) => value + 1)}
            />
          </ErrorBoundary>
        )}
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    maxWidth: '100%',
    overflow: 'hidden',
    background: 'var(--bg)',
    color: 'var(--text)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '10px 16px',
    background: 'var(--surface)',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0,
  },
  back: {
    color: 'var(--text-dim)',
    textDecoration: 'none',
    fontSize: '13px',
  },
  headerSep: { color: 'var(--border)', fontSize: '13px' },
  title: { fontWeight: 600, fontSize: '14px', color: 'var(--text)' },
  errorBanner: {
    padding: '10px 16px',
    background: 'rgba(249, 112, 102, 0.12)',
    borderBottom: '1px solid rgba(249, 112, 102, 0.32)',
    color: '#fda29b',
    fontSize: '13px',
    flexShrink: 0,
  },
  reconnectBanner: {
    padding: '8px 16px',
    background: 'rgba(251, 191, 36, 0.12)',
    borderBottom: '1px solid rgba(251, 191, 36, 0.32)',
    color: '#fbbf24',
    fontSize: '13px',
    flexShrink: 0,
  },
  body: { display: 'flex', flex: 1, overflow: 'hidden' },

  // Sidebar
  sidebar: {
    width: '240px',
    flexShrink: 0,
    background: 'var(--surface)',
    borderRight: '1px solid var(--border)',
    display: 'flex',
    flexDirection: 'column',
    padding: '12px 8px',
    overflowY: 'auto',
    gap: '4px',
  },
  sidebarHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 6px',
    marginBottom: '4px',
  },
  sidebarLabel: {
    color: 'var(--text-muted)',
    fontSize: '11px',
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.08em',
  },
  sidebarDismissedToggle: {
    display: 'flex',
    alignItems: 'center',
    fontSize: '11px',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    gap: '3px',
  },
  newAgentBtn: {
    width: '100%',
    padding: '6px 10px',
    background: 'transparent',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '13px',
    textAlign: 'left',
    marginBottom: '4px',
  },
  form: { display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '8px' },
  formRow: { display: 'flex', flexDirection: 'column', gap: '3px' },
  label: { fontSize: '11px', color: 'var(--text-muted)', display: 'block' },
  select: {
    width: '100%',
    padding: '5px 8px',
    background: 'var(--surface-2)',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    color: 'var(--text)',
    outline: 'none',
    fontSize: '13px',
    display: 'block',
  },
  input: {
    width: '100%',
    padding: '5px 8px',
    background: 'var(--surface-2)',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    color: 'var(--text)',
    outline: 'none',
    fontSize: '13px',
    display: 'block',
  },
  textarea: {
    width: '100%',
    padding: '5px 8px',
    background: 'var(--surface-2)',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    color: 'var(--text)',
    resize: 'vertical',
    outline: 'none',
    fontSize: '13px',
    display: 'block',
  },
  submitBtn: {
    width: '100%',
    padding: '7px',
    background: 'var(--accent)',
    color: '#fff',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '13px',
    fontWeight: 500,
  },
  agentList: { flex: 1, display: 'flex', flexDirection: 'column', gap: '2px' },
  runGroupHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '4px 6px',
    marginTop: '8px',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    color: 'var(--text-muted)',
    fontSize: '11px',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    width: '100%',
    textAlign: 'left',
  },
  runGroupLabel: { flex: 1 },

  // Main
  main: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    background: 'var(--bg)',
  },
  tabBar: {
    display: 'flex',
    gap: '8px',
    padding: '10px 16px 8px',
    borderBottom: '1px solid var(--border)',
    background: 'var(--surface)',
    flexShrink: 0,
  },
  tabButton: {
    padding: '6px 10px',
    background: 'transparent',
    border: '1px solid var(--border)',
    borderRadius: '999px',
    color: 'var(--text-muted)',
    fontSize: '12px',
    cursor: 'pointer',
  },
  tabButtonActive: {
    background: 'rgba(196, 169, 107, 0.14)',
    borderColor: 'rgba(196, 169, 107, 0.34)',
    color: 'var(--text)',
  },
  filterBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '6px 20px',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0,
  },
  filterLabel: {
    display: 'flex',
    alignItems: 'center',
    fontSize: '12px',
    color: 'var(--text-muted)',
    cursor: 'pointer',
  },
  feed: {
    flex: 1,
    overflowY: 'auto',
    padding: '16px 20px',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  empty: {
    color: 'var(--text-muted)',
    textAlign: 'center',
    marginTop: '3rem',
  },

  // User message bubble (right-aligned, same shape as agent bubbles)
  userBubbleWrap: { display: 'flex', justifyContent: 'flex-end' },
  userBubble: {
    maxWidth: '85%',
    padding: '8px 12px',
    background: 'var(--surface)',
    borderLeft: '3px solid var(--user-color)',
    borderRadius: '3px',
    wordBreak: 'break-word',
    fontSize: '14px',
  },
  userBubbleHeader: {
    fontSize: '11px',
    fontWeight: 600,
    color: 'var(--user-color)',
    marginBottom: '2px',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  dispatchBadge: {
    fontSize: '9px',
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    color: 'var(--user-color)',
    background: 'rgba(196, 169, 107, 0.18)',
    padding: '1px 5px',
    borderRadius: '2px',
    opacity: 1,
  },

  // Agent message bubble (left-aligned)
  agentBubbleWrap: { display: 'flex', justifyContent: 'flex-start' },
  agentBubble: {
    maxWidth: '85%',
    padding: '8px 12px',
    background: 'var(--surface)',
    borderRadius: '3px',
    wordBreak: 'break-word',
    fontSize: '14px',
  },
  agentBubbleHeader: {
    fontSize: '11px',
    fontWeight: 600,
    marginBottom: '2px',
  },

  // Activity block
  activityWrap: { display: 'flex', flexDirection: 'column' },
  activityRow: { display: 'flex', alignItems: 'center', gap: '6px' },
  chevron: {
    background: 'none',
    border: 'none',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    padding: '0',
    flexShrink: 0,
    fontSize: '14px',
    lineHeight: 1,
  },
  activityPrefix: { color: 'var(--text-dim)', fontSize: '12px', flexShrink: 0 },
  activityLatest: { color: 'var(--text-muted)', fontSize: '13px' },
  historyList: { paddingLeft: '20px', display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '4px' },
  historyItem: { display: 'flex', gap: '4px', alignItems: 'flex-start' },

  // Status bar
  statusBar: {
    background: 'var(--surface)',
    borderTop: '1px solid var(--border)',
    padding: '6px 20px',
    display: 'flex',
    gap: '16px',
    flexShrink: 0,
    flexWrap: 'wrap',
  },
  statusItem: { display: 'inline-flex', alignItems: 'baseline', gap: '4px' },
  statusName: { color: 'var(--text-dim)', fontSize: '12px' },
  statusDots: { color: 'var(--text)', letterSpacing: '2px', fontSize: '12px' },
  statusDotsIdle: { color: 'var(--text-muted)', letterSpacing: '2px', fontSize: '12px' },
  statusWaiting: { color: '#e0a855', fontSize: '12px', fontStyle: 'italic' },

  debugPane: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  debugHeader: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: '12px',
    padding: '16px 20px 12px',
    borderBottom: '1px solid var(--border)',
    background: 'var(--bg)',
    flexShrink: 0,
  },
  debugSummaryGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(100px, 1fr))',
    gap: '10px',
    flex: 1,
  },
  debugMetricCard: {
    padding: '10px 12px',
    border: '1px solid var(--border)',
    borderRadius: '6px',
    background: 'var(--surface)',
  },
  debugMetricValue: {
    fontSize: '20px',
    fontWeight: 700,
    color: 'var(--text)',
    lineHeight: 1.1,
  },
  debugMetricLabel: {
    marginTop: '4px',
    fontSize: '11px',
    color: 'var(--text-muted)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
  },
  refreshButton: {
    padding: '7px 10px',
    border: '1px solid var(--border)',
    borderRadius: '6px',
    background: 'var(--surface)',
    color: 'var(--text)',
    cursor: 'pointer',
    flexShrink: 0,
  },
  debugScroll: {
    flex: 1,
    overflowY: 'auto',
    padding: '16px 20px',
    display: 'flex',
    flexDirection: 'column',
    gap: '18px',
  },
  debugSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  debugSectionTitle: {
    margin: 0,
    fontSize: '12px',
    color: 'var(--text-muted)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.08em',
  },
  debugTable: {
    display: 'flex',
    flexDirection: 'column',
    border: '1px solid var(--border)',
    borderRadius: '8px',
    overflow: 'hidden',
    background: 'var(--surface)',
  },
  debugTableHeader: {
    display: 'grid',
    gridTemplateColumns: '2.2fr 1fr 1.3fr 1fr 1.6fr',
    gap: '12px',
    padding: '10px 12px',
    background: 'var(--surface-2)',
    color: 'var(--text-muted)',
    fontSize: '11px',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
  },
  debugTableRow: {
    display: 'grid',
    gridTemplateColumns: '2.2fr 1fr 1.3fr 1fr 1.6fr',
    gap: '12px',
    padding: '12px',
    borderTop: '1px solid var(--border)',
    alignItems: 'center',
  },
  debugCard: {
    border: '1px solid var(--border)',
    borderRadius: '8px',
    background: 'var(--surface)',
    overflow: 'hidden',
  },
  debugCardHeader: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: '12px',
    padding: '12px',
    borderBottom: '1px solid var(--border)',
  },
  debugPrimary: {
    fontSize: '13px',
    color: 'var(--text)',
    fontWeight: 600,
  },
  debugSecondary: {
    fontSize: '12px',
    color: 'var(--text-muted)',
    wordBreak: 'break-all',
  },
  debugCounts: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
  },
  debugBadge: {
    padding: '3px 7px',
    borderRadius: '999px',
    background: 'rgba(196, 169, 107, 0.14)',
    color: 'var(--text)',
    fontSize: '11px',
    fontWeight: 600,
  },
  debugBadgeMuted: {
    padding: '3px 7px',
    borderRadius: '999px',
    background: 'rgba(148, 163, 184, 0.16)',
    color: 'var(--text-muted)',
    fontSize: '11px',
    fontWeight: 600,
  },
  debugAgentList: {
    display: 'flex',
    flexDirection: 'column',
  },
  debugAgentRow: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '12px',
    padding: '10px 12px',
    borderTop: '1px solid var(--border)',
    alignItems: 'center',
  },
  debugEmptyRow: {
    padding: '12px',
    color: 'var(--text-muted)',
    fontSize: '13px',
    border: '1px dashed var(--border)',
    borderRadius: '8px',
    background: 'var(--surface)',
  },

  // Input bar
  inputBar: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: '8px',
    padding: '10px 16px',
    background: 'var(--surface)',
    borderTop: '1px solid var(--border)',
    flexShrink: 0,
  },
  targetSelect: {
    padding: '7px 8px',
    background: 'var(--surface-2)',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    color: 'var(--text)',
    flexShrink: 0,
    maxWidth: '160px',
    outline: 'none',
    fontSize: '13px',
  },
  chatInput: {
    flex: 1,
    padding: '7px 12px',
    background: 'var(--surface-2)',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    color: 'var(--text)',
    outline: 'none',
    fontSize: '14px',
    resize: 'none' as const,
    lineHeight: '1.4',
    fontFamily: 'inherit',
  },
  sendBtn: {
    padding: '7px 16px',
    background: 'var(--accent)',
    color: '#fff',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    flexShrink: 0,
    fontSize: '14px',
    fontWeight: 500,
  },
}
