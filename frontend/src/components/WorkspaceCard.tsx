import { Link } from 'react-router-dom'
import type { Workspace } from '../api/workspaces'

interface Props {
  workspace: Workspace
  onDelete: (id: string) => void
}

export default function WorkspaceCard({ workspace, onDelete }: Props) {
  return (
    <div style={styles.card}>
      <div>
        <Link to={`/workspaces/${workspace.id}`} style={styles.nameLink}>
          {workspace.name}
        </Link>
        <div style={styles.id}>{workspace.id}</div>
      </div>
      <button style={styles.deleteBtn} onClick={() => onDelete(workspace.id)}>
        Delete
      </button>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '1rem 1.25rem',
    border: '1px solid #e2e8f0',
    borderRadius: '0.5rem',
    background: '#fff',
  },
  nameLink: {
    display: 'block',
    fontWeight: 600,
    fontSize: '1rem',
    marginBottom: '0.25rem',
    color: 'inherit',
    textDecoration: 'none',
  },
  id: {
    fontSize: '0.75rem',
    color: '#94a3b8',
    fontFamily: 'monospace',
  },
  deleteBtn: {
    padding: '0.375rem 0.75rem',
    border: '1px solid #fca5a5',
    borderRadius: '0.375rem',
    background: '#fff',
    color: '#ef4444',
    cursor: 'pointer',
    fontSize: '0.875rem',
  },
}
