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
      <div style={styles.window}>
        {/* Title bar */}
        <div style={styles.titleBar}>
          ═══════════════════ WORKSPACES ═══════════════════
        </div>

        {/* Window body */}
        <div style={styles.windowBody}>
          <form onSubmit={handleCreate} style={styles.form}>
            <span style={styles.prompt}>▶</span>
            <input
              style={styles.input}
              type="text"
              placeholder="workspace name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <button style={styles.createBtn} type="submit" disabled={creating}>
              {creating ? '[ Creating… ]' : '[ New Workspace ]'}
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
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    background: '#0000AA',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '2rem 1rem',
  },
  window: {
    width: '600px',
    maxWidth: '100%',
    border: '1px solid #AAAAAA',
    background: '#000080',
    boxShadow: '4px 4px 0 #000000',
  },
  titleBar: {
    background: '#AAAAAA',
    color: '#000000',
    padding: '2px 8px',
    fontWeight: 'bold',
    fontSize: '13px',
    textAlign: 'center',
    letterSpacing: '0.5px',
  },
  windowBody: {
    padding: '1rem',
  },
  form: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    marginBottom: '0.75rem',
  },
  prompt: {
    color: '#55FFFF',
    fontSize: '14px',
    flexShrink: 0,
  },
  input: {
    flex: 1,
    padding: '3px 6px',
    border: '1px solid #AAAAAA',
    background: '#000066',
    color: '#FFFFFF',
    fontSize: '14px',
    outline: 'none',
  },
  createBtn: {
    padding: '3px 8px',
    background: '#AAAAAA',
    color: '#000000',
    border: '1px solid #FFFFFF',
    fontSize: '13px',
    fontWeight: 'bold',
    cursor: 'pointer',
    flexShrink: 0,
  },
  divider: {
    color: '#AAAAAA',
    fontSize: '13px',
    marginBottom: '0.5rem',
    overflow: 'hidden',
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
  },
  empty: {
    color: '#AAAAAA',
    fontSize: '13px',
    padding: '0.5rem 0',
  },
  statusBar: {
    background: '#AAAAAA',
    color: '#000000',
    padding: '2px 8px',
    fontSize: '12px',
  },
}
