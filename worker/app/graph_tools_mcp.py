"""MCP-based graph tools for Claude Code agents.

Provides the same graph management capabilities as the opencode TypeScript tools
(graph_tools.py) but as an SDK MCP server for use with ClaudeSDKClient.
"""

import json

import httpx
from claude_code_sdk import tool, create_sdk_mcp_server


def build_graph_tools_mcp_server(workspace_id: str, backend_url: str):
    """Build an MCP server with graph management tools for Claude Code agents."""

    base_url = f"{backend_url}/workspaces/{workspace_id}"

    async def _api(path: str, method: str = "GET", body: dict | None = None) -> str:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.request(
                method,
                f"{base_url}{path}",
                json=body,
                headers={"Content-Type": "application/json"},
            )
            text = resp.text
            if not resp.is_success:
                return json.dumps({"error": f"API {resp.status_code}: {text}"})
            if not text:
                return json.dumps({"ok": True})
            return text

    @tool(
        "romulus_graph_create",
        "Create a graph, node, edge, task_template, subgraph_template, "
        "subgraph_template_node, or subgraph_template_edge in the Romulus workspace.",
        {
            "entity": str,
            "params": dict,
        },
    )
    async def graph_create(args):
        entity = args["entity"]
        params = args["params"]
        if entity == "graph":
            result = await _api("/graphs", "POST", params)
        elif entity == "node":
            graph_id = params.pop("graph_id", None)
            if not graph_id:
                return {"content": [{"type": "text", "text": "Error: graph_id is required for node creation"}]}
            result = await _api(f"/graphs/{graph_id}/nodes", "POST", params)
        elif entity == "edge":
            graph_id = params.pop("graph_id", None)
            if not graph_id:
                return {"content": [{"type": "text", "text": "Error: graph_id is required for edge creation"}]}
            result = await _api(f"/graphs/{graph_id}/edges", "POST", params)
        elif entity == "task_template":
            result = await _api("/task-templates", "POST", params)
        elif entity == "subgraph_template":
            result = await _api("/subgraph-templates", "POST", params)
        elif entity == "subgraph_template_node":
            stid = params.pop("subgraph_template_id", None)
            if not stid:
                return {"content": [{"type": "text", "text": "Error: subgraph_template_id is required"}]}
            result = await _api(f"/subgraph-templates/{stid}/nodes", "POST", params)
        elif entity == "subgraph_template_edge":
            stid = params.pop("subgraph_template_id", None)
            if not stid:
                return {"content": [{"type": "text", "text": "Error: subgraph_template_id is required"}]}
            result = await _api(f"/subgraph-templates/{stid}/edges", "POST", params)
        else:
            return {"content": [{"type": "text", "text": f"Error: Unknown entity: {entity}"}]}
        return {"content": [{"type": "text", "text": result}]}

    @tool(
        "romulus_graph_get",
        "Get a graph, node, edge, task_template, subgraph_template, "
        "subgraph_template_node, or subgraph_template_edge. Omit id to list all.",
        {
            "entity": str,
            "id": str,
            "graph_id": str,
            "subgraph_template_id": str,
        },
    )
    async def graph_get(args):
        entity = args["entity"]
        eid = args.get("id")
        graph_id = args.get("graph_id")
        stid = args.get("subgraph_template_id")

        if entity == "graph":
            result = await _api(f"/graphs/{eid}" if eid else "/graphs")
        elif entity in ("node", "edge"):
            if not graph_id:
                return {"content": [{"type": "text", "text": "Error: graph_id is required for node/edge lookup"}]}
            graph_data = await _api(f"/graphs/{graph_id}")
            graph = json.loads(graph_data)
            items = graph.get("nodes" if entity == "node" else "edges", [])
            if eid:
                items = [i for i in items if i.get("id") == eid]
                if not items:
                    return {"content": [{"type": "text", "text": f"Error: {entity} {eid} not found"}]}
                result = json.dumps(items[0], indent=2)
            else:
                result = json.dumps(items, indent=2)
        elif entity == "task_template":
            result = await _api(f"/task-templates/{eid}" if eid else "/task-templates")
        elif entity == "subgraph_template":
            result = await _api(f"/subgraph-templates/{eid}" if eid else "/subgraph-templates")
        elif entity in ("subgraph_template_node", "subgraph_template_edge"):
            if not stid:
                return {"content": [{"type": "text", "text": "Error: subgraph_template_id is required"}]}
            tmpl_data = await _api(f"/subgraph-templates/{stid}")
            tmpl = json.loads(tmpl_data)
            key = "nodes" if entity == "subgraph_template_node" else "edges"
            items = tmpl.get(key, [])
            if eid:
                items = [i for i in items if i.get("id") == eid]
                if not items:
                    return {"content": [{"type": "text", "text": f"Error: {entity} {eid} not found"}]}
                result = json.dumps(items[0], indent=2)
            else:
                result = json.dumps(items, indent=2)
        else:
            return {"content": [{"type": "text", "text": f"Error: Unknown entity: {entity}"}]}
        return {"content": [{"type": "text", "text": result}]}

    @tool(
        "romulus_graph_delete",
        "Delete a graph, node, edge, task_template, subgraph_template, "
        "subgraph_template_node, or subgraph_template_edge.",
        {
            "entity": str,
            "id": str,
            "graph_id": str,
            "subgraph_template_id": str,
        },
    )
    async def graph_delete(args):
        entity = args["entity"]
        eid = args["id"]
        graph_id = args.get("graph_id")
        stid = args.get("subgraph_template_id")

        if entity == "graph":
            await _api(f"/graphs/{eid}", "DELETE")
            result = f"Graph {eid} deleted."
        elif entity == "node":
            if not graph_id:
                return {"content": [{"type": "text", "text": "Error: graph_id required"}]}
            await _api(f"/graphs/{graph_id}/nodes/{eid}", "DELETE")
            result = f"Node {eid} deleted."
        elif entity == "edge":
            if not graph_id:
                return {"content": [{"type": "text", "text": "Error: graph_id required"}]}
            await _api(f"/graphs/{graph_id}/edges/{eid}", "DELETE")
            result = f"Edge {eid} deleted."
        elif entity == "task_template":
            await _api(f"/task-templates/{eid}", "DELETE")
            result = f"Task template {eid} deleted."
        elif entity == "subgraph_template":
            await _api(f"/subgraph-templates/{eid}", "DELETE")
            result = f"Subgraph template {eid} deleted."
        elif entity == "subgraph_template_node":
            if not stid:
                return {"content": [{"type": "text", "text": "Error: subgraph_template_id required"}]}
            await _api(f"/subgraph-templates/{stid}/nodes/{eid}", "DELETE")
            result = f"Node {eid} deleted."
        elif entity == "subgraph_template_edge":
            if not stid:
                return {"content": [{"type": "text", "text": "Error: subgraph_template_id required"}]}
            await _api(f"/subgraph-templates/{stid}/edges/{eid}", "DELETE")
            result = f"Edge {eid} deleted."
        else:
            return {"content": [{"type": "text", "text": f"Error: Unknown entity: {entity}"}]}
        return {"content": [{"type": "text", "text": result}]}

    @tool(
        "romulus_graph_edit",
        "Edit a graph, node, task_template, subgraph_template, or subgraph_template_node. "
        "Edges cannot be edited (delete and recreate instead).",
        {
            "entity": str,
            "id": str,
            "params": dict,
            "graph_id": str,
            "subgraph_template_id": str,
        },
    )
    async def graph_edit(args):
        entity = args["entity"]
        eid = args["id"]
        params = args["params"]
        graph_id = args.get("graph_id")
        stid = args.get("subgraph_template_id")

        if entity == "graph":
            result = await _api(f"/graphs/{eid}", "PUT", params)
        elif entity == "node":
            if not graph_id:
                return {"content": [{"type": "text", "text": "Error: graph_id required"}]}
            result = await _api(f"/graphs/{graph_id}/nodes/{eid}", "PATCH", params)
        elif entity == "task_template":
            result = await _api(f"/task-templates/{eid}", "PUT", params)
        elif entity == "subgraph_template":
            result = await _api(f"/subgraph-templates/{eid}", "PUT", params)
        elif entity == "subgraph_template_node":
            if not stid:
                return {"content": [{"type": "text", "text": "Error: subgraph_template_id required"}]}
            result = await _api(f"/subgraph-templates/{stid}/nodes/{eid}", "PATCH", params)
        else:
            return {"content": [{"type": "text", "text": f"Error: Unknown entity: {entity}. Edges cannot be edited; delete and recreate instead."}]}
        return {"content": [{"type": "text", "text": result}]}

    @tool(
        "romulus_graph_describe",
        "Describe the schema of a Romulus entity. Returns field definitions, types, and constraints.",
        {"entity": str},
    )
    async def graph_describe(args):
        schemas = {
            "graph": {
                "entity": "graph",
                "description": "A directed acyclic graph (DAG) containing nodes and edges within a workspace.",
                "create_params": {
                    "name": {"type": "string", "required": True, "description": "Unique name within the workspace"},
                    "nodes": {"type": "array", "required": False},
                    "edges": {"type": "array", "required": False},
                },
                "constraints": ["Graph names must be unique within a workspace", "Must be a DAG (no cycles)"],
            },
            "node": {
                "entity": "node",
                "description": "A node in a graph. Can be an agent dispatch or a command execution.",
                "create_params": {
                    "graph_id": {"type": "string (UUID)", "required": True},
                    "node_type": {"type": "string", "enum": ["agent", "command"], "required": True},
                    "name": {"type": "string", "required": False},
                    "agent_config": {"type": "object", "required": False},
                    "command_config": {"type": "object", "required": False},
                },
                "constraints": ["Node names must be unique within a graph"],
            },
            "edge": {
                "entity": "edge",
                "description": "A directed edge connecting two nodes in the same graph.",
                "create_params": {
                    "graph_id": {"type": "string (UUID)", "required": True},
                    "from_node_id": {"type": "string (UUID)", "required": True},
                    "to_node_id": {"type": "string (UUID)", "required": True},
                },
                "constraints": ["Both nodes must belong to the same graph", "Must not create a cycle"],
            },
            "task_template": {
                "entity": "task_template",
                "description": "A reusable, parameterized task definition.",
                "create_params": {
                    "name": {"type": "string", "required": True},
                    "task_type": {"type": "string", "enum": ["agent", "command"], "required": True},
                    "agent_type": {"type": "string", "required": False},
                    "model": {"type": "string", "required": False},
                    "prompt": {"type": "string", "required": False},
                    "command": {"type": "string", "required": False},
                    "graph_tools": {"type": "boolean", "default": False},
                    "arguments": {"type": "array", "required": False},
                },
                "constraints": ["Template names must be unique within a workspace"],
            },
            "subgraph_template": {
                "entity": "subgraph_template",
                "description": "A reusable, parameterized graph template.",
                "create_params": {
                    "name": {"type": "string", "required": True},
                    "nodes": {"type": "array", "required": False},
                    "edges": {"type": "array", "required": False},
                    "arguments": {"type": "array", "required": False},
                },
                "constraints": ["Names must be unique within a workspace", "Must be a DAG", "No recursive subgraph template references"],
            },
            "subgraph_template_node": {
                "entity": "subgraph_template_node",
                "description": "A node in a subgraph template. References either a task_template or another subgraph_template.",
                "create_params": {
                    "subgraph_template_id": {"type": "string (UUID)", "required": True},
                    "node_type": {"type": "string", "enum": ["task_template", "subgraph_template"], "required": True},
                    "name": {"type": "string", "required": False},
                    "task_template_id": {"type": "string (UUID)", "required": False},
                    "ref_subgraph_template_id": {"type": "string (UUID)", "required": False},
                    "argument_bindings": {"type": "object", "required": False},
                },
                "constraints": ["Node names must be unique within the subgraph template"],
            },
            "subgraph_template_edge": {
                "entity": "subgraph_template_edge",
                "description": "A directed edge connecting two nodes in a subgraph template.",
                "create_params": {
                    "subgraph_template_id": {"type": "string (UUID)", "required": True},
                    "from_node_id": {"type": "string (UUID)", "required": True},
                    "to_node_id": {"type": "string (UUID)", "required": True},
                },
                "constraints": ["Both nodes must belong to the same subgraph template", "Must not create a cycle"],
            },
        }
        entity = args["entity"]
        schema = schemas.get(entity)
        if not schema:
            return {"content": [{"type": "text", "text": f"Error: Unknown entity: {entity}"}]}
        return {"content": [{"type": "text", "text": json.dumps(schema, indent=2)}]}

    return create_sdk_mcp_server(
        "romulus-graph-tools",
        tools=[graph_create, graph_get, graph_delete, graph_edit, graph_describe],
    )
