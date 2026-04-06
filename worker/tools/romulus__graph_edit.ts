import { tool } from "@opencode-ai/plugin"

const BACKEND_URL = process.env.ROMULUS_BACKEND_URL!
const WORKSPACE_ID = process.env.ROMULUS_WORKSPACE_ID!

function baseUrl() {
  return `${BACKEND_URL}/workspaces/${WORKSPACE_ID}`
}

async function api(path: string, init?: RequestInit) {
  const resp = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  })
  const text = await resp.text()
  if (!resp.ok) throw new Error(`API ${resp.status}: ${text}`)
  if (!text) return { ok: true }
  return JSON.parse(text)
}

export default tool({
  description: "Edit a graph or node. Edges cannot be edited (delete and recreate instead).",
  args: {
    entity: tool.schema.enum(["graph", "node"]).describe("Type of entity to edit"),
    id: tool.schema.string().describe("UUID of the entity to edit"),
    params: tool.schema.record(tool.schema.string(), tool.schema.any()).describe(
      "For graph: {name, nodes, edges} (full replacement). " +
      "For node: partial update fields {name?, node_type?, agent_config?, command_config?}"
    ),
    graph_id: tool.schema.string().optional().describe("Parent graph UUID (required for node)"),
  },
  async execute(args) {
    const { entity, id, params, graph_id } = args
    if (entity === "graph") {
      const result = await api(`/graphs/${id}`, {
        method: "PUT",
        body: JSON.stringify(params),
      })
      return JSON.stringify(result, null, 2)
    }
    if (entity === "node") {
      if (!graph_id) throw new Error("graph_id is required for node editing")
      const result = await api(`/graphs/${graph_id}/nodes/${id}`, {
        method: "PATCH",
        body: JSON.stringify(params),
      })
      return JSON.stringify(result, null, 2)
    }
    throw new Error(`Unknown entity: ${entity}. Edges cannot be edited; delete and recreate instead.`)
  },
})
