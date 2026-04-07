import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import {
  TERMINAL_STATUSES,
  type Agent,
  type AgentEvent,
  createAgent,
  deleteAgent,
  listAgents,
  sendFeedback,
  sendMessage,
} from '../api/agents'
import {
  DEFAULT_MODEL_BY_AGENT_TYPE,
  PYDANTIC_SCHEMA_OPTIONS,
  SUPPORTED_MODELS_BY_AGENT_TYPE,
  type AgentType,
  type PydanticSchemaId,
} from '../api/models'
import { listWorkspaceEvents, streamWorkspaceEvents } from '../api/workspaceEvents'
import { getWorkspace, type Workspace } from '../api/workspaces'
import AgentCard from '../components/AgentCard'
import FeedbackRequest from '../components/FeedbackRequest'
import GraphPanel from '../components/GraphPanel'
import {
  WORKSPACE_DETAIL_PARAM_KEYS,
  mergeSearchParams,
  readBooleanParam,
} from '../components/workspaceDetailSearchParams'

// ─── Feed item types ────────────────────────────────────────────────────────

interface ActivityBlock {
  blockId: string
  streamKey: string
  latest: AgentEvent
  history: AgentEvent[]
}

type FeedItem =
  | { kind: 'message'; agentId: string; event: AgentEvent; key: string }
  | { kind: 'user'; agentId: string; prompt: string; timestamp: string; key: string }
  | { kind: 'activity'; block: ActivityBlock }
  | { kind: 'feedback'; agentId: string; event: AgentEvent; key: string; resolved: boolean; resolvedResponse?: string }

const ACTIVITY_TYPES = new Set(['tool.use', 'file.edit', 'command.output'])

function isActivity(type: string): boolean {
  return ACTIVITY_TYPES.has(type)
}

function mergeDeltaText(previous: string, incoming: string): string {
  if (!incoming) return previous
  if (!previous) return incoming
  if (incoming === previous) return previous
  if (incoming.startsWith(previous)) return incoming
  if (previous.endsWith(incoming)) return previous

  const maxOverlap = Math.min(previous.length, incoming.length)
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (previous.endsWith(incoming.slice(0, size))) {
      return previous + incoming.slice(size)
    }
  }

  return previous + incoming
}

// ─── Event rendering ─────────────────────────────────────────────────────────

function renderActivityEvent(event: AgentEvent): string {
  switch (event.type) {
    case 'file.edit':
      return `✎ ${String(event.data.path ?? 'file')}`
    case 'tool.use':
      return `⚙ ${String(event.data.tool ?? 'tool')}`
    case 'command.output': {
      const out = String(event.data.stdout ?? '').trim()
      const err = String(event.data.stderr ?? '').trim()
      const preview = (out || err).slice(0, 80)
      return `$ ${preview}`
    }
    default:
      return event.type
  }
}

function renderActivityHistory(event: AgentEvent): React.ReactNode {
  switch (event.type) {
    case 'file.edit':
      return <span style={hist.accent}>✎ {String(event.data.path ?? 'file')}</span>
    case 'tool.use':
      return <span style={hist.accent}>⚙ {String(event.data.tool ?? 'tool')}</span>
    case 'command.output':
      return (
        <pre style={hist.pre}>
          {String(event.data.stdout ?? '')}
          {event.data.stderr ? `\n[stderr]\n${String(event.data.stderr)}` : ''}
        </pre>
      )
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
}: {
  block: ActivityBlock
  expanded: boolean
  onToggle: () => void
  sourceLabel: string
}) {
  return (
    <div style={styles.activityWrap}>
      <div style={styles.activityRow}>
        <button style={styles.chevron} onClick={onToggle} title="Toggle history">
          {expanded ? '∨' : '›'}
        </button>
        <span style={styles.activityPrefix}>{sourceLabel}</span>
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
  const [searchParams, setSearchParams] = useSearchParams()
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [agents, setAgents] = useState<Agent[]>([])
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [eventMap, setEventMap] = useState<Record<string, AgentEvent[]>>({})
  const [agentBusy, setAgentBusy] = useState<Record<string, boolean>>({})
  const [agentTerminal, setAgentTerminal] = useState<Record<string, boolean>>({})
  const [expandedBlocks, setExpandedBlocks] = useState<Set<string>>(new Set())
  const [showForm, setShowForm] = useState(false)
  const [formAgentType, setFormAgentType] = useState<AgentType>('opencode')
  const [formModel, setFormModel] = useState(DEFAULT_MODEL_BY_AGENT_TYPE.opencode)
  const [formSchemaId, setFormSchemaId] = useState<PydanticSchemaId>('structured_response_v1')
  const [formPrompt, setFormPrompt] = useState('')
  const [formName, setFormName] = useState('')
  const [formGraphTools, setFormGraphTools] = useState(false)
  const [creating, setCreating] = useState(false)
  const [chatInput, setChatInput] = useState('')
  const [targetAgentId, setTargetAgentId] = useState<string>('new')
  const [userMessages, setUserMessages] = useState<
    { agentId: string; prompt: string; timestamp: string }[]
  >(() => {
    try {
      const stored = localStorage.getItem(`user-messages-${id}`)
      return stored ? JSON.parse(stored) : []
    } catch {
      return []
    }
  })
  const feedBottomRef = useRef<HTMLDivElement>(null)
  const workspaceStreamController = useRef<AbortController | null>(null)
  const seenEventIds = useRef<Set<string>>(new Set())
  const eventCursor = useRef(0)
  const showDeadMessages = readBooleanParam(
    searchParams,
    WORKSPACE_DETAIL_PARAM_KEYS.showDeadMessages,
    true,
  )
  const [collapsedRuns, setCollapsedRuns] = useState<Set<string>>(new Set())
  const [agentWaiting, setAgentWaiting] = useState<Record<string, boolean>>({})
  const [resolvedFeedback, setResolvedFeedback] = useState<Record<string, string>>({})
  const [graphWidth, setGraphWidth] = useState(340)
  const isDragging = useRef(false)
  const dragStartX = useRef(0)
  const dragStartWidth = useRef(0)

  // ── Data loading ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (!id) return
    Promise.all([getWorkspace(id), listAgents(id)]).then(([ws, agts]) => {
      setWorkspace(ws)
      setAgents(agts)
    })
  }, [id])

  // ── SSE connection management ─────────────────────────────────────────────

  useEffect(() => {
    if (!id) return

      const applyEvent = (event: AgentEvent) => {
      const streamKey = event.stream_key ?? event.agent_id ?? event.node_id ?? event.run_id ?? event.source_id ?? 'unknown'
      const agentId = event.agent_id ?? null
      eventCursor.current += 1
      if (!event.type.startsWith('session.')) {
        if (!seenEventIds.current.has(event.id)) {
          seenEventIds.current.add(event.id)
          setEventMap((prev) => ({
            ...prev,
            [streamKey]: [...(prev[streamKey] ?? []), event],
          }))
        }
      }
      if (agentId && event.type === 'session.busy') {
        setAgentBusy((prev) => ({ ...prev, [agentId]: true }))
        setAgentWaiting((prev) => ({ ...prev, [agentId]: false }))
      } else if (agentId && event.type === 'session.idle') {
        setAgentBusy((prev) => ({ ...prev, [agentId]: false }))
      } else if (
        agentId &&
        (
          event.type === 'session.completed' ||
          event.type === 'session.error' ||
          event.type === 'session.interrupted'
        )
      ) {
        setAgentBusy((prev) => ({ ...prev, [agentId]: false }))
        setAgentWaiting((prev) => ({ ...prev, [agentId]: false }))
        setAgentTerminal((prev) => ({ ...prev, [agentId]: true }))
      }
      if (agentId && event.type === 'feedback.request') {
        setAgentBusy((prev) => ({ ...prev, [agentId]: false }))
        setAgentWaiting((prev) => ({ ...prev, [agentId]: true }))
      } else if (agentId && event.type === 'feedback.response') {
        const fbId = String(event.data?.feedback_id ?? '')
        const fbResp = String(event.data?.response ?? '')
        if (fbId) setResolvedFeedback((prev) => ({ ...prev, [fbId]: fbResp }))
        setAgentWaiting((prev) => ({ ...prev, [agentId]: false }))
      }
    }

    const ctrl = new AbortController()
    workspaceStreamController.current = ctrl
    ;(async () => {
      const events = await listWorkspaceEvents(id, 0, 1000)
      const nextMap: Record<string, AgentEvent[]> = {}
      const nextTerminal: Record<string, boolean> = {}
      const nextBusy: Record<string, boolean> = {}
      const nextWaiting: Record<string, boolean> = {}
      const nextResolved: Record<string, string> = {}
      eventCursor.current = 0
      for (const event of events) {
        eventCursor.current += 1
        const streamKey = event.stream_key ?? event.agent_id ?? event.node_id ?? event.run_id ?? event.source_id ?? 'unknown'
        const agentId = event.agent_id ?? null
        if (!event.type.startsWith('session.')) {
          seenEventIds.current.add(event.id)
          nextMap[streamKey] = [...(nextMap[streamKey] ?? []), event]
        }
        if (agentId && event.type === 'session.busy') {
          nextBusy[agentId] = true
          nextWaiting[agentId] = false
        }
        if (agentId && event.type === 'session.idle') nextBusy[agentId] = false
        if (
          agentId &&
          (
            event.type === 'session.completed' ||
            event.type === 'session.error' ||
            event.type === 'session.interrupted'
          )
        ) {
          nextBusy[agentId] = false
          nextTerminal[agentId] = true
          nextWaiting[agentId] = false
        }
        if (agentId && event.type === 'feedback.request') {
          nextBusy[agentId] = false
          nextWaiting[agentId] = true
        } else if (agentId && event.type === 'feedback.response') {
          const fbId = String(event.data?.feedback_id ?? '')
          const fbResp = String(event.data?.response ?? '')
          if (fbId) nextResolved[fbId] = fbResp
          nextWaiting[agentId] = false
        }
      }
      setEventMap(nextMap)
      setAgentBusy((prev) => ({ ...prev, ...nextBusy }))
      setAgentTerminal((prev) => ({ ...prev, ...nextTerminal }))
      setAgentWaiting((prev) => ({ ...prev, ...nextWaiting }))
      setResolvedFeedback((prev) => ({ ...prev, ...nextResolved }))
      await streamWorkspaceEvents(id, eventCursor.current, applyEvent, ctrl.signal)
    })().catch(() => {})
    return () => ctrl.abort()
  }, [id])

  useEffect(() => {
    return () => workspaceStreamController.current?.abort()
  }, [])

  useEffect(() => {
    if (id) localStorage.setItem(`user-messages-${id}`, JSON.stringify(userMessages))
  }, [id, userMessages])

  useEffect(() => {
    const current = searchParams.get(WORKSPACE_DETAIL_PARAM_KEYS.showDeadMessages)
    const next = showDeadMessages ? '1' : '0'
    if (current === next) return
    setSearchParams(
      (prev) =>
        mergeSearchParams(prev, {
          [WORKSPACE_DETAIL_PARAM_KEYS.showDeadMessages]: next,
        }),
      { replace: true },
    )
  }, [searchParams, setSearchParams, showDeadMessages])

  useEffect(() => {
    feedBottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [eventMap, userMessages])

  // ── Feed building ─────────────────────────────────────────────────────────

  // Dead agent IDs for filter (must be before `feed` which depends on it)
  const deadAgentIds = useMemo(() => {
    const ids = new Set<string>()
    for (const agent of agents) {
      if (TERMINAL_STATUSES.includes(agent.status)) ids.add(agent.id)
    }
    // Agents that were deleted but still have events
    for (const sourceId of Object.keys(eventMap)) {
      if (!agents.find((a) => a.id === sourceId)) ids.add(sourceId)
    }
    return ids
  }, [agents, eventMap])

  const feed = useMemo((): FeedItem[] => {
    const allRaw: { event: AgentEvent; streamKey: string }[] = []
    for (const [streamKey, evts] of Object.entries(eventMap)) {
      for (const ev of evts) allRaw.push({ event: ev, streamKey })
    }
    for (const msg of userMessages) {
      allRaw.push({
        streamKey: `agent:${msg.agentId}`,
        event: {
          id: `user-${msg.timestamp}`,
          session_id: '',
          type: 'user.message',
          timestamp: msg.timestamp,
          data: { prompt: msg.prompt },
        },
      })
    }
    allRaw.sort((a, b) => a.event.timestamp.localeCompare(b.event.timestamp))

    const items: FeedItem[] = []
    const textBuffers: Record<
      string,
      {
        idx: number
        partOrder: string[]
        partText: Record<string, string>
      }
    > = {}
    const activityIdx: Record<string, number> = {}

    for (const { event, streamKey } of allRaw) {
      const agentId = event.agent_id ?? (streamKey.startsWith('agent:') ? streamKey.slice('agent:'.length) : null)
      if (!showDeadMessages && agentId && deadAgentIds.has(agentId)) continue
      if (event.type === 'text.delta') {
        const key = String(event.data.message_id ?? event.data.session_id ?? agentId)
        const partKey = String(event.data.part_id ?? event.id)
        const chunk = String(event.data.delta ?? '')
        if (textBuffers[key] !== undefined) {
          const buffer = textBuffers[key]
          if (!(partKey in buffer.partText)) buffer.partOrder.push(partKey)
          buffer.partText[partKey] = mergeDeltaText(buffer.partText[partKey] ?? '', chunk)
          const accumulated = buffer.partOrder.map((id) => buffer.partText[id] ?? '').join('')
          const item = items[buffer.idx] as Extract<FeedItem, { kind: 'message' }>
          item.event = {
            ...item.event,
            data: { ...item.event.data, accumulated },
          }
        } else {
          textBuffers[key] = {
            idx: items.length,
            partOrder: [partKey],
            partText: { [partKey]: chunk },
          }
          items.push({
            kind: 'message',
            agentId: agentId ?? 'unknown',
            key: event.id,
            event: { ...event, data: { ...event.data, accumulated: chunk } },
          })
          delete activityIdx[streamKey]
        }
      } else if (event.type === 'text.complete') {
        const key = String(event.data.message_id ?? event.data.session_id ?? agentId)
        delete textBuffers[key]
      } else if (event.type === 'user.message') {
        items.push({
          kind: 'user',
          agentId: agentId ?? 'unknown',
          key: event.id,
          prompt: String(event.data.prompt ?? ''),
          timestamp: event.timestamp,
        })
        delete activityIdx[streamKey]
      } else if (event.type === 'feedback.request') {
        const fbId = String(event.data.feedback_id ?? '')
        items.push({
          kind: 'feedback',
          agentId: agentId ?? 'unknown',
          key: event.id,
          event,
          resolved: fbId in resolvedFeedback,
          resolvedResponse: resolvedFeedback[fbId],
        })
        delete activityIdx[streamKey]
      } else if (event.type === 'feedback.response') {
        // audit-only, skip rendering
      } else if (isActivity(event.type)) {
        const idx = activityIdx[streamKey]
        if (idx !== undefined) {
          const item = items[idx] as Extract<FeedItem, { kind: 'activity' }>
          item.block = {
            ...item.block,
            latest: event,
            history: [...item.block.history, event],
          }
        } else {
          const blockId = `act-${streamKey}-${event.id}`
          activityIdx[streamKey] = items.length
          items.push({
            kind: 'activity',
            block: { blockId, streamKey, latest: event, history: [event] },
          })
        }
      }
    }

    return items
  }, [eventMap, userMessages, showDeadMessages, deadAgentIds, resolvedFeedback])

  // ── Helpers ───────────────────────────────────────────────────────────────

  function agentName(agentId: string): string {
    const a = agents.find((x) => x.id === agentId)
    if (!a) return 'agent'
    return a.name ?? `${a.agent_type}/${a.model.split('/')[1]}`
  }

  function eventLabel(event: AgentEvent, fallbackId?: string): string {
    if (event.display_label) return `${event.display_label}:`
    if (event.agent_id) return `${agentName(event.agent_id)}:`
    if (fallbackId) return `${agentName(fallbackId)}:`
    return 'event:'
  }

  // Partition agents into ad-hoc and run-grouped
  const adHocAgents = useMemo(() => agents.filter((a) => !a.graph_run_id), [agents])
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
  ) {
    if (!id || !prompt.trim()) return
    setCreating(true)
    try {
      const agent = await createAgent(
        id,
        agentType === 'pydantic'
          ? {
              agent_type: 'pydantic',
              model,
              prompt: prompt.trim(),
              name: name.trim() || undefined,
              schema_id: schemaId,
            }
          : {
              agent_type: 'opencode',
              model,
              prompt: prompt.trim(),
              name: name.trim() || undefined,
              graph_tools: graphTools || undefined,
            },
      )
      setAgents((prev) => [...prev, agent])
      setSelectedAgentId(agent.id)
      setShowForm(false)
      setFormPrompt('')
      setFormName('')
      setFormGraphTools(false)
      setFormAgentType('opencode')
      setFormModel(DEFAULT_MODEL_BY_AGENT_TYPE.opencode)
      setFormSchemaId('structured_response_v1')
    } finally {
      setCreating(false)
    }
  }

  async function handleChatSend() {
    if (!id || !chatInput.trim()) return
    setCreating(true)
    try {
      if (targetAgentId === 'new') {
        await handleCreateAgent(chatInput.trim(), DEFAULT_MODEL_BY_AGENT_TYPE.opencode, '')
      } else {
        setUserMessages((prev) => [
          ...prev,
          { agentId: targetAgentId, prompt: chatInput.trim(), timestamp: new Date().toISOString() },
        ])
        await sendMessage(id, targetAgentId, chatInput.trim())
        setAgentTerminal((prev) => ({ ...prev, [targetAgentId]: false }))
      }
      setChatInput('')
    } finally {
      setCreating(false)
    }
  }

  const workspaceName = workspace?.name ?? '…'

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

      {/* Body */}
      <div style={styles.body}>
        {/* Sidebar */}
        <div style={styles.sidebar}>
          <div style={styles.sidebarLabel}>Agents</div>

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
                  }}
                >
                  <option value="opencode">OpenCode</option>
                  <option value="pydantic">Pydantic</option>
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
                  id="agent-prompt-input"
                  style={styles.textarea}
                  value={formPrompt}
                  onChange={(e) => setFormPrompt(e.target.value)}
                  placeholder="What should this agent do?"
                  rows={4}
                />
              </div>
              {formAgentType === 'opencode' && (
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
                onClick={() => handleCreateAgent(formPrompt, formModel, formName, formGraphTools, formAgentType, formSchemaId)}
              >
                {creating ? 'Dispatching…' : 'Dispatch'}
              </button>
            </div>
          )}

          <div style={styles.agentList}>
            {adHocAgents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                selected={selectedAgentId === agent.id}
                isRunning={!agentTerminal[agent.id]}
                onClick={() => setSelectedAgentId(agent.id)}
                onDelete={async () => {
                  if (!id) return
                  await deleteAgent(id, agent.id)
                  setAgents((prev) => prev.filter((a) => a.id !== agent.id))
                  setEventMap((prev) => {
                    const next = { ...prev }
                    delete next[agent.id]
                    return next
                  })
                  setUserMessages((prev) => prev.filter((m) => m.agentId !== agent.id))
                  if (selectedAgentId === agent.id) setSelectedAgentId(null)
                }}
              />
            ))}

            {Array.from(runAgentGroups.entries()).map(([runId, runAgents]) => (
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
                    onClick={() => setSelectedAgentId(agent.id)}
                    onDelete={async () => {
                      if (!id) return
                      await deleteAgent(id, agent.id)
                      setAgents((prev) => prev.filter((a) => a.id !== agent.id))
                      setEventMap((prev) => {
                        const next = { ...prev }
                        delete next[agent.id]
                        return next
                      })
                      setUserMessages((prev) => prev.filter((m) => m.agentId !== agent.id))
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
              Show completed agent messages
            </label>
          </div>
          <div style={styles.feed}>
            {feed.length === 0 && (
              <div style={styles.empty}>
                No events yet. Dispatch an agent to get started.
              </div>
            )}

            {feed.map((item) => {
              if (item.kind === 'user') {
                return (
                  <div key={item.key} style={styles.userRow}>
                    <span style={styles.userPrefix}>you → {agentName(item.agentId)}:</span>
                    <span style={styles.userText}>{item.prompt}</span>
                  </div>
                )
              }

              if (item.kind === 'message') {
                return (
                  <div key={item.key} style={styles.msgRow}>
                    <span style={styles.msgPrefix}>{agentName(item.agentId)}:</span>
                    <span style={styles.msgText}>
                      {String(item.event.data.accumulated ?? item.event.data.delta ?? '')}
                    </span>
                  </div>
                )
              }

              if (item.kind === 'feedback') {
                return (
                  <FeedbackRequest
                    key={item.key}
                    event={item.event}
                    agentLabel={agentName(item.agentId)}
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
                )
              }

              return (
                <ActivityLine
                  key={item.block.blockId}
                  block={item.block}
                  expanded={expandedBlocks.has(item.block.blockId)}
                  onToggle={() => toggleBlock(item.block.blockId)}
                  sourceLabel={eventLabel(item.block.latest).replace(/:$/, '')}
                />
              )
            })}

            <div ref={feedBottomRef} />
          </div>

          {/* Agent status indicators */}
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

          {/* Input bar */}
          <div style={styles.inputBar}>
            <select
              style={styles.targetSelect}
              value={targetAgentId}
              onChange={(e) => setTargetAgentId(e.target.value)}
            >
              <option value="new">+ New agent</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name ?? `${a.agent_type}/${a.model.split('/')[1]}`}
                </option>
              ))}
            </select>
            <input
              style={styles.chatInput}
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              placeholder={targetAgentId === 'new' ? 'Dispatch a new agent…' : 'Send a message…'}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  handleChatSend()
                }
              }}
            />
            <button
              style={{ ...styles.sendBtn, opacity: creating || !chatInput.trim() ? 0.4 : 1 }}
              disabled={creating || !chatInput.trim()}
              onClick={handleChatSend}
            >
              Send
            </button>
          </div>
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
        {id && <GraphPanel workspaceId={id} width={graphWidth} />}
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
  sidebarLabel: {
    color: 'var(--text-muted)',
    fontSize: '11px',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    padding: '0 6px',
    marginBottom: '4px',
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
    gap: '10px',
  },
  empty: {
    color: 'var(--text-muted)',
    textAlign: 'center',
    marginTop: '3rem',
  },

  // User message row
  userRow: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'baseline' },
  userPrefix: { color: 'var(--user-color)', fontSize: '12px', flexShrink: 0, opacity: 0.8 },
  userText: { color: 'var(--user-color)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },

  // Agent text message row
  msgRow: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'baseline' },
  msgPrefix: { color: 'var(--accent)', fontSize: '12px', fontWeight: 600, flexShrink: 0 },
  msgText: { color: 'var(--text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', flex: 1 },

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

  // Input bar
  inputBar: {
    display: 'flex',
    alignItems: 'center',
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
