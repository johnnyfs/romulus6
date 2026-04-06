import { useState } from 'react'
import TaskTemplatesPanel from './TaskTemplatesPanel'
import SubgraphTemplatesPanel from './SubgraphTemplatesPanel'

export default function TemplatesView({ workspaceId }: { workspaceId: string }) {
  const [subTab, setSubTab] = useState<'tasks' | 'subgraphs'>('tasks')

  return (
    <div style={s.wrap}>
      <div style={s.subTabBar}>
        <button
          style={subTab === 'tasks' ? { ...s.subTab, ...s.subTabActive } : s.subTab}
          onClick={() => setSubTab('tasks')}
        >Tasks</button>
        <button
          style={subTab === 'subgraphs' ? { ...s.subTab, ...s.subTabActive } : s.subTab}
          onClick={() => setSubTab('subgraphs')}
        >Subgraphs</button>
      </div>
      {subTab === 'tasks' ? (
        <TaskTemplatesPanel workspaceId={workspaceId} />
      ) : (
        <SubgraphTemplatesPanel workspaceId={workspaceId} />
      )}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  wrap: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  subTabBar: {
    display: 'flex',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0,
  },
  subTab: {
    flex: 1,
    padding: '5px 0',
    background: 'transparent',
    color: 'var(--text-muted)',
    border: 'none',
    borderBottom: '2px solid transparent',
    cursor: 'pointer',
    fontSize: '11px',
    fontWeight: 500,
    letterSpacing: '0.04em',
  },
  subTabActive: {
    color: 'var(--text)',
    borderBottomColor: 'var(--accent)',
  },
}
