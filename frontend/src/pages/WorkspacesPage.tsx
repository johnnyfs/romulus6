import { useEffect, useState } from 'react'
import type { Workspace } from '../api/workspaces'
import { listWorkspaces, createWorkspace, deleteWorkspace } from '../api/workspaces'
import WorkspaceCard from '../components/WorkspaceCard'

export default function WorkspacesPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    void listWorkspaces()
      .then((items) => {
        if (cancelled) return
        setWorkspaces(items)
        setLoadError(null)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setLoadError(error instanceof Error ? error.message : 'Failed to fetch workspaces')
      })

    return () => {
      cancelled = true
    }
  }, [])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = newName.trim()
    if (!trimmed) return
    setCreating(true)
    setActionError(null)
    try {
      const ws = await createWorkspace(trimmed)
      setWorkspaces((prev) => [...prev, ws])
      setNewName('')
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to create workspace')
    } finally {
      setCreating(false)
    }
  }

  async function handleDelete(id: string) {
    setActionError(null)
    try {
      await deleteWorkspace(id)
      setWorkspaces((prev) => prev.filter((w) => w.id !== id))
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to delete workspace')
    }
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

        {loadError ? <p style={styles.error}>{loadError}</p> : null}
        {actionError ? <p style={styles.error}>{actionError}</p> : null}

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
  error: {
    margin: 0,
    color: '#f97066',
    fontSize: '14px',
  },
}
