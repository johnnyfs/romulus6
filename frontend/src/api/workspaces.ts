export interface Workspace {
  id: string
  name: string
}

export async function listWorkspaces(): Promise<Workspace[]> {
  const res = await fetch('/api/workspaces')
  if (!res.ok) throw new Error('Failed to fetch workspaces')
  return res.json()
}

export async function createWorkspace(name: string): Promise<Workspace> {
  const res = await fetch('/api/workspaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  if (!res.ok) throw new Error('Failed to create workspace')
  return res.json()
}

export async function getWorkspace(id: string): Promise<Workspace> {
  const res = await fetch(`/api/workspaces/${id}`)
  if (res.status === 404) throw new Error('Workspace not found')
  if (!res.ok) throw new Error('Failed to fetch workspace')
  return res.json()
}

export async function deleteWorkspace(id: string): Promise<void> {
  const res = await fetch(`/api/workspaces/${id}`, { method: 'DELETE' })
  if (res.status === 404) return
  if (!res.ok) throw new Error('Failed to delete workspace')
}
