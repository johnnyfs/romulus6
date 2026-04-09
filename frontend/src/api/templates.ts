import type { AgentConfig, CommandConfig, NodeType } from './graphs'
import type { SandboxMode } from './models'

const BASE = '/api'

export type TaskTemplateArgType = 'string' | 'model_type' | 'boolean' | 'number' | 'enum' | 'schema'
export type SubgraphTemplateNodeType = NodeType

export interface TaskTemplateArgument {
  id: string
  name: string
  arg_type: TaskTemplateArgType
  default_value: string | null
  model_constraint: string[] | null
  min_value: number | null
  max_value: number | null
  enum_options: string[] | null
  schema_template_id: string | null
  container: string | null // "list" | "map" | null
  created_at: string
}

export interface TaskTemplate {
  id: string
  workspace_id: string
  name: string
  label: string | null
  task_type: NodeType
  agent_type: string | null
  model: string | null
  prompt: string | null
  command: string | null
  graph_tools: boolean
  sandbox_mode?: SandboxMode | null
  arguments: TaskTemplateArgument[]
  output_schema?: Record<string, string> | null
  image_attachments?: unknown[] | null
  created_at: string
  updated_at: string
}

export interface SubgraphTemplateNode {
  id: string
  subgraph_template_id: string
  node_type: SubgraphTemplateNodeType
  name: string | null
  agent_config: AgentConfig | null
  command_config: CommandConfig | null
  task_template_id: string | null
  ref_subgraph_template_id: string | null
  argument_bindings: Record<string, string> | null
  output_schema?: Record<string, string> | null
  created_at: string
}

export interface SubgraphTemplateEdge {
  id: string
  subgraph_template_id: string
  from_node_id: string
  to_node_id: string
  created_at: string
}

export interface SubgraphTemplate {
  id: string
  workspace_id: string
  name: string
  label: string | null
  created_at: string
  updated_at: string
}

export interface SubgraphTemplateDetail extends SubgraphTemplate {
  nodes: SubgraphTemplateNode[]
  edges: SubgraphTemplateEdge[]
  arguments: TaskTemplateArgument[]
  output_schema?: Record<string, string> | null
}

// ── Schema Templates ───────────────────────────────────────────────────────

export interface SchemaTemplate {
  id: string
  workspace_id: string
  name: string
  fields: Record<string, string> | null
  created_at: string
  updated_at: string
}

export type ContainerKind = 'value' | 'list' | 'map'

export const CONTAINER_OPTIONS: { value: ContainerKind; label: string }[] = [
  { value: 'value', label: 'value' },
  { value: 'list', label: 'list' },
  { value: 'map', label: 'map' },
]

/** Parse a composed type string into container and base parts. */
export function parseTypeValue(value: string): { container: ContainerKind; base: string } {
  if (value.startsWith('list:')) return { container: 'list', base: value.slice(5) }
  if (value.startsWith('map:')) return { container: 'map', base: value.slice(4) }
  return { container: 'value', base: value }
}

/** Compose container and base parts back into a type string. */
export function composeTypeValue(container: ContainerKind, base: string): string {
  if (container === 'list') return `list:${base}`
  if (container === 'map') return `map:${base}`
  return base
}

/** Build base type options (primitives + schema templates, no container variants). */
export function buildBaseTypeOptions(
  schemaTemplates: SchemaTemplate[],
  excludeId?: string,
): { value: string; label: string }[] {
  const options: { value: string; label: string }[] = [
    { value: 'string', label: 'string' },
    { value: 'number', label: 'number' },
    { value: 'boolean', label: 'boolean' },
    { value: 'image', label: 'image' },
  ]
  for (const st of schemaTemplates) {
    if (st.id === excludeId) continue
    options.push({ value: `schema:${st.id}`, label: st.name })
  }
  return options
}

/**
 * Display label for a type value string. Resolves schema UUIDs to names.
 */
export function typeDisplayLabel(value: string, schemaTemplates: SchemaTemplate[]): string {
  const schemasById = new Map(schemaTemplates.map(s => [s.id, s.name]))

  const labelForBase = (base: string): string => {
    if (base.startsWith('schema:')) {
      const id = base.slice('schema:'.length)
      return schemasById.get(id) ?? 'unknown schema'
    }
    return base
  }

  if (value.startsWith('list:')) {
    return `list of ${labelForBase(value.slice('list:'.length))}`
  }
  if (value.startsWith('map:')) {
    return `map of ${labelForBase(value.slice('map:'.length))}`
  }
  return labelForBase(value)
}


async function _check(res: Response): Promise<Response> {
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`${res.status}: ${text}`)
  }
  return res
}

// ── Task Templates ────────────────────────────────────────────────────────

export async function listTaskTemplates(workspaceId: string): Promise<TaskTemplate[]> {
  const res = await fetch(`${BASE}/workspaces/${workspaceId}/task-templates`)
  await _check(res)
  return res.json()
}

export async function createTaskTemplate(
  workspaceId: string,
  body: {
    name: string
    label?: string
    task_type: NodeType
    agent_type?: string
    model?: string
    prompt?: string
    command?: string
    graph_tools?: boolean
    sandbox_mode?: SandboxMode
    arguments?: { name: string; arg_type?: TaskTemplateArgType; default_value?: string; model_constraint?: string[]; min_value?: number; max_value?: number; enum_options?: string[]; schema_template_id?: string; container?: string }[]
    output_schema?: Record<string, string>
  },
): Promise<TaskTemplate> {
  const res = await fetch(`${BASE}/workspaces/${workspaceId}/task-templates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  await _check(res)
  return res.json()
}

export async function getTaskTemplate(workspaceId: string, templateId: string): Promise<TaskTemplate> {
  const res = await fetch(`${BASE}/workspaces/${workspaceId}/task-templates/${templateId}`)
  await _check(res)
  return res.json()
}

export async function updateTaskTemplate(
  workspaceId: string,
  templateId: string,
  body: {
    name: string
    label?: string
    task_type: NodeType
    agent_type?: string
    model?: string
    prompt?: string
    command?: string
    graph_tools?: boolean
    sandbox_mode?: SandboxMode
    arguments?: { name: string; arg_type?: TaskTemplateArgType; default_value?: string; model_constraint?: string[]; min_value?: number; max_value?: number; enum_options?: string[]; schema_template_id?: string; container?: string }[]
    output_schema?: Record<string, string>
  },
): Promise<TaskTemplate> {
  const res = await fetch(`${BASE}/workspaces/${workspaceId}/task-templates/${templateId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  await _check(res)
  return res.json()
}

export async function deleteTaskTemplate(workspaceId: string, templateId: string): Promise<void> {
  const res = await fetch(`${BASE}/workspaces/${workspaceId}/task-templates/${templateId}`, {
    method: 'DELETE',
  })
  await _check(res)
}

// ── Schema Templates ──────────────────────────────────────────────────────

export async function listSchemaTemplates(workspaceId: string): Promise<SchemaTemplate[]> {
  const res = await fetch(`${BASE}/workspaces/${workspaceId}/schema-templates`)
  await _check(res)
  return res.json()
}

export async function createSchemaTemplate(
  workspaceId: string,
  body: { name: string; fields: Record<string, string> },
): Promise<SchemaTemplate> {
  const res = await fetch(`${BASE}/workspaces/${workspaceId}/schema-templates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  await _check(res)
  return res.json()
}

export async function getSchemaTemplate(workspaceId: string, templateId: string): Promise<SchemaTemplate> {
  const res = await fetch(`${BASE}/workspaces/${workspaceId}/schema-templates/${templateId}`)
  await _check(res)
  return res.json()
}

export async function updateSchemaTemplate(
  workspaceId: string,
  templateId: string,
  body: { name: string; fields: Record<string, string> },
): Promise<SchemaTemplate> {
  const res = await fetch(`${BASE}/workspaces/${workspaceId}/schema-templates/${templateId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  await _check(res)
  return res.json()
}

export async function deleteSchemaTemplate(workspaceId: string, templateId: string): Promise<void> {
  const res = await fetch(`${BASE}/workspaces/${workspaceId}/schema-templates/${templateId}`, {
    method: 'DELETE',
  })
  await _check(res)
}

// ── Subgraph Templates ──────────────────────────────────────────────────────

export async function listSubgraphTemplates(workspaceId: string): Promise<SubgraphTemplate[]> {
  const res = await fetch(`${BASE}/workspaces/${workspaceId}/subgraph-templates`)
  await _check(res)
  return res.json()
}

export async function createSubgraphTemplate(
  workspaceId: string,
  body: {
    name: string
    label?: string
    nodes?: { node_type: SubgraphTemplateNodeType; name?: string; agent_config?: AgentConfig; command_config?: CommandConfig; task_template_id?: string; ref_subgraph_template_id?: string; argument_bindings?: Record<string, string>; output_schema?: Record<string, string> }[]
    edges?: { from_index: number; to_index: number }[]
    arguments?: { name: string; arg_type?: TaskTemplateArgType; default_value?: string; model_constraint?: string[]; min_value?: number; max_value?: number; enum_options?: string[]; schema_template_id?: string; container?: string }[]
    output_schema?: Record<string, string>
  },
): Promise<SubgraphTemplateDetail> {
  const res = await fetch(`${BASE}/workspaces/${workspaceId}/subgraph-templates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  await _check(res)
  return res.json()
}

export async function getSubgraphTemplate(workspaceId: string, templateId: string): Promise<SubgraphTemplateDetail> {
  const res = await fetch(`${BASE}/workspaces/${workspaceId}/subgraph-templates/${templateId}`)
  await _check(res)
  return res.json()
}

export async function updateSubgraphTemplate(
  workspaceId: string,
  templateId: string,
  body: {
    name: string
    label?: string
    nodes?: { node_type: SubgraphTemplateNodeType; name?: string; agent_config?: AgentConfig; command_config?: CommandConfig; task_template_id?: string; ref_subgraph_template_id?: string; argument_bindings?: Record<string, string>; output_schema?: Record<string, string> }[]
    edges?: { from_index: number; to_index: number }[]
    arguments?: { name: string; arg_type?: TaskTemplateArgType; default_value?: string; model_constraint?: string[]; min_value?: number; max_value?: number; enum_options?: string[]; schema_template_id?: string; container?: string }[]
    output_schema?: Record<string, string>
  },
): Promise<SubgraphTemplateDetail> {
  const res = await fetch(`${BASE}/workspaces/${workspaceId}/subgraph-templates/${templateId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  await _check(res)
  return res.json()
}

export async function deleteSubgraphTemplate(workspaceId: string, templateId: string): Promise<void> {
  const res = await fetch(`${BASE}/workspaces/${workspaceId}/subgraph-templates/${templateId}`, {
    method: 'DELETE',
  })
  await _check(res)
}

export async function addSubgraphTemplateNode(
  workspaceId: string,
  templateId: string,
  body: { node_type: SubgraphTemplateNodeType; name?: string; agent_config?: AgentConfig; command_config?: CommandConfig; task_template_id?: string; ref_subgraph_template_id?: string; argument_bindings?: Record<string, string>; output_schema?: Record<string, string> },
): Promise<SubgraphTemplateNode> {
  const res = await fetch(`${BASE}/workspaces/${workspaceId}/subgraph-templates/${templateId}/nodes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  await _check(res)
  return res.json()
}

export async function patchSubgraphTemplateNode(
  workspaceId: string,
  templateId: string,
  nodeId: string,
  patch: { name?: string; node_type?: SubgraphTemplateNodeType; agent_config?: AgentConfig; command_config?: CommandConfig; task_template_id?: string; ref_subgraph_template_id?: string; argument_bindings?: Record<string, string>; output_schema?: Record<string, string> },
): Promise<SubgraphTemplateNode> {
  const res = await fetch(`${BASE}/workspaces/${workspaceId}/subgraph-templates/${templateId}/nodes/${nodeId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  await _check(res)
  return res.json()
}

export async function deleteSubgraphTemplateNode(
  workspaceId: string,
  templateId: string,
  nodeId: string,
): Promise<void> {
  const res = await fetch(`${BASE}/workspaces/${workspaceId}/subgraph-templates/${templateId}/nodes/${nodeId}`, {
    method: 'DELETE',
  })
  await _check(res)
}

export async function addSubgraphTemplateEdge(
  workspaceId: string,
  templateId: string,
  fromNodeId: string,
  toNodeId: string,
): Promise<SubgraphTemplateEdge> {
  const res = await fetch(`${BASE}/workspaces/${workspaceId}/subgraph-templates/${templateId}/edges`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from_node_id: fromNodeId, to_node_id: toNodeId }),
  })
  await _check(res)
  return res.json()
}

export async function deleteSubgraphTemplateEdge(
  workspaceId: string,
  templateId: string,
  edgeId: string,
): Promise<void> {
  const res = await fetch(`${BASE}/workspaces/${workspaceId}/subgraph-templates/${templateId}/edges/${edgeId}`, {
    method: 'DELETE',
  })
  await _check(res)
}
