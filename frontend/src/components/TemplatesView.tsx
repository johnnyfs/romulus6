import { useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import TaskTemplatesPanel from './TaskTemplatesPanel'
import SubgraphTemplatesPanel from './SubgraphTemplatesPanel'
import SchemaTemplatesPanel from './SchemaTemplatesPanel'
import {
  WORKSPACE_DETAIL_PARAM_KEYS,
  mergeSearchParams,
  readEnumParam,
} from './workspaceDetailSearchParams'

export default function TemplatesView({ workspaceId }: { workspaceId: string }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const subTab = readEnumParam(
    searchParams,
    WORKSPACE_DETAIL_PARAM_KEYS.templatesSubTab,
    ['tasks', 'subgraphs', 'schemas'] as const,
    'tasks',
  )
  const setSubTab = useCallback(
    (nextTab: 'tasks' | 'subgraphs' | 'schemas') => {
      setSearchParams(
        (prev) =>
          mergeSearchParams(prev, {
            [WORKSPACE_DETAIL_PARAM_KEYS.templatesSubTab]: nextTab,
          }),
        { replace: false },
      )
    },
    [setSearchParams],
  )

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
        <button
          style={subTab === 'schemas' ? { ...s.subTab, ...s.subTabActive } : s.subTab}
          onClick={() => setSubTab('schemas')}
        >Schemas</button>
      </div>
      {subTab === 'tasks' ? (
        <TaskTemplatesPanel workspaceId={workspaceId} />
      ) : subTab === 'subgraphs' ? (
        <SubgraphTemplatesPanel workspaceId={workspaceId} />
      ) : (
        <SchemaTemplatesPanel workspaceId={workspaceId} />
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
