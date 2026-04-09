"""MCP tools for Claude Code graph-run sessions."""

import json
from typing import Any

import httpx
from claude_code_sdk import create_sdk_mcp_server, tool
from pydantic import BaseModel

from app.run_tools import build_completion_input_model, call_mark_node_complete


def _tool_value(args: Any, key: str) -> Any:
    if isinstance(args, dict):
        return args.get(key)
    return getattr(args, key, None)


def build_graph_tools_mcp_server(
    workspace_id: str,
    backend_url: str,
    *,
    run_id: str | None = None,
    node_id: str | None = None,
    output_schema: dict[str, Any] | None = None,
    enable_graph_tools: bool = True,
):
    """Build an SDK MCP server for Claude Code with run completion and graph tools."""

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
                raise RuntimeError(f"API {resp.status_code}: {text}")
            return text or json.dumps({"ok": True})

    tools: list[Any] = []

    if run_id and node_id:
        completion_input = build_completion_input_model(output_schema)

        @tool(
            "mark_node_complete",
            (
                "Call this tool when you have completed the task assigned to you. "
                "Use it to mark the current graph node complete."
            ),
            completion_input,
        )
        async def mark_node_complete(args):
            output = _tool_value(args, "output")
            if isinstance(output, BaseModel):
                output = output.model_dump(mode="json")
            result = await call_mark_node_complete(
                backend_url=backend_url,
                workspace_id=workspace_id,
                run_id=run_id,
                node_id=node_id,
                output=output,
            )
            return {"content": [{"type": "text", "text": result}]}

        tools.append(mark_node_complete)

    if enable_graph_tools:
        @tool(
            "romulus__graph_create",
            (
                "Create a graph, node, edge, task_template, subgraph_template, "
                "subgraph_template_node, or subgraph_template_edge in the Romulus workspace."
            ),
            {"entity": str, "params": dict},
        )
        async def graph_create(args):
            entity = _tool_value(args, "entity")
            params = dict(_tool_value(args, "params") or {})
            if entity == "graph":
                result = await _api("/graphs", "POST", params)
            elif entity == "node":
                graph_id = params.pop("graph_id", None)
                if not graph_id:
                    raise RuntimeError("graph_id is required for node creation")
                result = await _api(f"/graphs/{graph_id}/nodes", "POST", params)
            elif entity == "edge":
                graph_id = params.pop("graph_id", None)
                if not graph_id:
                    raise RuntimeError("graph_id is required for edge creation")
                result = await _api(f"/graphs/{graph_id}/edges", "POST", params)
            elif entity == "task_template":
                result = await _api("/task-templates", "POST", params)
            elif entity == "subgraph_template":
                result = await _api("/subgraph-templates", "POST", params)
            elif entity == "subgraph_template_node":
                template_id = params.pop("subgraph_template_id", None)
                if not template_id:
                    raise RuntimeError("subgraph_template_id is required")
                result = await _api(
                    f"/subgraph-templates/{template_id}/nodes",
                    "POST",
                    params,
                )
            elif entity == "subgraph_template_edge":
                template_id = params.pop("subgraph_template_id", None)
                if not template_id:
                    raise RuntimeError("subgraph_template_id is required")
                result = await _api(
                    f"/subgraph-templates/{template_id}/edges",
                    "POST",
                    params,
                )
            else:
                raise RuntimeError(f"Unknown entity: {entity}")
            return {"content": [{"type": "text", "text": result}]}

        @tool(
            "romulus__graph_get",
            (
                "Get a graph, node, edge, task_template, subgraph_template, "
                "subgraph_template_node, or subgraph_template_edge. Omit id to list all."
            ),
            {
                "entity": str,
                "id": str,
                "graph_id": str,
                "subgraph_template_id": str,
            },
        )
        async def graph_get(args):
            entity = _tool_value(args, "entity")
            entity_id = _tool_value(args, "id")
            graph_id = _tool_value(args, "graph_id")
            template_id = _tool_value(args, "subgraph_template_id")

            if entity == "graph":
                result = await _api(f"/graphs/{entity_id}" if entity_id else "/graphs")
            elif entity in ("node", "edge"):
                if not graph_id:
                    raise RuntimeError("graph_id is required for node/edge lookup")
                graph = json.loads(await _api(f"/graphs/{graph_id}"))
                items = graph.get("nodes" if entity == "node" else "edges", [])
                if entity_id is None:
                    result = json.dumps(items, indent=2)
                else:
                    item = next((entry for entry in items if entry.get("id") == entity_id), None)
                    if item is None:
                        raise RuntimeError(f"{entity} {entity_id} not found")
                    result = json.dumps(item, indent=2)
            elif entity == "task_template":
                result = await _api(
                    f"/task-templates/{entity_id}" if entity_id else "/task-templates"
                )
            elif entity == "subgraph_template":
                result = await _api(
                    f"/subgraph-templates/{entity_id}"
                    if entity_id
                    else "/subgraph-templates"
                )
            elif entity in ("subgraph_template_node", "subgraph_template_edge"):
                if not template_id:
                    raise RuntimeError("subgraph_template_id is required")
                template = json.loads(await _api(f"/subgraph-templates/{template_id}"))
                items = template.get(
                    "nodes" if entity == "subgraph_template_node" else "edges",
                    [],
                )
                if entity_id is None:
                    result = json.dumps(items, indent=2)
                else:
                    item = next((entry for entry in items if entry.get("id") == entity_id), None)
                    if item is None:
                        raise RuntimeError(f"{entity} {entity_id} not found")
                    result = json.dumps(item, indent=2)
            else:
                raise RuntimeError(f"Unknown entity: {entity}")
            return {"content": [{"type": "text", "text": result}]}

        @tool(
            "romulus__graph_delete",
            (
                "Delete a graph, node, edge, task_template, subgraph_template, "
                "subgraph_template_node, or subgraph_template_edge."
            ),
            {
                "entity": str,
                "id": str,
                "graph_id": str,
                "subgraph_template_id": str,
            },
        )
        async def graph_delete(args):
            entity = _tool_value(args, "entity")
            entity_id = _tool_value(args, "id")
            graph_id = _tool_value(args, "graph_id")
            template_id = _tool_value(args, "subgraph_template_id")

            if entity == "graph":
                await _api(f"/graphs/{entity_id}", "DELETE")
                result = f"Graph {entity_id} deleted."
            elif entity == "node":
                if not graph_id:
                    raise RuntimeError("graph_id is required")
                await _api(f"/graphs/{graph_id}/nodes/{entity_id}", "DELETE")
                result = f"Node {entity_id} deleted."
            elif entity == "edge":
                if not graph_id:
                    raise RuntimeError("graph_id is required")
                await _api(f"/graphs/{graph_id}/edges/{entity_id}", "DELETE")
                result = f"Edge {entity_id} deleted."
            elif entity == "task_template":
                await _api(f"/task-templates/{entity_id}", "DELETE")
                result = f"Task template {entity_id} deleted."
            elif entity == "subgraph_template":
                await _api(f"/subgraph-templates/{entity_id}", "DELETE")
                result = f"Subgraph template {entity_id} deleted."
            elif entity == "subgraph_template_node":
                if not template_id:
                    raise RuntimeError("subgraph_template_id is required")
                await _api(
                    f"/subgraph-templates/{template_id}/nodes/{entity_id}",
                    "DELETE",
                )
                result = f"Node {entity_id} deleted."
            elif entity == "subgraph_template_edge":
                if not template_id:
                    raise RuntimeError("subgraph_template_id is required")
                await _api(
                    f"/subgraph-templates/{template_id}/edges/{entity_id}",
                    "DELETE",
                )
                result = f"Edge {entity_id} deleted."
            else:
                raise RuntimeError(f"Unknown entity: {entity}")
            return {"content": [{"type": "text", "text": result}]}

        @tool(
            "romulus__graph_edit",
            (
                "Edit a graph, node, task_template, subgraph_template, or "
                "subgraph_template_node. Edges cannot be edited."
            ),
            {
                "entity": str,
                "id": str,
                "params": dict,
                "graph_id": str,
                "subgraph_template_id": str,
            },
        )
        async def graph_edit(args):
            entity = _tool_value(args, "entity")
            entity_id = _tool_value(args, "id")
            params = dict(_tool_value(args, "params") or {})
            graph_id = _tool_value(args, "graph_id")
            template_id = _tool_value(args, "subgraph_template_id")

            if entity == "graph":
                result = await _api(f"/graphs/{entity_id}", "PUT", params)
            elif entity == "node":
                if not graph_id:
                    raise RuntimeError("graph_id is required")
                result = await _api(f"/graphs/{graph_id}/nodes/{entity_id}", "PATCH", params)
            elif entity == "task_template":
                result = await _api(f"/task-templates/{entity_id}", "PUT", params)
            elif entity == "subgraph_template":
                result = await _api(f"/subgraph-templates/{entity_id}", "PUT", params)
            elif entity == "subgraph_template_node":
                if not template_id:
                    raise RuntimeError("subgraph_template_id is required")
                result = await _api(
                    f"/subgraph-templates/{template_id}/nodes/{entity_id}",
                    "PATCH",
                    params,
                )
            else:
                raise RuntimeError(
                    f"Unknown entity: {entity}. Edges cannot be edited; delete and recreate instead."
                )
            return {"content": [{"type": "text", "text": result}]}

        @tool(
            "romulus__graph_describe",
            (
                "Describe the schema of a Romulus entity. Returns field definitions, "
                "types, and constraints."
            ),
            {"entity": str},
        )
        async def graph_describe(args):
            entity = _tool_value(args, "entity")
            schemas = {
                "graph": {
                    "entity": "graph",
                    "description": "A directed acyclic graph (DAG) containing nodes and edges within a workspace.",
                    "create_params": {
                        "name": {"type": "string", "required": True, "description": "Unique name within the workspace"},
                        "nodes": {"type": "array", "required": False},
                        "edges": {"type": "array", "required": False},
                    },
                    "constraints": [
                        "Graph names must be unique within a workspace",
                        "Must be a DAG (no cycles)",
                    ],
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
                    "constraints": [
                        "Both nodes must belong to the same graph",
                        "Must not create a cycle",
                    ],
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
                    "constraints": [
                        "Names must be unique within a workspace",
                        "Must be a DAG",
                        "No recursive subgraph template references",
                    ],
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
                    "constraints": [
                        "Both nodes must belong to the same subgraph template",
                        "Must not create a cycle",
                    ],
                },
            }
            schema = schemas.get(entity)
            if schema is None:
                raise RuntimeError(f"Unknown entity: {entity}")
            return {"content": [{"type": "text", "text": json.dumps(schema, indent=2)}]}

        tools.extend([graph_create, graph_get, graph_delete, graph_edit, graph_describe])

    return create_sdk_mcp_server("romulus-run-tools", tools=tools)
