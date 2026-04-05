import type { Agent, AgentStatus } from '../api/agents'

interface Props {
  agent: Agent
  selected: boolean
  onClick: () => void
  onDelete: () => void
}

function statusColor(status: AgentStatus): string {
  switch (status) {
    case 'starting':
    case 'busy':
      return '#f59e0b'
    case 'idle':
    case 'completed':
      return '#10b981'
    case 'error':
    case 'interrupted':
      return '#ef4444'
  }
}

export default function AgentCard({ agent, selected, onClick, onDelete }: Props) {
  const displayName =
    agent.name ?? `${agent.agent_type} / ${agent.model.split('/')[1]}`
  const modelShort = agent.model.split('/')[1]

  return (
    <div style={{ ...styles.card, ...(selected ? styles.selected : {}) }} onClick={onClick}>
      <div style={styles.header}>
        <span style={styles.name}>{displayName}</span>
        <div style={styles.headerRight}>
          <span style={{ ...styles.badge, background: statusColor(agent.status) }}>
            {agent.status}
          </span>
          <button
            style={styles.deleteBtn}
            onClick={(e) => { e.stopPropagation(); onDelete() }}
            title="Delete agent"
          >
            ×
          </button>
        </div>
      </div>
      <div style={styles.model}>{modelShort}</div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    padding: '0.75rem 1rem',
    borderRadius: '0.5rem',
    border: '1px solid #e2e8f0',
    background: '#fff',
    cursor: 'pointer',
    marginBottom: '0.5rem',
  },
  selected: {
    borderColor: '#aa3bff',
    background: '#faf5ff',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '0.25rem',
  },
  headerRight: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.375rem',
    flexShrink: 0,
  },
  deleteBtn: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    color: '#94a3b8',
    fontSize: '1rem',
    lineHeight: 1,
    padding: '0 0.125rem',
    display: 'flex',
    alignItems: 'center',
  },
  name: {
    fontWeight: 600,
    fontSize: '0.875rem',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: '140px',
  },
  badge: {
    fontSize: '0.625rem',
    fontWeight: 600,
    color: '#fff',
    padding: '0.125rem 0.375rem',
    borderRadius: '9999px',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  model: {
    fontSize: '0.75rem',
    color: '#94a3b8',
  },
}
