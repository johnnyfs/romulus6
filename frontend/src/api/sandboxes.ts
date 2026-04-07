export interface SandboxDebugAgent {
  id: string
  name: string
  agent_type: string
  model: string
  status: string
  dismissed: boolean
  sandbox_id: string | null
  session_id: string | null
  updated_at: string
}

export interface SandboxDebugSandbox {
  id: string
  name: string
  worker_id: string | null
  current_lease_id: string | null
  active_agent_count: number
  dismissed_agent_count: number
  agents: SandboxDebugAgent[]
}

export interface SandboxDebugWorker {
  id: string
  status: string
  is_healthy: boolean
  pod_name: string | null
  pod_ip: string | null
  worker_url: string | null
  last_heartbeat_at: string | null
  active_lease_id: string | null
  active_lease_workspace_id: string | null
  active_lease_sandbox_id: string | null
  active_lease_expires_at: string | null
  sandbox_name: string | null
  live_agent_count: number
  dismissed_agent_count: number
}

export interface SandboxDebugSummary {
  workspace_id: string
  active_agent_count: number
  dismissed_agent_count: number
  sandbox_count: number
  worker_count: number
  attached_worker_count: number
  sandboxes: SandboxDebugSandbox[]
  unassigned_agents: SandboxDebugAgent[]
  workers: SandboxDebugWorker[]
}

export async function getSandboxDebugSummary(workspaceId: string): Promise<SandboxDebugSummary> {
  const res = await fetch(`/api/workspaces/${workspaceId}/sandboxes/debug`)
  if (!res.ok) throw new Error('Failed to fetch sandbox debug summary')
  return res.json()
}
