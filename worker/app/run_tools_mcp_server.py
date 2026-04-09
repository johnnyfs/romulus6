import json
import os
from typing import Any

import httpx
from fastmcp import FastMCP

from app.run_tools import build_output_model, call_mark_node_complete


def _env(name: str, *, required: bool = True) -> str | None:
    value = os.environ.get(name)
    if required and not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def _load_context() -> dict[str, Any]:
    output_schema_raw = _env("ROMULUS_OUTPUT_SCHEMA_JSON", required=False)
    return {
        "backend_url": _env("ROMULUS_BACKEND_URL"),
        "workspace_id": _env("ROMULUS_WORKSPACE_ID"),
        "run_id": _env("ROMULUS_RUN_ID", required=False),
        "node_id": _env("ROMULUS_RUN_NODE_ID", required=False),
        "graph_tools": _env("ROMULUS_ENABLE_GRAPH_TOOLS", required=False) == "1",
        "output_schema": json.loads(output_schema_raw) if output_schema_raw else None,
    }


def _base_url(context: dict[str, Any]) -> str:
    return f"{context['backend_url']}/workspaces/{context['workspace_id']}"


async def _api(
    context: dict[str, Any],
    path: str,
    method: str = "GET",
    body: dict[str, Any] | None = None,
) -> str:
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.request(
            method,
            f"{_base_url(context)}{path}",
            json=body,
            headers={"Content-Type": "application/json"},
        )
        text = resp.text
        if not resp.is_success:
            raise RuntimeError(f"API {resp.status_code}: {text}")
        return text or json.dumps({"ok": True})


def build_server() -> FastMCP:
    context = _load_context()
    mcp = FastMCP("romulus-run-tools")

    output_model = build_output_model(context["output_schema"])
    if context["run_id"] and context["node_id"]:
        if output_model is None:
            @mcp.tool(
                name="mark_node_complete",
                description=(
                    "Call this tool when you have completed the task assigned to you. "
                    "Use it to mark the current graph node complete."
                ),
            )
            async def mark_node_complete(output: dict[str, Any] | None = None) -> str:
                return await call_mark_node_complete(
                    backend_url=context["backend_url"],
                    workspace_id=context["workspace_id"],
                    run_id=context["run_id"],
                    node_id=context["node_id"],
                    output=output,
                )
        else:
            @mcp.tool(
                name="mark_node_complete",
                description=(
                    "Call this tool when you have completed the task assigned to you. "
                    "Use it to mark the current graph node complete."
                ),
            )
            async def mark_node_complete(output: output_model) -> str:  # type: ignore[valid-type]
                return await call_mark_node_complete(
                    backend_url=context["backend_url"],
                    workspace_id=context["workspace_id"],
                    run_id=context["run_id"],
                    node_id=context["node_id"],
                    output=output.model_dump(mode="json"),
                )

    if context["graph_tools"]:
        @mcp.tool(
            name="romulus__graph_create",
            description=(
                "Create a graph, node, edge, task_template, subgraph_template, "
                "subgraph_template_node, or subgraph_template_edge in the Romulus workspace."
            ),
        )
        async def graph_create(entity: str, params: dict[str, Any]) -> str:
            params = dict(params)
            if entity == "graph":
                return await _api(context, "/graphs", "POST", params)
            if entity == "node":
                graph_id = params.pop("graph_id", None)
                if not graph_id:
                    raise RuntimeError("graph_id is required for node creation")
                return await _api(context, f"/graphs/{graph_id}/nodes", "POST", params)
            if entity == "edge":
                graph_id = params.pop("graph_id", None)
                if not graph_id:
                    raise RuntimeError("graph_id is required for edge creation")
                return await _api(context, f"/graphs/{graph_id}/edges", "POST", params)
            if entity == "task_template":
                return await _api(context, "/task-templates", "POST", params)
            if entity == "subgraph_template":
                return await _api(context, "/subgraph-templates", "POST", params)
            if entity == "subgraph_template_node":
                template_id = params.pop("subgraph_template_id", None)
                if not template_id:
                    raise RuntimeError("subgraph_template_id is required")
                return await _api(
                    context,
                    f"/subgraph-templates/{template_id}/nodes",
                    "POST",
                    params,
                )
            if entity == "subgraph_template_edge":
                template_id = params.pop("subgraph_template_id", None)
                if not template_id:
                    raise RuntimeError("subgraph_template_id is required")
                return await _api(
                    context,
                    f"/subgraph-templates/{template_id}/edges",
                    "POST",
                    params,
                )
            raise RuntimeError(f"Unknown entity: {entity}")

        @mcp.tool(
            name="romulus__graph_get",
            description=(
                "Get a graph, node, edge, task_template, subgraph_template, "
                "subgraph_template_node, or subgraph_template_edge. Omit id to list all."
            ),
        )
        async def graph_get(
            entity: str,
            id: str | None = None,
            graph_id: str | None = None,
            subgraph_template_id: str | None = None,
        ) -> str:
            if entity == "graph":
                return await _api(context, f"/graphs/{id}" if id else "/graphs")

            if entity in ("node", "edge"):
                if not graph_id:
                    raise RuntimeError("graph_id is required for node/edge lookup")
                graph = json.loads(await _api(context, f"/graphs/{graph_id}"))
                items = graph.get("nodes" if entity == "node" else "edges", [])
                if id is None:
                    return json.dumps(items, indent=2)
                for item in items:
                    if item.get("id") == id:
                        return json.dumps(item, indent=2)
                raise RuntimeError(f"{entity} {id} not found")

            if entity == "task_template":
                return await _api(context, f"/task-templates/{id}" if id else "/task-templates")

            if entity == "subgraph_template":
                return await _api(
                    context,
                    f"/subgraph-templates/{id}" if id else "/subgraph-templates",
                )

            if entity in ("subgraph_template_node", "subgraph_template_edge"):
                if not subgraph_template_id:
                    raise RuntimeError("subgraph_template_id is required")
                template = json.loads(
                    await _api(context, f"/subgraph-templates/{subgraph_template_id}")
                )
                items = template.get(
                    "nodes" if entity == "subgraph_template_node" else "edges",
                    [],
                )
                if id is None:
                    return json.dumps(items, indent=2)
                for item in items:
                    if item.get("id") == id:
                        return json.dumps(item, indent=2)
                raise RuntimeError(f"{entity} {id} not found")

            raise RuntimeError(f"Unknown entity: {entity}")

        @mcp.tool(
            name="romulus__graph_delete",
            description=(
                "Delete a graph, node, edge, task_template, subgraph_template, "
                "subgraph_template_node, or subgraph_template_edge."
            ),
        )
        async def graph_delete(
            entity: str,
            id: str,
            graph_id: str | None = None,
            subgraph_template_id: str | None = None,
        ) -> str:
            if entity == "graph":
                await _api(context, f"/graphs/{id}", "DELETE")
                return f"Graph {id} deleted."
            if entity == "node":
                if not graph_id:
                    raise RuntimeError("graph_id is required")
                await _api(context, f"/graphs/{graph_id}/nodes/{id}", "DELETE")
                return f"Node {id} deleted."
            if entity == "edge":
                if not graph_id:
                    raise RuntimeError("graph_id is required")
                await _api(context, f"/graphs/{graph_id}/edges/{id}", "DELETE")
                return f"Edge {id} deleted."
            if entity == "task_template":
                await _api(context, f"/task-templates/{id}", "DELETE")
                return f"Task template {id} deleted."
            if entity == "subgraph_template":
                await _api(context, f"/subgraph-templates/{id}", "DELETE")
                return f"Subgraph template {id} deleted."
            if entity == "subgraph_template_node":
                if not subgraph_template_id:
                    raise RuntimeError("subgraph_template_id is required")
                await _api(
                    context,
                    f"/subgraph-templates/{subgraph_template_id}/nodes/{id}",
                    "DELETE",
                )
                return f"Node {id} deleted."
            if entity == "subgraph_template_edge":
                if not subgraph_template_id:
                    raise RuntimeError("subgraph_template_id is required")
                await _api(
                    context,
                    f"/subgraph-templates/{subgraph_template_id}/edges/{id}",
                    "DELETE",
                )
                return f"Edge {id} deleted."
            raise RuntimeError(f"Unknown entity: {entity}")

        @mcp.tool(
            name="romulus__graph_edit",
            description=(
                "Edit a graph, node, task_template, subgraph_template, or "
                "subgraph_template_node. Edges cannot be edited."
            ),
        )
        async def graph_edit(
            entity: str,
            id: str,
            params: dict[str, Any],
            graph_id: str | None = None,
            subgraph_template_id: str | None = None,
        ) -> str:
            if entity == "graph":
                return await _api(context, f"/graphs/{id}", "PUT", params)
            if entity == "node":
                if not graph_id:
                    raise RuntimeError("graph_id is required")
                return await _api(context, f"/graphs/{graph_id}/nodes/{id}", "PATCH", params)
            if entity == "task_template":
                return await _api(context, f"/task-templates/{id}", "PUT", params)
            if entity == "subgraph_template":
                return await _api(context, f"/subgraph-templates/{id}", "PUT", params)
            if entity == "subgraph_template_node":
                if not subgraph_template_id:
                    raise RuntimeError("subgraph_template_id is required")
                return await _api(
                    context,
                    f"/subgraph-templates/{subgraph_template_id}/nodes/{id}",
                    "PATCH",
                    params,
                )
            raise RuntimeError(
                f"Unknown entity: {entity}. Edges cannot be edited; delete and recreate instead."
            )

        @mcp.tool(
            name="romulus__graph_describe",
            description=(
                "Describe the schema of a Romulus entity. Returns field definitions, "
                "types, and constraints."
            ),
        )
        async def graph_describe(entity: str) -> str:
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
            return json.dumps(schema, indent=2)

    return mcp


def main() -> None:
    build_server().run()


if __name__ == "__main__":
    main()
