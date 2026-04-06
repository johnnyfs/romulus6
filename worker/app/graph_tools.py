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
  description: "Create a graph, node, or edge in the Romulus workspace.",
  args: {{
    entity: tool.schema.enum(["graph", "node", "edge"]).describe("Type of entity to create"),
    params: tool.schema.record(tool.schema.string(), tool.schema.any()).describe(
      "For graph: {{name, nodes?, edges?}}. " +
      "For node: {{graph_id, node_type, name?, agent_config?, command_config?}}. " +
      "For edge: {{graph_id, from_node_id, to_node_id}}"
    ),
  }},
  async execute(args) {{
    const {{ entity, params }} = args
    if (entity === "graph") {{
      const result = await api("/graphs", {{
        method: "POST",
        body: JSON.stringify(params),
      }})
      return JSON.stringify(result, null, 2)
    }}
    if (entity === "node") {{
      const {{ graph_id, ...rest }} = params
      if (!graph_id) throw new Error("graph_id is required for node creation")
      const result = await api(`/graphs/${{graph_id}}/nodes`, {{
        method: "POST",
        body: JSON.stringify(rest),
      }})
      return JSON.stringify(result, null, 2)
    }}
    if (entity === "edge") {{
      const {{ graph_id, ...rest }} = params
      if (!graph_id) throw new Error("graph_id is required for edge creation")
      const result = await api(`/graphs/${{graph_id}}/edges`, {{
        method: "POST",
        body: JSON.stringify(rest),
      }})
      return JSON.stringify(result, null, 2)
    }}
    throw new Error(`Unknown entity: ${{entity}}`)
  }},
}})
"""

TOOL_GET = TOOL_PREAMBLE + """
export default tool({{
  description: "Get a graph, node, or edge. Omit id to list all graphs.",
  args: {{
    entity: tool.schema.enum(["graph", "node", "edge"]).describe("Type of entity to get"),
    id: tool.schema.string().optional().describe("UUID of the entity. Omit to list all graphs."),
    graph_id: tool.schema.string().optional().describe("Parent graph UUID (required for node/edge)"),
  }},
  async execute(args) {{
    const {{ entity, id, graph_id }} = args
    if (entity === "graph") {{
      if (id) {{
        const result = await api(`/graphs/${{id}}`)
        return JSON.stringify(result, null, 2)
      }}
      const result = await api("/graphs")
      return JSON.stringify(result, null, 2)
    }}
    if (entity === "node" || entity === "edge") {{
      const gid = graph_id
      if (!gid) throw new Error("graph_id is required for node/edge lookup")
      const graph = await api(`/graphs/${{gid}}`)
      if (entity === "node") {{
        if (id) {{
          const node = graph.nodes?.find((n: any) => n.id === id)
          if (!node) throw new Error(`Node ${{id}} not found in graph ${{gid}}`)
          return JSON.stringify(node, null, 2)
        }}
        return JSON.stringify(graph.nodes ?? [], null, 2)
      }}
      if (id) {{
        const edge = graph.edges?.find((e: any) => e.id === id)
        if (!edge) throw new Error(`Edge ${{id}} not found in graph ${{gid}}`)
        return JSON.stringify(edge, null, 2)
      }}
      return JSON.stringify(graph.edges ?? [], null, 2)
    }}
    throw new Error(`Unknown entity: ${{entity}}`)
  }},
}})
"""

TOOL_DELETE = TOOL_PREAMBLE + """
export default tool({{
  description: "Delete a graph, node, or edge.",
  args: {{
    entity: tool.schema.enum(["graph", "node", "edge"]).describe("Type of entity to delete"),
    id: tool.schema.string().describe("UUID of the entity to delete"),
    graph_id: tool.schema.string().optional().describe("Parent graph UUID (required for node/edge)"),
  }},
  async execute(args) {{
    const {{ entity, id, graph_id }} = args
    if (entity === "graph") {{
      await api(`/graphs/${{id}}`, {{ method: "DELETE" }})
      return `Graph ${{id}} deleted.`
    }}
    if (entity === "node") {{
      if (!graph_id) throw new Error("graph_id is required for node deletion")
      await api(`/graphs/${{graph_id}}/nodes/${{id}}`, {{ method: "DELETE" }})
      return `Node ${{id}} deleted.`
    }}
    if (entity === "edge") {{
      if (!graph_id) throw new Error("graph_id is required for edge deletion")
      await api(`/graphs/${{graph_id}}/edges/${{id}}`, {{ method: "DELETE" }})
      return `Edge ${{id}} deleted.`
    }}
    throw new Error(`Unknown entity: ${{entity}}`)
  }},
}})
"""

TOOL_EDIT = TOOL_PREAMBLE + """
export default tool({{
  description: "Edit a graph or node. Edges cannot be edited (delete and recreate instead).",
  args: {{
    entity: tool.schema.enum(["graph", "node"]).describe("Type of entity to edit"),
    id: tool.schema.string().describe("UUID of the entity to edit"),
    params: tool.schema.record(tool.schema.string(), tool.schema.any()).describe(
      "For graph: {{name, nodes, edges}} (full replacement). " +
      "For node: partial update fields {{name?, node_type?, agent_config?, command_config?}}"
    ),
    graph_id: tool.schema.string().optional().describe("Parent graph UUID (required for node)"),
  }},
  async execute(args) {{
    const {{ entity, id, params, graph_id }} = args
    if (entity === "graph") {{
      const result = await api(`/graphs/${{id}}`, {{
        method: "PUT",
        body: JSON.stringify(params),
      }})
      return JSON.stringify(result, null, 2)
    }}
    if (entity === "node") {{
      if (!graph_id) throw new Error("graph_id is required for node editing")
      const result = await api(`/graphs/${{graph_id}}/nodes/${{id}}`, {{
        method: "PATCH",
        body: JSON.stringify(params),
      }})
      return JSON.stringify(result, null, 2)
    }}
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
      nodes: {{
        type: "array",
        required: false,
        description: "Nodes to create with the graph",
        items: {{
          node_type: {{ type: "string", enum: ["agent", "command"] }},
          name: {{ type: "string", required: false }},
          agent_config: {{
            type: "object",
            required: false,
            description: "Required when node_type=agent",
            fields: {{
              agent_type: {{ type: "string", enum: ["opencode"], default: "opencode" }},
              model: {{
                type: "string",
                enum: [
                  "anthropic/claude-sonnet-4-6", "anthropic/claude-opus-4-6", "anthropic/claude-haiku-4-5",
                  "openai/gpt-4o", "openai/gpt-4o-mini", "openai/o3-mini"
                ],
              }},
              prompt: {{ type: "string", required: true }},
              graph_tools: {{ type: "boolean", default: false, description: "Enable graph management tools for this agent" }},
            }},
          }},
          command_config: {{
            type: "object",
            required: false,
            description: "Required when node_type=command",
            fields: {{ command: {{ type: "string", required: true }} }},
          }},
        }},
      }},
      edges: {{
        type: "array",
        required: false,
        description: "Edges connecting nodes by index",
        items: {{ from_index: {{ type: "integer" }}, to_index: {{ type: "integer" }} }},
      }},
    }},
    constraints: ["Graph names must be unique within a workspace", "Must be a DAG (no cycles)"],
  }},
  node: {{
    entity: "node",
    description: "A node in a graph. Can be an agent dispatch or a command execution.",
    create_params: {{
      graph_id: {{ type: "string (UUID)", required: true, description: "Parent graph" }},
      node_type: {{ type: "string", enum: ["agent", "command"], required: true }},
      name: {{ type: "string", required: false }},
      agent_config: {{ type: "object", required: false, description: "Required for agent nodes. See graph describe for fields." }},
      command_config: {{ type: "object", required: false, description: "Required for command nodes. Fields: {{command: string}}" }},
    }},
    constraints: ["Node names must be unique within a graph"],
  }},
  edge: {{
    entity: "edge",
    description: "A directed edge connecting two nodes in the same graph.",
    create_params: {{
      graph_id: {{ type: "string (UUID)", required: true, description: "Parent graph" }},
      from_node_id: {{ type: "string (UUID)", required: true, description: "Source node" }},
      to_node_id: {{ type: "string (UUID)", required: true, description: "Target node" }},
    }},
    constraints: ["Both nodes must belong to the same graph", "Must not create a cycle"],
  }},
}}

export default tool({{
  description: "Describe the schema of a graph entity (graph, node, or edge). Returns field definitions, types, and constraints.",
  args: {{
    entity: tool.schema.enum(["graph", "node", "edge"]).describe("Entity type to describe"),
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
