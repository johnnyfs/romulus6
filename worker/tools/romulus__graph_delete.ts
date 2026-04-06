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
  description: "Delete a graph, node, or edge.",
  args: {
    entity: tool.schema.enum(["graph", "node", "edge"]).describe("Type of entity to delete"),
    id: tool.schema.string().describe("UUID of the entity to delete"),
    graph_id: tool.schema.string().optional().describe("Parent graph UUID (required for node/edge)"),
  },
  async execute(args) {
    const { entity, id, graph_id } = args
    if (entity === "graph") {
      await api(`/graphs/${id}`, { method: "DELETE" })
      return `Graph ${id} deleted.`
    }
    if (entity === "node") {
      if (!graph_id) throw new Error("graph_id is required for node deletion")
      await api(`/graphs/${graph_id}/nodes/${id}`, { method: "DELETE" })
      return `Node ${id} deleted.`
    }
    if (entity === "edge") {
      if (!graph_id) throw new Error("graph_id is required for edge deletion")
      await api(`/graphs/${graph_id}/edges/${id}`, { method: "DELETE" })
      return `Edge ${id} deleted.`
    }
    throw new Error(`Unknown entity: ${entity}`)
  },
})
