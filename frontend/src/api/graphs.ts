const BASE = '/api'

export type NodeType = 'nop' | 'agent'

export interface AgentConfig {
  agent_type: string
  model: string
  prompt: string
}

export interface GraphNode {
  id: string
  graph_id: string
  node_type: NodeType
  name: string | null
  agent_config: AgentConfig | null
  created_at: string
}

export interface GraphEdge {
  id: string
  graph_id: string
  from_node_id: string
  to_node_id: string
  created_at: string
}

export interface Graph {
  id: string
  workspace_id: string
  name: string
  created_at: string
  updated_at: string
}

export interface GraphDetail extends Graph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

async function _check(res: Response): Promise<Response> {
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`${res.status}: ${text}`)
  }
  return res
}

export async function listGraphs(workspaceId: string): Promise<Graph[]> {
  const res = await fetch(`${BASE}/workspaces/${workspaceId}/graphs`)
  await _check(res)
  return res.json()
}

export async function createGraph(workspaceId: string, name: string): Promise<GraphDetail> {
  const res = await fetch(`${BASE}/workspaces/${workspaceId}/graphs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, nodes: [{ node_type: 'nop' }], edges: [] }),
  })
  await _check(res)
  return res.json()
}

export async function deleteGraph(workspaceId: string, graphId: string): Promise<void> {
  const res = await fetch(`${BASE}/workspaces/${workspaceId}/graphs/${graphId}`, {
    method: 'DELETE',
  })
  await _check(res)
}

export async function getGraph(workspaceId: string, graphId: string): Promise<GraphDetail> {
  const res = await fetch(`${BASE}/workspaces/${workspaceId}/graphs/${graphId}`)
  await _check(res)
  return res.json()
}

export async function addNode(
  workspaceId: string,
  graphId: string,
  name?: string,
): Promise<GraphNode> {
  const res = await fetch(`${BASE}/workspaces/${workspaceId}/graphs/${graphId}/nodes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ node_type: 'nop', name: name ?? null }),
  })
  await _check(res)
  return res.json()
}

export async function deleteNode(
  workspaceId: string,
  graphId: string,
  nodeId: string,
): Promise<void> {
  const res = await fetch(
    `${BASE}/workspaces/${workspaceId}/graphs/${graphId}/nodes/${nodeId}`,
    { method: 'DELETE' },
  )
  await _check(res)
}

export async function addEdge(
  workspaceId: string,
  graphId: string,
  fromNodeId: string,
  toNodeId: string,
): Promise<GraphEdge> {
  const res = await fetch(`${BASE}/workspaces/${workspaceId}/graphs/${graphId}/edges`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from_node_id: fromNodeId, to_node_id: toNodeId }),
  })
  await _check(res)
  return res.json()
}

export async function deleteEdge(
  workspaceId: string,
  graphId: string,
  edgeId: string,
): Promise<void> {
  const res = await fetch(
    `${BASE}/workspaces/${workspaceId}/graphs/${graphId}/edges/${edgeId}`,
    { method: 'DELETE' },
  )
  await _check(res)
}

export async function patchNode(
  workspaceId: string,
  graphId: string,
  nodeId: string,
  patch: { name?: string; node_type?: NodeType; agent_config?: AgentConfig },
): Promise<GraphNode> {
  const res = await fetch(
    `${BASE}/workspaces/${workspaceId}/graphs/${graphId}/nodes/${nodeId}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    },
  )
  await _check(res)
  return res.json()
}
