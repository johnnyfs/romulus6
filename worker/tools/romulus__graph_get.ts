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
  description: "Get a graph, node, or edge. Omit id to list all graphs.",
  args: {
    entity: tool.schema.enum(["graph", "node", "edge"]).describe("Type of entity to get"),
    id: tool.schema.string().optional().describe("UUID of the entity. Omit to list all graphs."),
    graph_id: tool.schema.string().optional().describe("Parent graph UUID (required for node/edge)"),
  },
  async execute(args) {
    const { entity, id, graph_id } = args
    if (entity === "graph") {
      if (id) {
        const result = await api(`/graphs/${id}`)
        return JSON.stringify(result, null, 2)
      }
      const result = await api("/graphs")
      return JSON.stringify(result, null, 2)
    }
    if (entity === "node" || entity === "edge") {
      const gid = graph_id
      if (!gid) throw new Error("graph_id is required for node/edge lookup")
      const graph = await api(`/graphs/${gid}`)
      if (entity === "node") {
        if (id) {
          const node = graph.nodes?.find((n: any) => n.id === id)
          if (!node) throw new Error(`Node ${id} not found in graph ${gid}`)
          return JSON.stringify(node, null, 2)
        }
        return JSON.stringify(graph.nodes ?? [], null, 2)
      }
      if (id) {
        const edge = graph.edges?.find((e: any) => e.id === id)
        if (!edge) throw new Error(`Edge ${id} not found in graph ${gid}`)
        return JSON.stringify(edge, null, 2)
      }
      return JSON.stringify(graph.edges ?? [], null, 2)
    }
    throw new Error(`Unknown entity: ${entity}`)
  },
})
