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
  description: "Create a graph, node, or edge in the Romulus workspace.",
  args: {
    entity: tool.schema.enum(["graph", "node", "edge"]).describe("Type of entity to create"),
    params: tool.schema.record(tool.schema.string(), tool.schema.any()).describe(
      "For graph: {name, nodes?, edges?}. " +
      "For node: {graph_id, node_type, name?, agent_config?, command_config?}. " +
      "For edge: {graph_id, from_node_id, to_node_id}"
    ),
  },
  async execute(args) {
    const { entity, params } = args
    if (entity === "graph") {
      const result = await api("/graphs", {
        method: "POST",
        body: JSON.stringify(params),
      })
      return JSON.stringify(result, null, 2)
    }
    if (entity === "node") {
      const { graph_id, ...rest } = params
      if (!graph_id) throw new Error("graph_id is required for node creation")
      const result = await api(`/graphs/${graph_id}/nodes`, {
        method: "POST",
        body: JSON.stringify(rest),
      })
      return JSON.stringify(result, null, 2)
    }
    if (entity === "edge") {
      const { graph_id, ...rest } = params
      if (!graph_id) throw new Error("graph_id is required for edge creation")
      const result = await api(`/graphs/${graph_id}/edges`, {
        method: "POST",
        body: JSON.stringify(rest),
      })
      return JSON.stringify(result, null, 2)
    }
    throw new Error(`Unknown entity: ${entity}`)
  },
})
