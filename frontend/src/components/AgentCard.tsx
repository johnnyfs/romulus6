import type { Agent, AgentStatus } from '../api/agents'

interface Props {
  agent: Agent
  selected: boolean
  onClick: () => void
  onDelete: () => void
}

function statusLabel(status: AgentStatus): string {
  switch (status) {
    case 'starting': return '[INIT]'
    case 'busy':     return '[BUSY]'
    case 'idle':     return '[IDLE]'
    case 'completed': return '[DONE]'
    case 'error':    return '[ERR!]'
    case 'interrupted': return '[INT!]'
  }
}

function statusColor(status: AgentStatus): string {
  switch (status) {
    case 'starting':
    case 'busy':
      return '#FFFF55'
    case 'idle':
    case 'completed':
      return '#55FF55'
    case 'error':
    case 'interrupted':
      return '#FF5555'
  }
}

export default function AgentCard({ agent, selected, onClick, onDelete }: Props) {
  const displayName =
    agent.name ?? `${agent.agent_type}/${agent.model.split('/')[1]}`
  const modelShort = agent.model.split('/')[1]

  return (
    <div
      style={{
        ...styles.row,
        background: selected ? '#55FFFF' : 'transparent',
        color: selected ? '#000000' : '#FFFFFF',
      }}
      onClick={onClick}
    >
      <span style={{ ...styles.arrow, color: selected ? '#000080' : '#55FFFF' }}>
        {selected ? '►' : ' '}
      </span>
      <div style={styles.info}>
        <div style={styles.name}>{displayName}</div>
        <div style={{ ...styles.model, color: selected ? '#000066' : '#AAAAAA' }}>
          {modelShort}
        </div>
      </div>
      <span style={{ ...styles.badge, color: selected ? '#000000' : statusColor(agent.status) }}>
        {statusLabel(agent.status)}
      </span>
      <button
        style={{ ...styles.deleteBtn, color: selected ? '#000000' : '#AAAAAA' }}
        onClick={(e) => { e.stopPropagation(); onDelete() }}
        title="Delete agent"
      >
        [×]
      </button>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.375rem',
    padding: '3px 4px',
    cursor: 'pointer',
    borderBottom: '1px solid #000066',
    fontSize: '13px',
  },
  arrow: {
    flexShrink: 0,
    width: '12px',
  },
  info: {
    flex: 1,
    overflow: 'hidden',
    minWidth: 0,
  },
  name: {
    fontWeight: 'bold',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  model: {
    fontSize: '11px',
  },
  badge: {
    fontSize: '11px',
    fontWeight: 'bold',
    flexShrink: 0,
    letterSpacing: '0.02em',
  },
  deleteBtn: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    fontSize: '13px',
    padding: '0 2px',
    flexShrink: 0,
    fontFamily: 'Courier New, Courier, monospace',
  },
}
