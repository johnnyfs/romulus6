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
      <div style={styles.inner}>
        <h1 style={styles.heading}>Workspaces</h1>

        <form onSubmit={handleCreate} style={styles.form}>
          <input
            style={styles.input}
            type="text"
            placeholder="New workspace name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <button style={styles.createBtn} type="submit" disabled={creating}>
            {creating ? 'Creating…' : 'Create'}
          </button>
        </form>

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
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    background: 'var(--bg)',
    display: 'flex',
    justifyContent: 'center',
    padding: '48px 24px',
  },
  inner: {
    width: '100%',
    maxWidth: '640px',
    display: 'flex',
    flexDirection: 'column',
    gap: '24px',
  },
  heading: {
    fontSize: '20px',
    fontWeight: 600,
    color: 'var(--text)',
  },
  form: {
    display: 'flex',
    gap: '8px',
  },
  input: {
    flex: 1,
    padding: '8px 12px',
    background: 'var(--surface-2)',
    border: '1px solid var(--border)',
    borderRadius: '6px',
    color: 'var(--text)',
    outline: 'none',
    fontSize: '14px',
  },
  createBtn: {
    padding: '8px 16px',
    background: 'var(--accent)',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '14px',
    fontWeight: 500,
    flexShrink: 0,
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  empty: {
    color: 'var(--text-muted)',
  },
}
