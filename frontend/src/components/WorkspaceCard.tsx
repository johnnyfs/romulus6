import { Link } from 'react-router-dom'
import type { Workspace } from '../api/workspaces'

interface Props {
  workspace: Workspace
  onDelete: (id: string) => void
}

export default function WorkspaceCard({ workspace, onDelete }: Props) {
  return (
    <div style={styles.card}>
      <div style={styles.info}>
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
    alignItems: 'center',
    gap: '12px',
    padding: '12px 16px',
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: '6px',
  },
  info: {
    flex: 1,
    overflow: 'hidden',
  },
  nameLink: {
    display: 'block',
    fontWeight: 600,
    fontSize: '14px',
    color: 'var(--text)',
    textDecoration: 'none',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  id: {
    fontSize: '11px',
    color: 'var(--text-dim)',
    fontFamily: "'Menlo', 'Consolas', monospace",
    marginTop: '2px',
  },
  deleteBtn: {
    padding: '4px 10px',
    background: 'transparent',
    color: 'var(--danger)',
    border: '1px solid transparent',
    borderRadius: '4px',
    fontSize: '12px',
    cursor: 'pointer',
    flexShrink: 0,
  },
}
