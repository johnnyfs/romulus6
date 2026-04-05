import { useEffect, useState } from 'react'
import type { Agent } from '../api/agents'
import { TERMINAL_STATUSES } from '../api/agents'

interface Props {
  agent: Agent
  selected: boolean
  isRunning?: boolean  // true until a terminal session event is received
  onClick: () => void
  onDelete: () => void
}

// ☺ (U+263A) white smiley, ☻ (U+263B) black smiley — classic CP437 characters 1 & 2
function BlinkFace({ running, selected }: { running: boolean; selected: boolean }) {
  const dimColor = selected ? '#000066' : '#555555'
  const activeColor = selected ? '#000000' : '#55FF55'

  if (!running) {
    return (
      <span style={{ color: dimColor, fontSize: '14px' }}>☻</span>
    )
  }

  return (
    <span style={{ position: 'relative', display: 'inline-block', width: '1ch', fontSize: '14px', color: activeColor }}>
      <span className="face-a">☺</span>
      <span className="face-b">☻</span>
    </span>
  )
}

export default function AgentCard({ agent, selected, isRunning, onClick, onDelete }: Props) {
  const displayName =
    agent.name ?? agent.model.split('/')[1]
  const modelShort = agent.model.split('/')[1]
  const label = agent.name ? `${agent.name}  ${modelShort}` : displayName

  // Fallback: if isRunning prop not provided, derive from agent.status
  const running = isRunning ?? !TERMINAL_STATUSES.includes(agent.status)

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
      <span style={styles.label}>{label}</span>
      <BlinkFace running={running} selected={selected} />
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
    padding: '2px 4px',
    cursor: 'pointer',
  },
  arrow: {
    flexShrink: 0,
    width: '12px',
  },
  label: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  deleteBtn: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: '0 2px',
    flexShrink: 0,
    fontFamily: 'Courier New, Courier, monospace',
  },
}
