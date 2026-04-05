import { useEffect, useRef, useState } from 'react'
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
} from '../api/agents'
import { getWorkspace, type Workspace } from '../api/workspaces'
import AgentCard from '../components/AgentCard'

interface FeedEvent {
  event: AgentEvent
  agentId: string
}

function renderEventContent(event: AgentEvent): React.ReactNode {
  switch (event.type) {
    case 'text.delta':
    case 'text.complete':
      return <span>{String(event.data.accumulated ?? event.data.delta ?? '')}</span>
    case 'file.edit':
      return (
        <span style={styles.pill}>
          ✎ {String(event.data.path ?? 'file')}
        </span>
      )
    case 'tool.use':
      return (
        <span style={styles.pill}>
          ⚙ {String(event.data.tool ?? 'tool')}
        </span>
      )
    case 'command.output':
      return (
        <pre style={styles.pre}>
          {String(event.data.stdout ?? '')}
          {event.data.stderr ? `\n${String(event.data.stderr)}` : ''}
        </pre>
      )
    default:
      return <span style={styles.systemMsg}>{event.type}</span>
  }
}

function isSessionStatusEvent(type: string): boolean {
  return type.startsWith('session.')
}

export default function WorkspaceDetailPage() {
  const { id } = useParams<{ id: string }>()
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [agents, setAgents] = useState<Agent[]>([])
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [eventMap, setEventMap] = useState<Record<string, AgentEvent[]>>({})
  const [sinceMap, setSinceMap] = useState<Record<string, number>>({})
  const [showForm, setShowForm] = useState(false)
  const [formModel, setFormModel] = useState(DEFAULT_MODEL)
  const [formPrompt, setFormPrompt] = useState('')
  const [formName, setFormName] = useState('')
  const [creating, setCreating] = useState(false)
  const [chatInput, setChatInput] = useState('')
  const [targetAgentId, setTargetAgentId] = useState<string>('new')
  const [userMessages, setUserMessages] = useState<
    { agentId: string; prompt: string; timestamp: string }[]
  >([])
  const feedBottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!id) return
    Promise.all([getWorkspace(id), listAgents(id)]).then(([ws, agts]) => {
      setWorkspace(ws)
      setAgents(agts)
    })
  }, [id])

  // Polling loop
  useEffect(() => {
    if (!id || agents.length === 0) return
    const timer = setInterval(async () => {
      const activeAgents = agents.filter(
        (a) => !TERMINAL_STATUSES.includes(a.status),
      )
      if (activeAgents.length === 0) return

      const updates = await Promise.allSettled(
        activeAgents.map((a) =>
          getAgentEvents(id, a.id, sinceMap[a.id] ?? 0).then((evts) => ({
            agentId: a.id,
            evts,
          })),
        ),
      )

      setEventMap((prev) => {
        const next = { ...prev }
        for (const result of updates) {
          if (result.status === 'fulfilled' && result.value.evts.length > 0) {
            const { agentId, evts } = result.value
            next[agentId] = [...(prev[agentId] ?? []), ...evts]
          }
        }
        return next
      })

      setSinceMap((prev) => {
        const next = { ...prev }
        for (const result of updates) {
          if (result.status === 'fulfilled' && result.value.evts.length > 0) {
            const { agentId, evts } = result.value
            next[agentId] = (prev[agentId] ?? 0) + evts.length
          }
        }
        return next
      })
    }, 2000)

    return () => clearInterval(timer)
  }, [id, agents, sinceMap])

  // Auto-scroll feed to bottom
  useEffect(() => {
    feedBottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [eventMap])

  // Build unified feed: agent events + user messages, sorted by timestamp.
  // Accumulate text.delta per message_id into a single bubble.
  const feed: (FeedEvent & { accumulated?: boolean; isUser?: boolean })[] = (() => {
    const all: FeedEvent[] = []
    for (const [agentId, evts] of Object.entries(eventMap)) {
      for (const event of evts) {
        all.push({ event, agentId })
      }
    }
    // Inject user messages as synthetic events
    for (const msg of userMessages) {
      all.push({
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
    all.sort((a, b) => a.event.timestamp.localeCompare(b.event.timestamp))

    // Collapse text.delta into accumulated bubbles, keyed by message_id
    const collapsed: (FeedEvent & { accumulated?: boolean; isUser?: boolean })[] = []
    const textBuffers: Record<string, { idx: number; text: string }> = {}
    for (const item of all) {
      if (item.event.type === 'text.delta') {
        const key = String(item.event.data.message_id ?? item.event.session_id)
        const chunk = String(item.event.data.delta ?? '')
        if (textBuffers[key] !== undefined) {
          textBuffers[key].text += chunk
          const existing = collapsed[textBuffers[key].idx]
          existing.event = {
            ...existing.event,
            data: { ...existing.event.data, accumulated: textBuffers[key].text },
          }
        } else {
          const idx = collapsed.length
          textBuffers[key] = { idx, text: chunk }
          collapsed.push({
            ...item,
            accumulated: true,
            event: { ...item.event, data: { ...item.event.data, accumulated: chunk } },
          })
        }
      } else if (item.event.type === 'text.complete') {
        const key = String(item.event.data.message_id ?? item.event.session_id)
        delete textBuffers[key]
      } else if (item.event.type === 'user.message') {
        collapsed.push({ ...item, isUser: true })
      } else {
        collapsed.push(item)
      }
    }
    return collapsed
  })()

  function agentName(agentId: string): string {
    const a = agents.find((x) => x.id === agentId)
    if (!a) return 'agent'
    return a.name ?? `${a.agent_type} / ${a.model.split('/')[1]}`
  }

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
      }
      setChatInput('')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div style={styles.page}>
      {/* Header */}
      <div style={styles.header}>
        <Link to="/workspaces" style={styles.back}>
          ← Back
        </Link>
        <span style={styles.title}>{workspace?.name ?? '…'}</span>
      </div>

      {/* Body */}
      <div style={styles.body}>
        {/* Left column */}
        <div style={styles.sidebar}>
          <button
            style={styles.newAgentBtn}
            onClick={() => setShowForm((v) => !v)}
          >
            + New Agent
          </button>

          {showForm && (
            <div style={styles.form}>
              <div style={styles.formRow}>
                <label style={styles.label}>Model</label>
                <select
                  style={styles.select}
                  value={formModel}
                  onChange={(e) => setFormModel(e.target.value)}
                >
                  <optgroup label="Anthropic">
                    {ANTHROPIC_MODELS.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="OpenAI">
                    {OPENAI_MODELS.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </optgroup>
                </select>
              </div>
              <div style={styles.formRow}>
                <label style={styles.label}>Name (optional)</label>
                <input
                  style={styles.input}
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="Agent name"
                />
              </div>
              <div style={styles.formRow}>
                <label style={styles.label}>Prompt</label>
                <textarea
                  style={styles.textarea}
                  value={formPrompt}
                  onChange={(e) => setFormPrompt(e.target.value)}
                  placeholder="What should this agent do?"
                  rows={4}
                />
              </div>
              <button
                style={styles.submitBtn}
                disabled={creating || !formPrompt.trim()}
                onClick={() => handleCreateAgent(formPrompt, formModel, formName)}
              >
                {creating ? 'Starting…' : 'Dispatch'}
              </button>
            </div>
          )}

          <div style={styles.agentList}>
            {agents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                selected={selectedAgentId === agent.id}
                onClick={() => setSelectedAgentId(agent.id)}
                onDelete={async () => {
                  if (!id) return
                  await deleteAgent(id, agent.id)
                  setAgents((prev) => prev.filter((a) => a.id !== agent.id))
                  if (selectedAgentId === agent.id) setSelectedAgentId(null)
                }}
              />
            ))}
          </div>
        </div>

        {/* Main chat area */}
        <div style={styles.main}>
          <div style={styles.feed}>
            {feed.length === 0 && (
              <div style={styles.empty}>No events yet. Dispatch an agent to get started.</div>
            )}
            {feed.map((item, i) => {
              const isSystem = isSessionStatusEvent(item.event.type)
              if (item.isUser) {
                return (
                  <div key={`${item.agentId}-${i}`} style={styles.userRow}>
                    <div style={styles.userBubble}>
                      {String(item.event.data.prompt ?? '')}
                    </div>
                    <div style={styles.userLabel}>you → {agentName(item.agentId)}</div>
                  </div>
                )
              }
              return (
                <div
                  key={`${item.agentId}-${i}`}
                  style={isSystem ? styles.systemRow : styles.eventRow}
                >
                  {isSystem ? (
                    <span style={styles.systemMsg}>
                      [{agentName(item.agentId)}] {item.event.type}
                    </span>
                  ) : (
                    <>
                      <div style={styles.eventLabel}>{agentName(item.agentId)}</div>
                      <div style={styles.bubble}>
                        {renderEventContent(item.event)}
                      </div>
                    </>
                  )}
                </div>
              )
            })}
            <div ref={feedBottomRef} />
          </div>

          <div style={styles.inputBar}>
            <select
              style={styles.targetSelect}
              value={targetAgentId}
              onChange={(e) => setTargetAgentId(e.target.value)}
            >
              <option value="new">+ New agent</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name ?? `${a.agent_type} / ${a.model.split('/')[1]}`}
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
              style={styles.sendBtn}
              disabled={creating || !chatInput.trim()}
              onClick={handleChatSend}
            >
              Send
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
    textAlign: 'left',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
    padding: '0.75rem 1.5rem',
    borderBottom: '1px solid #e2e8f0',
    background: '#fff',
    flexShrink: 0,
  },
  back: {
    color: '#64748b',
    textDecoration: 'none',
    fontSize: '0.875rem',
  },
  title: {
    fontWeight: 700,
    fontSize: '1.125rem',
  },
  body: {
    display: 'flex',
    flex: 1,
    overflow: 'hidden',
  },
  sidebar: {
    width: '280px',
    flexShrink: 0,
    borderRight: '1px solid #e2e8f0',
    background: '#f8fafc',
    display: 'flex',
    flexDirection: 'column',
    padding: '1rem',
    overflowY: 'auto',
  },
  newAgentBtn: {
    width: '100%',
    padding: '0.5rem',
    background: '#aa3bff',
    color: '#fff',
    border: 'none',
    borderRadius: '0.5rem',
    fontWeight: 600,
    fontSize: '0.875rem',
    cursor: 'pointer',
    marginBottom: '0.75rem',
  },
  form: {
    background: '#fff',
    border: '1px solid #e2e8f0',
    borderRadius: '0.5rem',
    padding: '0.75rem',
    marginBottom: '0.75rem',
  },
  formRow: {
    marginBottom: '0.5rem',
  },
  label: {
    display: 'block',
    fontSize: '0.75rem',
    fontWeight: 600,
    color: '#475569',
    marginBottom: '0.25rem',
  },
  select: {
    width: '100%',
    padding: '0.375rem 0.5rem',
    border: '1px solid #e2e8f0',
    borderRadius: '0.375rem',
    fontSize: '0.8125rem',
    boxSizing: 'border-box',
  },
  input: {
    width: '100%',
    padding: '0.375rem 0.5rem',
    border: '1px solid #e2e8f0',
    borderRadius: '0.375rem',
    fontSize: '0.8125rem',
    boxSizing: 'border-box',
  },
  textarea: {
    width: '100%',
    padding: '0.375rem 0.5rem',
    border: '1px solid #e2e8f0',
    borderRadius: '0.375rem',
    fontSize: '0.8125rem',
    resize: 'vertical',
    boxSizing: 'border-box',
  },
  submitBtn: {
    width: '100%',
    padding: '0.5rem',
    background: '#aa3bff',
    color: '#fff',
    border: 'none',
    borderRadius: '0.375rem',
    fontWeight: 600,
    fontSize: '0.8125rem',
    cursor: 'pointer',
  },
  agentList: {
    flex: 1,
  },
  main: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  feed: {
    flex: 1,
    overflowY: 'auto',
    padding: '1rem 1.5rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  },
  empty: {
    color: '#94a3b8',
    fontSize: '0.875rem',
    textAlign: 'center',
    marginTop: '2rem',
  },
  eventRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.125rem',
    maxWidth: '720px',
  },
  systemRow: {
    display: 'flex',
    justifyContent: 'center',
    padding: '0.25rem 0',
  },
  eventLabel: {
    fontSize: '0.6875rem',
    fontWeight: 600,
    color: '#94a3b8',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  bubble: {
    background: '#f1f5f9',
    borderRadius: '0 0.75rem 0.75rem 0.75rem',
    padding: '0.5rem 0.75rem',
    fontSize: '0.875rem',
    lineHeight: 1.6,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  userRow: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: '0.125rem',
    maxWidth: '720px',
    alignSelf: 'flex-end',
  },
  userBubble: {
    background: '#aa3bff',
    color: '#fff',
    borderRadius: '0.75rem 0 0.75rem 0.75rem',
    padding: '0.5rem 0.75rem',
    fontSize: '0.875rem',
    lineHeight: 1.6,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  userLabel: {
    fontSize: '0.6875rem',
    color: '#94a3b8',
  },
  systemMsg: {
    fontSize: '0.75rem',
    color: '#94a3b8',
    fontStyle: 'italic',
  },
  pill: {
    display: 'inline-block',
    background: '#e2e8f0',
    borderRadius: '0.25rem',
    padding: '0.125rem 0.375rem',
    fontSize: '0.75rem',
    fontFamily: 'monospace',
  },
  pre: {
    margin: 0,
    fontSize: '0.75rem',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
  },
  inputBar: {
    display: 'flex',
    gap: '0.5rem',
    padding: '0.75rem 1.5rem',
    borderTop: '1px solid #e2e8f0',
    background: '#fff',
    flexShrink: 0,
  },
  targetSelect: {
    padding: '0.5rem 0.5rem',
    border: '1px solid #e2e8f0',
    borderRadius: '0.5rem',
    fontSize: '0.8125rem',
    background: '#fff',
    flexShrink: 0,
    maxWidth: '160px',
  },
  chatInput: {
    flex: 1,
    padding: '0.5rem 0.75rem',
    border: '1px solid #e2e8f0',
    borderRadius: '0.5rem',
    fontSize: '0.875rem',
    outline: 'none',
  },
  sendBtn: {
    padding: '0.5rem 1.25rem',
    background: '#aa3bff',
    color: '#fff',
    border: 'none',
    borderRadius: '0.5rem',
    fontWeight: 600,
    fontSize: '0.875rem',
    cursor: 'pointer',
  },
}
