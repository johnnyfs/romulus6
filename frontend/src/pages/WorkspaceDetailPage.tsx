import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  ANTHROPIC_MODELS,
  DEFAULT_MODEL,
  OPENAI_MODELS,
  TERMINAL_STATUSES,
  type Agent,
  type AgentEvent,
  createAgent,
  deleteAgent,
  getAgentEvents,
  listAgents,
  sendMessage,
  streamAgentEvents,
} from '../api/agents'
import { getWorkspace, type Workspace } from '../api/workspaces'
import AgentCard from '../components/AgentCard'

// ─── Feed item types ────────────────────────────────────────────────────────

interface ActivityBlock {
  blockId: string
  agentId: string
  latest: AgentEvent
  history: AgentEvent[]
}

type FeedItem =
  | { kind: 'message'; agentId: string; event: AgentEvent; key: string }
  | { kind: 'user'; agentId: string; prompt: string; timestamp: string; key: string }
  | { kind: 'activity'; block: ActivityBlock }

const ACTIVITY_TYPES = new Set(['tool.use', 'file.edit', 'command.output'])

function isActivity(type: string): boolean {
  return ACTIVITY_TYPES.has(type)
}

// ─── Event rendering ─────────────────────────────────────────────────────────

function renderActivityEvent(event: AgentEvent): string {
  switch (event.type) {
    case 'file.edit':
      return `[✎ ${String(event.data.path ?? 'file')}]`
    case 'tool.use':
      return `[⚙ ${String(event.data.tool ?? 'tool')}]`
    case 'command.output': {
      const out = String(event.data.stdout ?? '').trim()
      const err = String(event.data.stderr ?? '').trim()
      const preview = (out || err).slice(0, 80)
      return `[$ ${preview}]`
    }
    default:
      return `[${event.type}]`
  }
}

function renderActivityHistory(event: AgentEvent): React.ReactNode {
  switch (event.type) {
    case 'file.edit':
      return <span style={hist.cyan}>[✎ {String(event.data.path ?? 'file')}]</span>
    case 'tool.use':
      return <span style={hist.cyan}>[⚙ {String(event.data.tool ?? 'tool')}]</span>
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
  cyan: { color: '#55FFFF' },
  dim: { color: '#AAAAAA', fontStyle: 'italic' },
  pre: { margin: '2px 0 0 0', color: '#AAAAAA', whiteSpace: 'pre-wrap', wordBreak: 'break-all' },
}

// ─── Activity block component ─────────────────────────────────────────────────

function ActivityLine({
  block,
  expanded,
  onToggle,
  agentLabel,
}: {
  block: ActivityBlock
  expanded: boolean
  onToggle: () => void
  agentLabel: string
}) {
  return (
    <div style={styles.activityWrap}>
      <div style={styles.activityRow}>
        <button style={styles.chevron} onClick={onToggle} title="Toggle history">
          {expanded ? '▼' : '►'}
        </button>
        <span style={styles.activityPrefix}>{agentLabel} ▶</span>
        <span style={styles.activityLatest}>
          {renderActivityEvent(block.latest)}
        </span>
      </div>
      {expanded && (
        <div style={styles.historyList}>
          {block.history.map((ev) => (
            <div key={ev.id} style={styles.historyItem}>
              <span style={styles.historyBullet}>·</span>
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
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [agents, setAgents] = useState<Agent[]>([])
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [eventMap, setEventMap] = useState<Record<string, AgentEvent[]>>({})
  const [agentBusy, setAgentBusy] = useState<Record<string, boolean>>({})
  const [agentTerminal, setAgentTerminal] = useState<Record<string, boolean>>({})
  const [expandedBlocks, setExpandedBlocks] = useState<Set<string>>(new Set())
  const [showForm, setShowForm] = useState(false)
  const [formModel, setFormModel] = useState(DEFAULT_MODEL)
  const [formPrompt, setFormPrompt] = useState('')
  const [formName, setFormName] = useState('')
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
  const sseControllers = useRef<Map<string, AbortController>>(new Map())

  // ── Data loading ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (!id) return
    Promise.all([getWorkspace(id), listAgents(id)]).then(([ws, agts]) => {
      setWorkspace(ws)
      setAgents(agts)
    })
  }, [id])

  // ── SSE connection management ─────────────────────────────────────────────

  const startSSE = useCallback(
    (agentId: string) => {
      if (!id || sseControllers.current.has(agentId)) return
      const ctrl = new AbortController()
      sseControllers.current.set(agentId, ctrl)

      streamAgentEvents(
        id,
        agentId,
        0,
        (event: AgentEvent) => {
          // Skip session status events from the event map display
          if (!event.type.startsWith('session.')) {
            setEventMap((prev) => ({
              ...prev,
              [agentId]: [...(prev[agentId] ?? []), event],
            }))
          }
          // Track busy / terminal state from session events
          if (event.type === 'session.busy') {
            setAgentBusy((prev) => ({ ...prev, [agentId]: true }))
          } else if (event.type === 'session.idle') {
            setAgentBusy((prev) => ({ ...prev, [agentId]: false }))
          } else if (
            event.type === 'session.completed' ||
            event.type === 'session.error' ||
            event.type === 'session.interrupted'
          ) {
            setAgentBusy((prev) => ({ ...prev, [agentId]: false }))
            setAgentTerminal((prev) => ({ ...prev, [agentId]: true }))
          }
        },
        ctrl.signal,
      ).finally(() => {
        // Stream ended (naturally or via abort) — clear so startSSE can reconnect
        sseControllers.current.delete(agentId)
      })
    },
    [id],
  )

  // Start SSE for terminal agents via REST (load-once), SSE for active agents
  useEffect(() => {
    if (!id || agents.length === 0) return
    for (const agent of agents) {
      if (TERMINAL_STATUSES.includes(agent.status)) {
        if (!eventMap[agent.id]) {
          getAgentEvents(id, agent.id, 0).then((evts) => {
            setEventMap((prev) => ({
              ...prev,
              [agent.id]: evts.filter((e) => !e.type.startsWith('session.')),
            }))
            setAgentTerminal((prev) => ({ ...prev, [agent.id]: true }))
          })
        }
      } else {
        startSSE(agent.id)
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, id])

  // Cleanup SSE connections on unmount
  useEffect(() => {
    return () => {
      for (const ctrl of sseControllers.current.values()) ctrl.abort()
    }
  }, [])

  // Persist user messages to localStorage
  useEffect(() => {
    if (id) localStorage.setItem(`user-messages-${id}`, JSON.stringify(userMessages))
  }, [id, userMessages])

  // Auto-scroll feed
  useEffect(() => {
    feedBottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [eventMap, userMessages])

  // ── Feed building ─────────────────────────────────────────────────────────

  const feed = useMemo((): FeedItem[] => {
    // Collect all events from all agents + user messages
    const allRaw: { event: AgentEvent; agentId: string }[] = []
    for (const [agentId, evts] of Object.entries(eventMap)) {
      for (const ev of evts) allRaw.push({ event: ev, agentId })
    }
    for (const msg of userMessages) {
      allRaw.push({
        agentId: msg.agentId,
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
    // Track current open text buffer per message_id
    const textBuffers: Record<string, { idx: number; text: string }> = {}
    // Track index of the most recent activity block per agent
    const activityIdx: Record<string, number> = {}

    for (const { event, agentId } of allRaw) {
      if (event.type === 'text.delta') {
        const key = String(event.data.message_id ?? event.data.session_id ?? agentId)
        const chunk = String(event.data.delta ?? '')
        if (textBuffers[key] !== undefined) {
          textBuffers[key].text += chunk
          const item = items[textBuffers[key].idx] as Extract<FeedItem, { kind: 'message' }>
          item.event = {
            ...item.event,
            data: { ...item.event.data, accumulated: textBuffers[key].text },
          }
        } else {
          textBuffers[key] = { idx: items.length, text: chunk }
          items.push({
            kind: 'message',
            agentId,
            key: event.id,
            event: { ...event, data: { ...event.data, accumulated: chunk } },
          })
          delete activityIdx[agentId]
        }
      } else if (event.type === 'text.complete') {
        const key = String(event.data.message_id ?? event.data.session_id ?? agentId)
        delete textBuffers[key]
      } else if (event.type === 'user.message') {
        items.push({
          kind: 'user',
          agentId,
          key: event.id,
          prompt: String(event.data.prompt ?? ''),
          timestamp: event.timestamp,
        })
        delete activityIdx[agentId]
      } else if (isActivity(event.type)) {
        const idx = activityIdx[agentId]
        if (idx !== undefined) {
          // Update existing block in-place
          const item = items[idx] as Extract<FeedItem, { kind: 'activity' }>
          item.block = {
            ...item.block,
            latest: event,
            history: [...item.block.history, event],
          }
        } else {
          // Create new activity block; blockId is stable (keyed to first event)
          const blockId = `act-${agentId}-${event.id}`
          activityIdx[agentId] = items.length
          items.push({
            kind: 'activity',
            block: { blockId, agentId, latest: event, history: [event] },
          })
        }
      }
      // session.* events: already excluded from eventMap, skip
    }

    return items
  }, [eventMap, userMessages])

  // ── Helpers ───────────────────────────────────────────────────────────────

  function agentName(agentId: string): string {
    const a = agents.find((x) => x.id === agentId)
    if (!a) return 'agent'
    return a.name ?? `${a.agent_type}/${a.model.split('/')[1]}`
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

  async function handleCreateAgent(prompt: string, model: string, name: string) {
    if (!id || !prompt.trim()) return
    setCreating(true)
    try {
      const agent = await createAgent(id, {
        type: 'opencode',
        model,
        prompt: prompt.trim(),
        name: name.trim() || undefined,
      })
      setAgents((prev) => [...prev, agent])
      setSelectedAgentId(agent.id)
      setShowForm(false)
      setFormPrompt('')
      setFormName('')
      // Start SSE immediately for new agent
      startSSE(agent.id)
    } finally {
      setCreating(false)
    }
  }

  async function handleChatSend() {
    if (!id || !chatInput.trim()) return
    setCreating(true)
    try {
      if (targetAgentId === 'new') {
        await handleCreateAgent(chatInput.trim(), DEFAULT_MODEL, '')
      } else {
        setUserMessages((prev) => [
          ...prev,
          { agentId: targetAgentId, prompt: chatInput.trim(), timestamp: new Date().toISOString() },
        ])
        await sendMessage(id, targetAgentId, chatInput.trim())
        // Agent will start a new session turn — clear terminal flag and reconnect SSE
        setAgentTerminal((prev) => ({ ...prev, [targetAgentId]: false }))
        startSSE(targetAgentId)
      }
      setChatInput('')
    } finally {
      setCreating(false)
    }
  }

  const workspaceName = workspace?.name ?? '…'

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={styles.page}>
      {/* Header / menu bar */}
      <div style={styles.header}>
        <Link to="/workspaces" style={styles.back}>[ ← Back ]</Link>
        <span style={styles.headerSep}>══</span>
        <span style={styles.title}>{workspaceName.toUpperCase()}</span>
        <span style={styles.headerFill}>{'═'.repeat(40)}</span>
      </div>

      {/* Body */}
      <div style={styles.body}>
        {/* Sidebar */}
        <div style={styles.sidebar}>
          <div style={styles.sidebarTitle}>AGENTS</div>

          <button style={styles.newAgentBtn} onClick={() => setShowForm((v) => !v)}>
            {showForm ? '[ ▲ Close Form ]' : '[ + New Agent  ]'}
          </button>

          {showForm && (
            <div style={styles.form}>
              <div style={styles.formRow}>
                <label style={styles.label}>Model:</label>
                <select
                  style={styles.select}
                  value={formModel}
                  onChange={(e) => setFormModel(e.target.value)}
                >
                  <optgroup label="── Anthropic ──">
                    {ANTHROPIC_MODELS.map((m) => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </optgroup>
                  <optgroup label="── OpenAI ──">
                    {OPENAI_MODELS.map((m) => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </optgroup>
                </select>
              </div>
              <div style={styles.formRow}>
                <label style={styles.label}>Name (opt):</label>
                <input
                  style={styles.input}
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="agent name"
                />
              </div>
              <div style={styles.formRow}>
                <label style={styles.label}>Prompt:</label>
                <textarea
                  style={styles.textarea}
                  value={formPrompt}
                  onChange={(e) => setFormPrompt(e.target.value)}
                  placeholder="What should this agent do?"
                  rows={4}
                />
              </div>
              <button
                style={{ ...styles.submitBtn, opacity: creating || !formPrompt.trim() ? 0.5 : 1 }}
                disabled={creating || !formPrompt.trim()}
                onClick={() => handleCreateAgent(formPrompt, formModel, formName)}
              >
                {creating ? '[ Dispatching… ]' : '[   Dispatch   ]'}
              </button>
            </div>
          )}

          <div style={styles.agentList}>
            {agents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                selected={selectedAgentId === agent.id}
                isRunning={!agentTerminal[agent.id]}
                onClick={() => setSelectedAgentId(agent.id)}
                onDelete={async () => {
                  if (!id) return
                  sseControllers.current.get(agent.id)?.abort()
                  sseControllers.current.delete(agent.id)
                  await deleteAgent(id, agent.id)
                  setAgents((prev) => prev.filter((a) => a.id !== agent.id))
                  if (selectedAgentId === agent.id) setSelectedAgentId(null)
                }}
              />
            ))}
          </div>
        </div>

        {/* Main terminal */}
        <div style={styles.main}>
          <div style={styles.feed}>
            {feed.length === 0 && (
              <div style={styles.empty}>
                {'─'.repeat(20)} NO EVENTS {'─'.repeat(20)}<br />
                Dispatch an agent to get started.
              </div>
            )}

            {feed.map((item, i) => {
              if (item.kind === 'user') {
                return (
                  <div key={item.key} style={styles.userRow}>
                    <span style={styles.userPrefix}>YOU ▶ {agentName(item.agentId)}:</span>
                    <span style={styles.userText}>{item.prompt}</span>
                  </div>
                )
              }

              if (item.kind === 'message') {
                return (
                  <div key={item.key} style={styles.msgRow}>
                    <span style={styles.msgPrefix}>{agentName(item.agentId)} ▶</span>
                    <span style={styles.msgText}>
                      {String(item.event.data.accumulated ?? item.event.data.delta ?? '')}
                    </span>
                  </div>
                )
              }

              // activity block
              return (
                <ActivityLine
                  key={item.block.blockId}
                  block={item.block}
                  expanded={expandedBlocks.has(item.block.blockId)}
                  onToggle={() => toggleBlock(item.block.blockId)}
                  agentLabel={agentName(item.block.agentId)}
                />
              )
            })}

            <div ref={feedBottomRef} />
          </div>

          {/* Per-agent status indicators (fixed above input bar) */}
          {agents.some((a) => !agentTerminal[a.id]) && (
            <div style={styles.statusBar}>
              {agents
                .filter((a) => !agentTerminal[a.id])
                .map((a) => (
                  <span key={a.id} style={styles.statusItem}>
                    <span style={styles.statusName}>{agentName(a.id)}</span>
                    {agentBusy[a.id] ? (
                      <span style={styles.statusDots}>
                        <span className="dos-dot-1">.</span>
                        <span className="dos-dot-2">.</span>
                        <span className="dos-dot-3">.</span>
                      </span>
                    ) : (
                      <span style={styles.statusDotsIdle}>...</span>
                    )}
                  </span>
                ))}
            </div>
          )}

          {/* Input bar */}
          <div style={styles.inputBar}>
            <span style={styles.inputLabel}>Agent:</span>
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
            <span style={styles.inputPrompt}>▶</span>
            <input
              style={styles.chatInput}
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              placeholder={targetAgentId === 'new' ? 'dispatch a new agent…' : 'send a message…'}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  handleChatSend()
                }
              }}
            />
            <button
              style={{ ...styles.sendBtn, opacity: creating || !chatInput.trim() ? 0.5 : 1 }}
              disabled={creating || !chatInput.trim()}
              onClick={handleChatSend}
            >
              [ Send ]
            </button>
          </div>
        </div>
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
    background: '#0000AA',
    fontFamily: 'Courier New, Courier, monospace',
    fontSize: '13px',
    color: '#FFFFFF',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    padding: '2px 8px',
    background: '#AAAAAA',
    color: '#000000',
    flexShrink: 0,
    overflow: 'hidden',
  },
  back: {
    color: '#000000',
    textDecoration: 'none',
    fontWeight: 'bold',
    flexShrink: 0,
  },
  headerSep: { color: '#555555', flexShrink: 0 },
  title: { fontWeight: 'bold', flexShrink: 0, letterSpacing: '0.5px' },
  headerFill: { color: '#555555', overflow: 'hidden', flex: 1 },
  body: { display: 'flex', flex: 1, overflow: 'hidden' },
  sidebar: {
    width: '260px',
    flexShrink: 0,
    background: '#000080',
    display: 'flex',
    flexDirection: 'column',
    padding: '4px 6px',
    overflowY: 'auto',
    gap: '2px',
  },
  sidebarTitle: { color: '#55FFFF', marginBottom: '2px' },
  newAgentBtn: {
    width: '100%',
    padding: '1px 0',
    background: '#AAAAAA',
    color: '#000000',
    border: 'none',
    cursor: 'pointer',
    marginBottom: '4px',
  },
  form: { marginBottom: '6px' },
  formRow: { marginBottom: '2px' },
  label: { display: 'block', marginBottom: '1px' },
  select: {
    width: '100%', padding: '0 4px', border: 'none',
    background: '#AAAAAA', color: '#000000', outline: 'none', display: 'block',
  },
  input: {
    width: '100%', padding: '0 4px', border: 'none',
    background: '#AAAAAA', color: '#000000', outline: 'none', display: 'block',
  },
  textarea: {
    width: '100%', padding: '1px 4px', border: 'none',
    background: '#AAAAAA', color: '#000000', resize: 'vertical', outline: 'none', display: 'block',
  },
  submitBtn: {
    width: '100%', padding: '1px 0', background: '#AAAAAA', color: '#000000',
    border: 'none', cursor: 'pointer',
  },
  agentList: { flex: 1 },
  main: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#0000AA' },
  feed: {
    flex: 1, overflowY: 'auto', padding: '8px 12px',
    display: 'flex', flexDirection: 'column', gap: '2px',
  },
  empty: { color: '#AAAAAA', textAlign: 'center', marginTop: '3rem', lineHeight: 1.8 },

  // User message row
  userRow: { display: 'flex', gap: '6px', flexWrap: 'wrap' },
  userPrefix: { color: '#FFFF55', fontWeight: 'bold', flexShrink: 0 },
  userText: { color: '#FFFF55', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },

  // Agent text message row
  msgRow: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'flex-start' },
  msgPrefix: { color: '#55FFFF', fontWeight: 'bold', flexShrink: 0 },
  msgText: { color: '#FFFFFF', whiteSpace: 'pre-wrap', wordBreak: 'break-word', flex: 1 },

  // Activity block
  activityWrap: { display: 'flex', flexDirection: 'column' },
  activityRow: { display: 'flex', alignItems: 'center', gap: '4px' },
  chevron: {
    background: 'none', border: 'none', color: '#AAAAAA', cursor: 'pointer',
    padding: '0', flexShrink: 0,
    fontFamily: 'Courier New, Courier, monospace',
  },
  activityPrefix: { color: '#55FFFF', fontWeight: 'bold', flexShrink: 0 },
  activityLatest: { color: '#AAAAAA' },
  historyList: { paddingLeft: '28px', display: 'flex', flexDirection: 'column', gap: '1px' },
  historyItem: { display: 'flex', gap: '4px', alignItems: 'flex-start' },
  historyBullet: { color: '#555555', flexShrink: 0 },

  // Status bar (between feed and input)
  statusBar: {
    background: '#000066',
    padding: '2px 12px',
    display: 'flex',
    gap: '1rem',
    flexShrink: 0,
    flexWrap: 'wrap',
  },
  statusItem: { display: 'inline-flex', alignItems: 'baseline', gap: '3px' },
  statusName: { color: '#AAAAAA' },
  statusDots: { color: '#FFFFFF', letterSpacing: '1px' },
  statusDotsIdle: { color: '#555555', letterSpacing: '1px' },

  // Input bar
  inputBar: {
    display: 'flex', alignItems: 'center', gap: '0.375rem',
    padding: '2px 6px',
    background: '#000066', flexShrink: 0,
  },
  inputLabel: { color: '#55FFFF', flexShrink: 0 },
  targetSelect: {
    padding: '0 4px', border: 'none',
    background: '#AAAAAA', color: '#000000',
    flexShrink: 0, maxWidth: '150px', outline: 'none',
  },
  inputPrompt: { color: '#55FFFF', flexShrink: 0 },
  chatInput: {
    flex: 1, padding: '0 6px', border: 'none',
    background: '#AAAAAA', color: '#000000', outline: 'none',
  },
  sendBtn: {
    padding: '1px 10px', background: '#AAAAAA', color: '#000000',
    border: 'none', cursor: 'pointer', flexShrink: 0,
  },
}
