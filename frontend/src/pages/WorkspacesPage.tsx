import { useEffect, useState } from 'react'
import type { Workspace } from '../api/workspaces'
import { listWorkspaces, createWorkspace, deleteWorkspace } from '../api/workspaces'
import WorkspaceCard from '../components/WorkspaceCard'

export default function WorkspacesPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    listWorkspaces().then(setWorkspaces)
  }, [])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = newName.trim()
    if (!trimmed) return
    setCreating(true)
    try {
      const ws = await createWorkspace(trimmed)
      setWorkspaces((prev) => [...prev, ws])
      setNewName('')
    } finally {
      setCreating(false)
    }
  }

  async function handleDelete(id: string) {
    await deleteWorkspace(id)
    setWorkspaces((prev) => prev.filter((w) => w.id !== id))
  }

  return (
    <div style={styles.page}>
      {/* Title bar */}
      <div style={styles.titleBar}>
        WORKSPACES
      </div>

      {/* Body */}
      <div style={styles.windowBody}>
        workspace name
        <form onSubmit={handleCreate} style={styles.form}>
          <input
            style={styles.input}
            type="text"
            placeholder="new workspace name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <button style={styles.createBtn} type="submit" disabled={creating}>
            {creating ? '[ Creating… ]' : '[ New ]'}
          </button>
        </form>

        <div style={styles.divider}>{'─'.repeat(56)}</div>

        <div style={styles.list}>
          {workspaces.length === 0 ? (
            <p style={styles.empty}>No workspaces yet.</p>
          ) : (
            workspaces.map((ws) => (
              <WorkspaceCard key={ws.id} workspace={ws} onDelete={handleDelete} />
            ))
          )}
        </div>
      </div>

      {/* Status bar */}
      <div style={styles.statusBar}>
        F1-Help  F2-New  F10-Menu
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    background: '#0000AA',
    display: 'flex',
    flexDirection: 'column',
    fontFamily: 'Courier New, Courier, monospace',
    fontSize: '13px',
    color: '#FFFFFF',
  },
  titleBar: {
    background: '#AAAAAA',
    color: '#000000',
    padding: '2px 8px',
    fontWeight: 'bold',
    flexShrink: 0,
  },
  windowBody: {
    padding: '8px 12px',
    flex: 1,
  },
  form: {
    display: 'flex',
    alignItems: 'center',
    gap: '0',
    marginBottom: '0.75rem',
  },
  input: {
    flex: 1,
    padding: '0 6px',
    border: 'none',
    background: '#AAAAAA',
    color: '#000000',
    outline: 'none',
  },
  createBtn: {
    padding: '0 8px',
    background: '#AAAAAA',
    color: '#000000',
    border: 'none',
    cursor: 'pointer',
    flexShrink: 0,
  },
  divider: {
    color: '#AAAAAA',
    marginBottom: '0.5rem',
    overflow: 'hidden',
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
  },
  empty: {
    color: '#AAAAAA',
    padding: '0.5rem 0',
  },
  statusBar: {
    background: '#AAAAAA',
    color: '#000000',
    padding: '2px 8px',
    flexShrink: 0,
  },
}
