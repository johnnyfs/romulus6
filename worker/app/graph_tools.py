"""Write opencode custom tool files for graph management into a workspace."""

import os

TOOL_PREAMBLE = """\
import {{ tool }} from "@opencode-ai/plugin"

const BACKEND_URL = "{backend_url}"
const WORKSPACE_ID = "{workspace_id}"

function baseUrl() {{
  return `${{BACKEND_URL}}/workspaces/${{WORKSPACE_ID}}`
}}

async function api(path: string, init?: RequestInit) {{
  const resp = await fetch(`${{baseUrl()}}${{path}}`, {{
    ...init,
    headers: {{ "Content-Type": "application/json", ...init?.headers }},
  }})
  const text = await resp.text()
  if (!resp.ok) throw new Error(`API ${{resp.status}}: ${{text}}`)
  if (!text) return {{ ok: true }}
  return JSON.parse(text)
}}
"""

TOOL_CREATE = TOOL_PREAMBLE + """
export default tool({{
  description: "Create a graph, node, edge, task_template, subgraph_template, subgraph_template_node, or subgraph_template_edge in the Romulus workspace.",
  args: {{
    entity: tool.schema.enum(["graph", "node", "edge", "task_template", "subgraph_template", "subgraph_template_node", "subgraph_template_edge"]).describe("Type of entity to create"),
    params: tool.schema.record(tool.schema.string(), tool.schema.any()).describe(
      "For graph: {{name, nodes?, edges?}}. " +
      "For node: {{graph_id, node_type, name?, agent_config?, command_config?}}. " +
      "For edge: {{graph_id, from_node_id, to_node_id}}. " +
      "For task_template: {{name, task_type, agent_type?, model?, prompt?, command?, graph_tools?, arguments?}}. " +
      "For subgraph_template: {{name, nodes?, edges?, arguments?}}. " +
      "For subgraph_template_node: {{subgraph_template_id, node_type, name?, task_template_id?, ref_subgraph_template_id?, argument_bindings?}}. " +
      "For subgraph_template_edge: {{subgraph_template_id, from_node_id, to_node_id}}"
    ),
  }},
  async execute(args) {{
    const {{ entity, params }} = args
    if (entity === "graph") {{
      const result = await api("/graphs", {{ method: "POST", body: JSON.stringify(params) }})
      return JSON.stringify(result, null, 2)
    }}
    if (entity === "node") {{
      const {{ graph_id, ...rest }} = params
      if (!graph_id) throw new Error("graph_id is required for node creation")
      const result = await api(`/graphs/${{graph_id}}/nodes`, {{ method: "POST", body: JSON.stringify(rest) }})
      return JSON.stringify(result, null, 2)
    }}
    if (entity === "edge") {{
      const {{ graph_id, ...rest }} = params
      if (!graph_id) throw new Error("graph_id is required for edge creation")
      const result = await api(`/graphs/${{graph_id}}/edges`, {{ method: "POST", body: JSON.stringify(rest) }})
      return JSON.stringify(result, null, 2)
    }}
    if (entity === "task_template") {{
      const result = await api("/task-templates", {{ method: "POST", body: JSON.stringify(params) }})
      return JSON.stringify(result, null, 2)
    }}
    if (entity === "subgraph_template") {{
      const result = await api("/subgraph-templates", {{ method: "POST", body: JSON.stringify(params) }})
      return JSON.stringify(result, null, 2)
    }}
    if (entity === "subgraph_template_node") {{
      const {{ subgraph_template_id, ...rest }} = params
      if (!subgraph_template_id) throw new Error("subgraph_template_id is required")
      const result = await api(`/subgraph-templates/${{subgraph_template_id}}/nodes`, {{ method: "POST", body: JSON.stringify(rest) }})
      return JSON.stringify(result, null, 2)
    }}
    if (entity === "subgraph_template_edge") {{
      const {{ subgraph_template_id, ...rest }} = params
      if (!subgraph_template_id) throw new Error("subgraph_template_id is required")
      const result = await api(`/subgraph-templates/${{subgraph_template_id}}/edges`, {{ method: "POST", body: JSON.stringify(rest) }})
      return JSON.stringify(result, null, 2)
    }}
    throw new Error(`Unknown entity: ${{entity}}`)
  }},
}})
"""

TOOL_GET = TOOL_PREAMBLE + """
export default tool({{
  description: "Get a graph, node, edge, task_template, subgraph_template, subgraph_template_node, or subgraph_template_edge. Omit id to list all.",
  args: {{
    entity: tool.schema.enum(["graph", "node", "edge", "task_template", "subgraph_template", "subgraph_template_node", "subgraph_template_edge"]).describe("Type of entity to get"),
    id: tool.schema.string().optional().describe("UUID of the entity. Omit to list all."),
    graph_id: tool.schema.string().optional().describe("Parent graph UUID (required for node/edge)"),
    subgraph_template_id: tool.schema.string().optional().describe("Parent subgraph template UUID (required for subgraph_template_node/edge)"),
  }},
  async execute(args) {{
    const {{ entity, id, graph_id, subgraph_template_id }} = args
    if (entity === "graph") {{
      if (id) return JSON.stringify(await api(`/graphs/${{id}}`), null, 2)
      return JSON.stringify(await api("/graphs"), null, 2)
    }}
    if (entity === "node" || entity === "edge") {{
      const gid = graph_id
      if (!gid) throw new Error("graph_id is required for node/edge lookup")
      const graph = await api(`/graphs/${{gid}}`)
      if (entity === "node") {{
        if (id) {{ const node = graph.nodes?.find((n: any) => n.id === id); if (!node) throw new Error(`Node ${{id}} not found`); return JSON.stringify(node, null, 2) }}
        return JSON.stringify(graph.nodes ?? [], null, 2)
      }}
      if (id) {{ const edge = graph.edges?.find((e: any) => e.id === id); if (!edge) throw new Error(`Edge ${{id}} not found`); return JSON.stringify(edge, null, 2) }}
      return JSON.stringify(graph.edges ?? [], null, 2)
    }}
    if (entity === "task_template") {{
      if (id) return JSON.stringify(await api(`/task-templates/${{id}}`), null, 2)
      return JSON.stringify(await api("/task-templates"), null, 2)
    }}
    if (entity === "subgraph_template") {{
      if (id) return JSON.stringify(await api(`/subgraph-templates/${{id}}`), null, 2)
      return JSON.stringify(await api("/subgraph-templates"), null, 2)
    }}
    if (entity === "subgraph_template_node" || entity === "subgraph_template_edge") {{
      const stid = subgraph_template_id
      if (!stid) throw new Error("subgraph_template_id is required")
      const tmpl = await api(`/subgraph-templates/${{stid}}`)
      const items = entity === "subgraph_template_node" ? tmpl.nodes : tmpl.edges
      if (id) {{ const item = items?.find((x: any) => x.id === id); if (!item) throw new Error(`${{entity}} ${{id}} not found`); return JSON.stringify(item, null, 2) }}
      return JSON.stringify(items ?? [], null, 2)
    }}
    throw new Error(`Unknown entity: ${{entity}}`)
  }},
}})
"""

TOOL_DELETE = TOOL_PREAMBLE + """
export default tool({{
  description: "Delete a graph, node, edge, task_template, subgraph_template, subgraph_template_node, or subgraph_template_edge.",
  args: {{
    entity: tool.schema.enum(["graph", "node", "edge", "task_template", "subgraph_template", "subgraph_template_node", "subgraph_template_edge"]).describe("Type of entity to delete"),
    id: tool.schema.string().describe("UUID of the entity to delete"),
    graph_id: tool.schema.string().optional().describe("Parent graph UUID (required for node/edge)"),
    subgraph_template_id: tool.schema.string().optional().describe("Parent subgraph template UUID (required for subgraph_template_node/edge)"),
  }},
  async execute(args) {{
    const {{ entity, id, graph_id, subgraph_template_id }} = args
    if (entity === "graph") {{ await api(`/graphs/${{id}}`, {{ method: "DELETE" }}); return `Graph ${{id}} deleted.` }}
    if (entity === "node") {{ if (!graph_id) throw new Error("graph_id required"); await api(`/graphs/${{graph_id}}/nodes/${{id}}`, {{ method: "DELETE" }}); return `Node ${{id}} deleted.` }}
    if (entity === "edge") {{ if (!graph_id) throw new Error("graph_id required"); await api(`/graphs/${{graph_id}}/edges/${{id}}`, {{ method: "DELETE" }}); return `Edge ${{id}} deleted.` }}
    if (entity === "task_template") {{ await api(`/task-templates/${{id}}`, {{ method: "DELETE" }}); return `Task template ${{id}} deleted.` }}
    if (entity === "subgraph_template") {{ await api(`/subgraph-templates/${{id}}`, {{ method: "DELETE" }}); return `Subgraph template ${{id}} deleted.` }}
    if (entity === "subgraph_template_node") {{ if (!subgraph_template_id) throw new Error("subgraph_template_id required"); await api(`/subgraph-templates/${{subgraph_template_id}}/nodes/${{id}}`, {{ method: "DELETE" }}); return `Node ${{id}} deleted.` }}
    if (entity === "subgraph_template_edge") {{ if (!subgraph_template_id) throw new Error("subgraph_template_id required"); await api(`/subgraph-templates/${{subgraph_template_id}}/edges/${{id}}`, {{ method: "DELETE" }}); return `Edge ${{id}} deleted.` }}
    throw new Error(`Unknown entity: ${{entity}}`)
  }},
}})
"""

TOOL_EDIT = TOOL_PREAMBLE + """
export default tool({{
  description: "Edit a graph, node, task_template, subgraph_template, or subgraph_template_node. Edges cannot be edited (delete and recreate instead).",
  args: {{
    entity: tool.schema.enum(["graph", "node", "task_template", "subgraph_template", "subgraph_template_node"]).describe("Type of entity to edit"),
    id: tool.schema.string().describe("UUID of the entity to edit"),
    params: tool.schema.record(tool.schema.string(), tool.schema.any()).describe("Update fields"),
    graph_id: tool.schema.string().optional().describe("Parent graph UUID (required for node)"),
    subgraph_template_id: tool.schema.string().optional().describe("Parent subgraph template UUID (required for subgraph_template_node)"),
  }},
  async execute(args) {{
    const {{ entity, id, params, graph_id, subgraph_template_id }} = args
    if (entity === "graph") return JSON.stringify(await api(`/graphs/${{id}}`, {{ method: "PUT", body: JSON.stringify(params) }}), null, 2)
    if (entity === "node") {{ if (!graph_id) throw new Error("graph_id required"); return JSON.stringify(await api(`/graphs/${{graph_id}}/nodes/${{id}}`, {{ method: "PATCH", body: JSON.stringify(params) }}), null, 2) }}
    if (entity === "task_template") return JSON.stringify(await api(`/task-templates/${{id}}`, {{ method: "PUT", body: JSON.stringify(params) }}), null, 2)
    if (entity === "subgraph_template") return JSON.stringify(await api(`/subgraph-templates/${{id}}`, {{ method: "PUT", body: JSON.stringify(params) }}), null, 2)
    if (entity === "subgraph_template_node") {{ if (!subgraph_template_id) throw new Error("subgraph_template_id required"); return JSON.stringify(await api(`/subgraph-templates/${{subgraph_template_id}}/nodes/${{id}}`, {{ method: "PATCH", body: JSON.stringify(params) }}), null, 2) }}
    throw new Error(`Unknown entity: ${{entity}}. Edges cannot be edited; delete and recreate instead.`)
  }},
}})
"""

TOOL_DESCRIBE = """\
import {{ tool }} from "@opencode-ai/plugin"

const SCHEMAS: Record<string, object> = {{
  graph: {{
    entity: "graph",
    description: "A directed acyclic graph (DAG) containing nodes and edges within a workspace.",
    create_params: {{
      name: {{ type: "string", required: true, description: "Unique name within the workspace" }},
      nodes: {{ type: "array", required: false, items: {{ node_type: {{ type: "string", enum: ["agent", "command"] }}, name: {{ type: "string", required: false }}, agent_config: {{ type: "object", required: false }}, command_config: {{ type: "object", required: false }} }} }},
      edges: {{ type: "array", required: false, items: {{ from_index: {{ type: "integer" }}, to_index: {{ type: "integer" }} }} }},
    }},
    constraints: ["Graph names must be unique within a workspace", "Must be a DAG (no cycles)"],
  }},
  node: {{
    entity: "node",
    description: "A node in a graph. Can be an agent dispatch or a command execution.",
    create_params: {{ graph_id: {{ type: "string (UUID)", required: true }}, node_type: {{ type: "string", enum: ["agent", "command"], required: true }}, name: {{ type: "string", required: false }}, agent_config: {{ type: "object", required: false }}, command_config: {{ type: "object", required: false }} }},
    constraints: ["Node names must be unique within a graph"],
  }},
  edge: {{
    entity: "edge",
    description: "A directed edge connecting two nodes in the same graph.",
    create_params: {{ graph_id: {{ type: "string (UUID)", required: true }}, from_node_id: {{ type: "string (UUID)", required: true }}, to_node_id: {{ type: "string (UUID)", required: true }} }},
    constraints: ["Both nodes must belong to the same graph", "Must not create a cycle"],
  }},
  task_template: {{
    entity: "task_template",
    description: "A reusable, parameterized task definition. Supports {{{{ argument }}}} variable substitution and {{% if bool_arg %}}...{{% endif %}} conditionals (Jinja2) in text fields.",
    create_params: {{
      name: {{ type: "string", required: true }},
      task_type: {{ type: "string", enum: ["agent", "command"], required: true }},
      agent_type: {{ type: "string", required: false }},
      model: {{ type: "string", required: false, description: "Model ID or {{{{ arg }}}} placeholder" }},
      prompt: {{ type: "string", required: false }},
      command: {{ type: "string", required: false }},
      graph_tools: {{ type: "boolean", default: false }},
      arguments: {{ type: "array", required: false, items: {{ name: {{ type: "string" }}, arg_type: {{ type: "string", enum: ["string", "model_type", "boolean"] }}, default_value: {{ type: "string", required: false, description: "For boolean args: 'true' or 'false'" }}, model_constraint: {{ type: "array of strings", required: false, description: "Only for model_type args" }} }} }},
    }},
    constraints: ["Template names must be unique within a workspace"],
  }},
  subgraph_template: {{
    entity: "subgraph_template",
    description: "A reusable, parameterized graph template. Nodes reference task_templates or other subgraph_templates. Supports {{{{ argument }}}} substitution and {{% if bool_arg %}}...{{% endif %}} conditionals (Jinja2) in text fields.",
    create_params: {{
      name: {{ type: "string", required: true }},
      nodes: {{ type: "array", required: false, items: {{ node_type: {{ type: "string", enum: ["task_template", "subgraph_template"] }}, name: {{ type: "string", required: false }}, task_template_id: {{ type: "string (UUID)", required: false }}, ref_subgraph_template_id: {{ type: "string (UUID)", required: false }}, argument_bindings: {{ type: "object", required: false }} }} }},
      edges: {{ type: "array", required: false, items: {{ from_index: {{ type: "integer" }}, to_index: {{ type: "integer" }} }} }},
      arguments: {{ type: "array", required: false, items: {{ name: {{ type: "string" }}, arg_type: {{ type: "string", enum: ["string", "model_type", "boolean"] }}, default_value: {{ type: "string", required: false, description: "For boolean args: 'true' or 'false'" }}, model_constraint: {{ type: "array of strings", required: false, description: "Only for model_type args" }} }} }},
    }},
    constraints: ["Names must be unique within a workspace", "Must be a DAG (no edge cycles)", "No recursive subgraph template references"],
  }},
  subgraph_template_node: {{
    entity: "subgraph_template_node",
    description: "A node in a subgraph template. References either a task_template or another subgraph_template.",
    create_params: {{ subgraph_template_id: {{ type: "string (UUID)", required: true }}, node_type: {{ type: "string", enum: ["task_template", "subgraph_template"], required: true }}, name: {{ type: "string", required: false }}, task_template_id: {{ type: "string (UUID)", required: false }}, ref_subgraph_template_id: {{ type: "string (UUID)", required: false }}, argument_bindings: {{ type: "object", required: false }} }},
    constraints: ["Node names must be unique within the subgraph template", "Cannot create recursive subgraph references"],
  }},
  subgraph_template_edge: {{
    entity: "subgraph_template_edge",
    description: "A directed edge connecting two nodes in a subgraph template.",
    create_params: {{ subgraph_template_id: {{ type: "string (UUID)", required: true }}, from_node_id: {{ type: "string (UUID)", required: true }}, to_node_id: {{ type: "string (UUID)", required: true }} }},
    constraints: ["Both nodes must belong to the same subgraph template", "Must not create a cycle"],
  }},
}}

export default tool({{
  description: "Describe the schema of a Romulus entity. Returns field definitions, types, and constraints.",
  args: {{
    entity: tool.schema.enum(["graph", "node", "edge", "task_template", "subgraph_template", "subgraph_template_node", "subgraph_template_edge"]).describe("Entity type to describe"),
  }},
  async execute(args) {{
    const schema = SCHEMAS[args.entity]
    if (!schema) throw new Error(`Unknown entity: ${{args.entity}}`)
    return JSON.stringify(schema, null, 2)
  }},
}})
"""

TOOLS = {
    "romulus__graph_create.ts": TOOL_CREATE,
    "romulus__graph_get.ts": TOOL_GET,
    "romulus__graph_delete.ts": TOOL_DELETE,
    "romulus__graph_edit.ts": TOOL_EDIT,
    "romulus__graph_describe.ts": TOOL_DESCRIBE,
}


def write_graph_tools(workspace_dir: str, workspace_id: str, backend_url: str) -> None:
    """Write the 5 graph management tool files into the workspace's .opencode/tools/ dir."""
    tools_dir = os.path.join(workspace_dir, ".opencode", "tools")
    os.makedirs(tools_dir, exist_ok=True)

    for filename, template in TOOLS.items():
        content = template.format(
            backend_url=backend_url,
            workspace_id=workspace_id,
        )
        path = os.path.join(tools_dir, filename)
        with open(path, "w") as f:
            f.write(content)
