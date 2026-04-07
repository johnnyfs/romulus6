import type { Agent } from '../api/agents'
import { TERMINAL_STATUSES } from '../api/agents'

interface Props {
  agent: Agent
  selected: boolean
  isRunning?: boolean
  isRunAgent?: boolean
  onClick: () => void
  onDismiss: () => void
  onDelete: () => void
}

export default function AgentCard({
  agent,
  selected,
  isRunning,
  isRunAgent,
  onClick,
  onDismiss,
  onDelete,
}: Props) {
  const displayName = agent.name ?? agent.model.split('/')[1]
  const modelShort = agent.model.split('/')[1]
  // For run agents, extract the node name from "run-<uuid>-<nodename>"
  const runNodeName = isRunAgent && agent.name
    ? agent.name.replace(/^run-[0-9a-f-]+-/, '')
    : null
  const label = runNodeName ?? (agent.name ? `${agent.name}  ${modelShort}` : displayName)

  const running = isRunning ?? !TERMINAL_STATUSES.includes(agent.status)

  return (
    <div
      style={{
        ...styles.row,
        background: selected ? 'var(--surface-2)' : 'transparent',
        borderLeft: selected ? '2px solid var(--accent)' : '2px solid transparent',
        opacity: agent.dismissed ? 0.55 : 1,
        ...(isRunAgent ? { paddingLeft: '18px', fontSize: '12px' } : {}),
      }}
      onClick={onClick}
    >
      <span
        style={{
          ...styles.dot,
          color: running ? 'var(--accent)' : 'var(--text-muted)',
        }}
      >
        ●
      </span>
      <span style={{ ...styles.label, color: agent.dismissed ? 'var(--text-muted)' : 'var(--text)' }}>
        {label}
      </span>
      <button
        style={styles.dismissBtn}
        onClick={(e) => { e.stopPropagation(); onDismiss() }}
        title={agent.dismissed ? 'Restore agent' : 'Dismiss agent'}
      >
        {agent.dismissed ? 'undo' : 'x'}
      </button>
      {agent.dismissed && (
        <button
          style={styles.deleteBtn}
          onClick={(e) => { e.stopPropagation(); onDelete() }}
          title="Delete agent and its history"
        >
          del
        </button>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 10px',
    cursor: 'pointer',
    borderRadius: '4px',
    transition: 'background 0.1s',
  },
  dot: {
    fontSize: '8px',
    flexShrink: 0,
    lineHeight: 1,
  },
  label: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '13px',
  },
  dismissBtn: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: '0 2px',
    flexShrink: 0,
    color: 'var(--text-muted)',
    fontSize: '14px',
    lineHeight: 1,
    opacity: 0.8,
  },
  deleteBtn: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: '0 4px',
    flexShrink: 0,
    color: 'var(--danger)',
    fontSize: '11px',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    lineHeight: 1,
    opacity: 0.6,
  },
}
