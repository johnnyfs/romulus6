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
      <h1 style={styles.heading}>Workspaces</h1>

      <form onSubmit={handleCreate} style={styles.form}>
        <input
          style={styles.input}
          type="text"
          placeholder="Workspace name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <button style={styles.createBtn} type="submit" disabled={creating}>
          {creating ? 'Creating…' : 'New Workspace'}
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
  )
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    maxWidth: '640px',
    margin: '3rem auto',
    padding: '0 1rem',
    fontFamily: 'system-ui, sans-serif',
  },
  heading: {
    fontSize: '1.75rem',
    fontWeight: 700,
    marginBottom: '1.5rem',
  },
  form: {
    display: 'flex',
    gap: '0.75rem',
    marginBottom: '1.5rem',
  },
  input: {
    flex: 1,
    padding: '0.5rem 0.75rem',
    border: '1px solid #cbd5e1',
    borderRadius: '0.375rem',
    fontSize: '0.875rem',
  },
  createBtn: {
    padding: '0.5rem 1rem',
    background: '#3b82f6',
    color: '#fff',
    border: 'none',
    borderRadius: '0.375rem',
    cursor: 'pointer',
    fontSize: '0.875rem',
    fontWeight: 500,
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  },
  empty: {
    color: '#94a3b8',
    fontSize: '0.875rem',
  },
}
