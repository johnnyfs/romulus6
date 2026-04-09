const BASE = '/api'

export type NodeType = 'agent' | 'command' | 'task_template' | 'subgraph_template'

export interface OpenCodeAgentConfig {
  agent_type: 'opencode'
  model: string
  prompt: string
  graph_tools?: boolean
}

export interface PydanticAgentConfig {
  agent_type: 'pydantic'
  model: string
  prompt: string
}

export interface CodexAgentConfig {
  agent_type: 'codex'
  model: string
  prompt: string
  graph_tools?: boolean
}

export type AgentConfig = OpenCodeAgentConfig | PydanticAgentConfig | CodexAgentConfig

export interface CommandConfig {
  command: string
}

export interface GraphNode {
  id: string
  graph_id: string
  node_type: NodeType
  name: string | null
  agent_config: AgentConfig | null
  command_config: CommandConfig | null
  task_template_id: string | null
  subgraph_template_id: string | null
  argument_bindings: Record<string, string> | null
  output_schema: Record<string, string> | null
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

export type RunNodeState = 'pending' | 'running' | 'completed' | 'error'
export type RunState = 'pending' | 'running' | 'completed' | 'error'

export interface GraphRunNode {
  id: string
  run_id: string
  source_node_id: string | null
  source_type: string
  node_type: string
  name: string | null
  state: RunNodeState
  agent_config: AgentConfig | null
  command_config: CommandConfig | null
  child_run_id: string | null
  output_schema: Record<string, string> | null
  output: Record<string, unknown> | null
  created_at: string
}

export interface GraphRunEdge {
  id: string
  run_id: string
  from_run_node_id: string
  to_run_node_id: string
  created_at: string
}

export interface GraphRun {
  id: string
  graph_id: string | null
  workspace_id: string
  state: RunState
  sandbox_id: string | null
  parent_run_node_id: string | null
  source_template_id: string | null
  created_at: string
  run_nodes: GraphRunNode[]
  run_edges: GraphRunEdge[]
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
    body: JSON.stringify({ name, nodes: [], edges: [] }),
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
  nodeType: NodeType,
  name?: string,
  extra?: {
    agent_config?: AgentConfig
    command_config?: CommandConfig

    task_template_id?: string
    subgraph_template_id?: string
    argument_bindings?: Record<string, string>
    output_schema?: Record<string, string>
  },
): Promise<GraphNode> {
  const res = await fetch(`${BASE}/workspaces/${workspaceId}/graphs/${graphId}/nodes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ node_type: nodeType, name: name ?? null, ...extra }),
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
  patch: {
    name?: string
    node_type?: NodeType
    agent_config?: AgentConfig
    command_config?: CommandConfig

    task_template_id?: string
    subgraph_template_id?: string
    argument_bindings?: Record<string, string>
    output_schema?: Record<string, string>
  },
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

export async function listRuns(workspaceId: string, graphId: string): Promise<GraphRun[]> {
  const res = await fetch(`${BASE}/workspaces/${workspaceId}/graphs/${graphId}/runs`)
  await _check(res)
  return res.json()
}

export async function createRun(workspaceId: string, graphId: string): Promise<GraphRun> {
  const res = await fetch(`${BASE}/workspaces/${workspaceId}/graphs/${graphId}/runs`, {
    method: 'POST',
  })
  await _check(res)
  return res.json()
}

export async function getRun(workspaceId: string, graphId: string, runId: string): Promise<GraphRun> {
  const res = await fetch(`${BASE}/workspaces/${workspaceId}/graphs/${graphId}/runs/${runId}`)
  await _check(res)
  return res.json()
}

export async function getRunById(workspaceId: string, runId: string): Promise<GraphRun> {
  const res = await fetch(`${BASE}/workspaces/${workspaceId}/runs/${runId}`)
  await _check(res)
  return res.json()
}

export async function syncRunNode(
  workspaceId: string,
  runId: string,
  nodeId: string,
): Promise<GraphRun> {
  const res = await fetch(
    `${BASE}/workspaces/${workspaceId}/runs/${runId}/nodes/${nodeId}/sync`,
    { method: 'POST' },
  )
  await _check(res)
  return res.json()
}

export async function patchRunNode(
  workspaceId: string,
  runId: string,
  nodeId: string,
  patch: { state?: RunNodeState },
): Promise<GraphRun> {
  const res = await fetch(
    `${BASE}/workspaces/${workspaceId}/runs/${runId}/nodes/${nodeId}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    },
  )
  await _check(res)
  return res.json()
}
