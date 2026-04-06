import { tool } from "@opencode-ai/plugin"

const SCHEMAS: Record<string, object> = {
  graph: {
    entity: "graph",
    description: "A directed acyclic graph (DAG) containing nodes and edges within a workspace.",
    create_params: {
      name: { type: "string", required: true, description: "Unique name within the workspace" },
      nodes: {
        type: "array",
        required: false,
        description: "Nodes to create with the graph",
        items: {
          node_type: { type: "string", enum: ["agent", "command"] },
          name: { type: "string", required: false },
          agent_config: {
            type: "object",
            required: false,
            description: "Required when node_type=agent",
            fields: {
              agent_type: { type: "string", enum: ["opencode"], default: "opencode" },
              model: {
                type: "string",
                enum: [
                  "anthropic/claude-sonnet-4-6", "anthropic/claude-opus-4-6", "anthropic/claude-haiku-4-5",
                  "openai/gpt-4o", "openai/gpt-4o-mini", "openai/o3-mini"
                ],
              },
              prompt: { type: "string", required: true },
              graph_tools: { type: "boolean", default: false, description: "Enable graph management tools for this agent" },
            },
          },
          command_config: {
            type: "object",
            required: false,
            description: "Required when node_type=command",
            fields: { command: { type: "string", required: true } },
          },
        },
      },
      edges: {
        type: "array",
        required: false,
        description: "Edges connecting nodes by index",
        items: { from_index: { type: "integer" }, to_index: { type: "integer" } },
      },
    },
    constraints: ["Graph names must be unique within a workspace", "Must be a DAG (no cycles)"],
  },
  node: {
    entity: "node",
    description: "A node in a graph. Can be an agent dispatch or a command execution.",
    create_params: {
      graph_id: { type: "string (UUID)", required: true, description: "Parent graph" },
      node_type: { type: "string", enum: ["agent", "command"], required: true },
      name: { type: "string", required: false },
      agent_config: { type: "object", required: false, description: "Required for agent nodes. See graph describe for fields." },
      command_config: { type: "object", required: false, description: "Required for command nodes. Fields: {command: string}" },
    },
    constraints: ["Node names must be unique within a graph"],
  },
  edge: {
    entity: "edge",
    description: "A directed edge connecting two nodes in the same graph.",
    create_params: {
      graph_id: { type: "string (UUID)", required: true, description: "Parent graph" },
      from_node_id: { type: "string (UUID)", required: true, description: "Source node" },
      to_node_id: { type: "string (UUID)", required: true, description: "Target node" },
    },
    constraints: ["Both nodes must belong to the same graph", "Must not create a cycle"],
  },
}

export default tool({
  description: "Describe the schema of a graph entity (graph, node, or edge). Returns field definitions, types, and constraints.",
  args: {
    entity: tool.schema.enum(["graph", "node", "edge"]).describe("Entity type to describe"),
  },
  async execute(args) {
    const schema = SCHEMAS[args.entity]
    if (!schema) throw new Error(`Unknown entity: ${args.entity}`)
    return JSON.stringify(schema, null, 2)
  },
})
