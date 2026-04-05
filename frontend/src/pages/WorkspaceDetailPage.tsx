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
          [✎ {String(event.data.path ?? 'file')}]
        </span>
      )
    case 'tool.use':
      return (
        <span style={styles.pill}>
          [⚙ {String(event.data.tool ?? 'tool')}]
        </span>
      )
    case 'command.output':
      return (
        <pre style={styles.pre}>
          {'┌─ stdout ─┐\n'}
          {String(event.data.stdout ?? '')}
          {event.data.stderr ? `\n┌─ stderr ─┐\n${String(event.data.stderr)}` : ''}
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
    return a.name ?? `${a.agent_type}/${a.model.split('/')[1]}`
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

  const workspaceName = workspace?.name ?? '…'

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
        {/* Left column / sidebar */}
        <div style={styles.sidebar}>
          <div style={styles.sidebarTitle}>╔══ AGENTS ══╗</div>

          <button
            style={styles.newAgentBtn}
            onClick={() => setShowForm((v) => !v)}
          >
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
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="── OpenAI ──">
                    {OPENAI_MODELS.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
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
                style={{
                  ...styles.submitBtn,
                  opacity: creating || !formPrompt.trim() ? 0.5 : 1,
                }}
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

        {/* Main terminal area */}
        <div style={styles.main}>
          <div style={styles.feed}>
            {feed.length === 0 && (
              <div style={styles.empty}>
                {'─'.repeat(20)} NO EVENTS {'─'.repeat(20)}<br />
                Dispatch an agent to get started.
              </div>
            )}
            {feed.map((item, i) => {
              const isSystem = isSessionStatusEvent(item.event.type)
              if (item.isUser) {
                return (
                  <div key={`${item.agentId}-${i}`} style={styles.userRow}>
                    <span style={styles.userPrefix}>YOU ▶ {agentName(item.agentId)}:</span>
                    <span style={styles.userText}>{String(item.event.data.prompt ?? '')}</span>
                  </div>
                )
              }
              if (isSystem) {
                return (
                  <div key={`${item.agentId}-${i}`} style={styles.systemRow}>
                    {'──── '}
                    <span style={styles.systemLabel}>[{agentName(item.agentId)}]</span>
                    {' '}{item.event.type}{' ────'}
                  </div>
                )
              }
              return (
                <div key={`${item.agentId}-${i}`} style={styles.eventRow}>
                  <span style={styles.eventPrefix}>{agentName(item.agentId)} ▶</span>
                  <span style={styles.eventContent}>
                    {renderEventContent(item.event)}
                  </span>
                </div>
              )
            })}
            <div ref={feedBottomRef} />
          </div>

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
              style={{
                ...styles.sendBtn,
                opacity: creating || !chatInput.trim() ? 0.5 : 1,
              }}
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
    fontSize: '13px',
    overflow: 'hidden',
  },
  back: {
    color: '#000000',
    textDecoration: 'none',
    fontWeight: 'bold',
    flexShrink: 0,
  },
  headerSep: {
    color: '#555555',
    flexShrink: 0,
  },
  title: {
    fontWeight: 'bold',
    flexShrink: 0,
    letterSpacing: '0.5px',
  },
  headerFill: {
    color: '#555555',
    overflow: 'hidden',
    flex: 1,
  },
  body: {
    display: 'flex',
    flex: 1,
    overflow: 'hidden',
  },
  sidebar: {
    width: '260px',
    flexShrink: 0,
    borderRight: '1px solid #AAAAAA',
    background: '#000080',
    display: 'flex',
    flexDirection: 'column',
    padding: '6px 8px',
    overflowY: 'auto',
    gap: '4px',
  },
  sidebarTitle: {
    color: '#55FFFF',
    fontSize: '12px',
    marginBottom: '4px',
    textAlign: 'center',
  },
  newAgentBtn: {
    width: '100%',
    padding: '3px 0',
    background: '#AAAAAA',
    color: '#000000',
    border: '1px solid #FFFFFF',
    fontSize: '13px',
    fontWeight: 'bold',
    cursor: 'pointer',
    marginBottom: '4px',
  },
  form: {
    border: '1px solid #AAAAAA',
    padding: '6px',
    marginBottom: '4px',
    background: '#000066',
  },
  formRow: {
    marginBottom: '4px',
  },
  label: {
    display: 'block',
    fontSize: '11px',
    color: '#55FFFF',
    marginBottom: '2px',
  },
  select: {
    width: '100%',
    padding: '2px 4px',
    border: '1px solid #AAAAAA',
    background: '#000080',
    color: '#FFFFFF',
    fontSize: '12px',
    outline: 'none',
  },
  input: {
    width: '100%',
    padding: '2px 4px',
    border: '1px solid #AAAAAA',
    background: '#000080',
    color: '#FFFFFF',
    fontSize: '12px',
    outline: 'none',
  },
  textarea: {
    width: '100%',
    padding: '2px 4px',
    border: '1px solid #AAAAAA',
    background: '#000080',
    color: '#FFFFFF',
    fontSize: '12px',
    resize: 'vertical',
    outline: 'none',
  },
  submitBtn: {
    width: '100%',
    padding: '3px 0',
    background: '#AAAAAA',
    color: '#000000',
    border: '1px solid #FFFFFF',
    fontSize: '13px',
    fontWeight: 'bold',
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
    background: '#0000AA',
  },
  feed: {
    flex: 1,
    overflowY: 'auto',
    padding: '8px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: '3px',
  },
  empty: {
    color: '#AAAAAA',
    fontSize: '12px',
    textAlign: 'center',
    marginTop: '3rem',
    lineHeight: 1.8,
  },
  userRow: {
    display: 'flex',
    gap: '0.5rem',
    flexWrap: 'wrap',
    paddingLeft: '0',
  },
  userPrefix: {
    color: '#FFFF55',
    fontWeight: 'bold',
    flexShrink: 0,
    fontSize: '12px',
  },
  userText: {
    color: '#FFFF55',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    fontSize: '13px',
  },
  systemRow: {
    color: '#AAAAAA',
    fontSize: '11px',
    textAlign: 'center',
    padding: '2px 0',
    fontStyle: 'italic',
  },
  systemLabel: {
    color: '#55FFFF',
  },
  eventRow: {
    display: 'flex',
    gap: '0.5rem',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
  },
  eventPrefix: {
    color: '#55FFFF',
    fontWeight: 'bold',
    flexShrink: 0,
    fontSize: '12px',
  },
  eventContent: {
    color: '#FFFFFF',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    fontSize: '13px',
    flex: 1,
  },
  systemMsg: {
    color: '#AAAAAA',
    fontStyle: 'italic',
    fontSize: '12px',
  },
  pill: {
    color: '#55FFFF',
    fontSize: '12px',
    fontFamily: 'Courier New, Courier, monospace',
  },
  pre: {
    margin: 0,
    fontSize: '12px',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    color: '#AAAAAA',
    fontFamily: 'Courier New, Courier, monospace',
  },
  inputBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.375rem',
    padding: '4px 8px',
    borderTop: '1px solid #AAAAAA',
    background: '#000066',
    flexShrink: 0,
  },
  inputLabel: {
    color: '#55FFFF',
    fontSize: '12px',
    flexShrink: 0,
  },
  targetSelect: {
    padding: '2px 4px',
    border: '1px solid #AAAAAA',
    background: '#000080',
    color: '#FFFFFF',
    fontSize: '12px',
    flexShrink: 0,
    maxWidth: '150px',
    outline: 'none',
  },
  inputPrompt: {
    color: '#55FFFF',
    fontSize: '14px',
    flexShrink: 0,
  },
  chatInput: {
    flex: 1,
    padding: '2px 6px',
    border: '1px solid #AAAAAA',
    background: '#000080',
    color: '#FFFFFF',
    fontSize: '13px',
    outline: 'none',
  },
  sendBtn: {
    padding: '2px 10px',
    background: '#AAAAAA',
    color: '#000000',
    border: '1px solid #FFFFFF',
    fontWeight: 'bold',
    fontSize: '13px',
    cursor: 'pointer',
    flexShrink: 0,
  },
}
