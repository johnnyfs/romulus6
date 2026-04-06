import type { AgentEvent } from './agents'

export interface WorkspaceEvent extends AgentEvent {
  workspace_id: string
}

export async function listWorkspaceEvents(
  workspaceId: string,
  since: number = 0,
  limit: number = 200,
): Promise<WorkspaceEvent[]> {
  const res = await fetch(
    `/api/workspaces/${workspaceId}/events?since=${since}&limit=${limit}`,
  )
  if (!res.ok) throw new Error('Failed to fetch workspace events')
  const raw = await res.json()
  return raw.map((item: any) => ({
    id: item.id,
    session_id: item.session_id ?? '',
    type: item.type,
    timestamp: item.event_time,
    received_at: item.received_at,
              data: item.data ?? {},
              source_name: item.source_name ?? null,
              agent_id: item.agent_id ?? null,
              run_id: item.run_id ?? null,
              node_id: item.node_id ?? null,
              sandbox_id: item.sandbox_id ?? null,
              worker_id: item.worker_id ?? null,
              source_id: item.source_id ?? null,
              source_type: item.source_type ?? null,
              display_label: item.display_label ?? null,
              path_parts: item.path_parts ?? [],
              stream_key: item.stream_key ?? null,
              workspace_id: item.workspace_id,
            }))
}

export async function streamWorkspaceEvents(
  workspaceId: string,
  since: number,
  onEvent: (event: WorkspaceEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(
    `/api/workspaces/${workspaceId}/events/stream?since=${since}`,
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
      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const message = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        for (const line of message.split('\n')) {
          if (line.startsWith('data: ')) {
            try {
              const item = JSON.parse(line.slice(6))
              onEvent({
                id: item.id,
                session_id: item.session_id ?? '',
                type: item.type,
                timestamp: item.event_time,
                received_at: item.received_at,
                data: item.data ?? {},
                source_name: item.source_name ?? null,
                agent_id: item.agent_id ?? null,
                run_id: item.run_id ?? null,
                node_id: item.node_id ?? null,
                sandbox_id: item.sandbox_id ?? null,
                worker_id: item.worker_id ?? null,
                source_id: item.source_id ?? null,
                source_type: item.source_type ?? null,
                display_label: item.display_label ?? null,
                path_parts: item.path_parts ?? [],
                stream_key: item.stream_key ?? null,
                workspace_id: item.workspace_id,
              })
            } catch {}
          }
        }
      }
    }
  } catch (err) {
    if (!signal.aborted) throw err
  }
}
