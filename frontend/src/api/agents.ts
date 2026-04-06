export type AgentType = 'opencode'

export type AgentStatus =
  | 'starting'
  | 'busy'
  | 'idle'
  | 'waiting'
  | 'completed'
  | 'error'
  | 'interrupted'

export interface Agent {
  id: string
  workspace_id: string
  sandbox_id: string
  agent_type: AgentType
  model: string
  session_id: string | null
  status: AgentStatus
  name: string | null
  prompt: string
  graph_run_id: string | null
  created_at: string
  updated_at: string
}

export interface AgentEvent {
  id: string
  session_id: string
  type: string
  timestamp: string
  received_at?: string
  data: Record<string, unknown>
  source_name?: string | null
  agent_id?: string | null
  run_id?: string | null
  node_id?: string | null
  sandbox_id?: string | null
  worker_id?: string | null
  source_id?: string | null
  source_type?: string | null
  display_label?: string | null
  path_parts?: string[]
  stream_key?: string | null
}

export interface CreateOpenCodeAgentRequest {
  agent_type: 'opencode'
  model: string
  prompt: string
  name?: string
  graph_tools?: boolean
}

export const ANTHROPIC_MODELS: { label: string; value: string }[] = [
  { label: 'Claude Sonnet 4.6', value: 'anthropic/claude-sonnet-4-6' },
  { label: 'Claude Opus 4.6', value: 'anthropic/claude-opus-4-6' },
  { label: 'Claude Haiku 4.5', value: 'anthropic/claude-haiku-4-5' },
]

export const OPENAI_MODELS: { label: string; value: string }[] = [
  { label: 'GPT-4o', value: 'openai/gpt-4o' },
  { label: 'GPT-4o mini', value: 'openai/gpt-4o-mini' },
  { label: 'o3-mini', value: 'openai/o3-mini' },
]

export const DEFAULT_MODEL = 'anthropic/claude-sonnet-4-6'

export const TERMINAL_STATUSES: AgentStatus[] = ['completed', 'error', 'interrupted']

export async function createAgent(
  workspaceId: string,
  body: CreateOpenCodeAgentRequest,
): Promise<Agent> {
  const res = await fetch(`/api/workspaces/${workspaceId}/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error('Failed to create agent')
  return res.json()
}

export async function listAgents(workspaceId: string): Promise<Agent[]> {
  const res = await fetch(`/api/workspaces/${workspaceId}/agents`)
  if (!res.ok) throw new Error('Failed to list agents')
  return res.json()
}

export async function sendMessage(
  workspaceId: string,
  agentId: string,
  prompt: string,
): Promise<void> {
  const res = await fetch(`/api/workspaces/${workspaceId}/agents/${agentId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  })
  if (!res.ok) throw new Error('Failed to send message')
}

export async function deleteAgent(workspaceId: string, agentId: string): Promise<void> {
  const res = await fetch(`/api/workspaces/${workspaceId}/agents/${agentId}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error('Failed to delete agent')
}

export async function getAgentEvents(
  workspaceId: string,
  agentId: string,
  since: number = 0,
): Promise<AgentEvent[]> {
  const res = await fetch(
    `/api/workspaces/${workspaceId}/agents/${agentId}/events?since=${since}`,
  )
  if (!res.ok) throw new Error('Failed to fetch agent events')
  return res.json()
}

export async function sendFeedback(
  workspaceId: string,
  agentId: string,
  feedbackId: string,
  feedbackType: string,
  response: string,
): Promise<void> {
  const res = await fetch(
    `/api/workspaces/${workspaceId}/agents/${agentId}/feedback`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        feedback_id: feedbackId,
        feedback_type: feedbackType,
        response,
      }),
    },
  )
  if (!res.ok) throw new Error('Failed to send feedback')
}

export async function streamAgentEvents(
  workspaceId: string,
  agentId: string,
  since: number,
  onEvent: (event: AgentEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(
    `/api/workspaces/${workspaceId}/agents/${agentId}/events/stream?since=${since}`,
    { signal },
  )
  if (!res.ok || !res.body) return

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // Process complete SSE messages (delimited by \n\n)
      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const message = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        for (const line of message.split('\n')) {
          if (line.startsWith('data: ')) {
            try {
              onEvent(JSON.parse(line.slice(6)))
            } catch {}
          }
        }
      }
    }
  } catch (err) {
    if (!signal.aborted) throw err
  }
}
