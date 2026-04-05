import { Link } from 'react-router-dom'
import type { Workspace } from '../api/workspaces'

interface Props {
  workspace: Workspace
  onDelete: (id: string) => void
}

export default function WorkspaceCard({ workspace, onDelete }: Props) {
  return (
    <div style={styles.row}>
      <span style={styles.arrow}>►</span>
      <div style={styles.info}>
        <Link to={`/workspaces/${workspace.id}`} style={styles.nameLink}>
          {workspace.name}
        </Link>
        <div style={styles.id}>{workspace.id}</div>
      </div>
      <button style={styles.deleteBtn} onClick={() => onDelete(workspace.id)}>
        [ Del ]
      </button>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    padding: '4px 0',
    borderBottom: '1px solid #000066',
  },
  arrow: {
    color: '#55FFFF',
    fontSize: '13px',
    flexShrink: 0,
  },
  info: {
    flex: 1,
    overflow: 'hidden',
  },
  nameLink: {
    display: 'block',
    fontWeight: 'bold',
    fontSize: '14px',
    color: '#FFFFFF',
    textDecoration: 'none',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  id: {
    fontSize: '11px',
    color: '#AAAAAA',
    fontFamily: 'Courier New, Courier, monospace',
  },
  deleteBtn: {
    padding: '2px 6px',
    background: '#AAAAAA',
    color: '#000000',
    border: '1px solid #555555',
    fontSize: '12px',
    cursor: 'pointer',
    flexShrink: 0,
  },
}
