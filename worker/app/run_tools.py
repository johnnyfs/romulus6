import json
import os
import sys
from typing import Any

import httpx
from pydantic import BaseModel, Field, create_model

_PRIMITIVE_TYPE_MAP: dict[str, type] = {
    "string": str,
    "number": float,
    "boolean": bool,
    "image": str,
}

_JSON_SCHEMA_TYPE_MAP: dict[str, str] = {
    "string": "string",
    "number": "number",
    "boolean": "boolean",
    "image": "string",
}


def _resolve_field_type(
    type_spec: str | dict[str, Any],
    model_name_prefix: str = "Nested",
) -> type:
    if isinstance(type_spec, str):
        py_type = _PRIMITIVE_TYPE_MAP.get(type_spec)
        if py_type is None:
            raise ValueError(f"Unsupported output schema type: {type_spec}")
        return py_type

    if isinstance(type_spec, dict):
        kind = type_spec.get("_type")
        if kind == "object":
            nested_fields = type_spec.get("fields", {})
            field_defs: dict[str, tuple[type[Any], Any]] = {}
            for key, value in nested_fields.items():
                field_defs[key] = (
                    _resolve_field_type(value, f"{model_name_prefix}_{key}"),
                    Field(...),
                )
            return create_model(f"{model_name_prefix}Model", **field_defs)
        if kind == "list":
            inner = _resolve_field_type(
                type_spec.get("items", "string"),
                f"{model_name_prefix}Item",
            )
            return list[inner]  # type: ignore[valid-type]
        if kind == "map":
            inner = _resolve_field_type(
                type_spec.get("values", "string"),
                f"{model_name_prefix}Value",
            )
            return dict[str, inner]  # type: ignore[valid-type]

    raise ValueError(f"Unsupported output schema type spec: {type_spec}")


def build_output_model(output_schema: dict[str, Any] | None) -> type[BaseModel] | None:
    if output_schema is None:
        return None
    fields: dict[str, tuple[type[Any], Any]] = {}
    for key, value in output_schema.items():
        fields[key] = (_resolve_field_type(value, f"Field_{key}"), Field(...))
    return create_model("GraphRunOutputModel", **fields)


def build_completion_input_model(output_schema: dict[str, Any] | None) -> type[BaseModel]:
    output_model = build_output_model(output_schema)
    if output_model is None:
        return create_model(
            "MarkNodeCompleteInput",
            output=(dict[str, Any] | None, Field(default=None)),
        )
    return create_model(
        "MarkNodeCompleteInput",
        output=(output_model, Field(...)),
    )


def _expanded_type_to_json_schema(type_spec: str | dict[str, Any]) -> dict[str, Any]:
    if isinstance(type_spec, str):
        return {"type": _JSON_SCHEMA_TYPE_MAP.get(type_spec, "string")}

    if not isinstance(type_spec, dict):
        return {"type": "string"}

    kind = type_spec.get("_type")
    if kind == "object":
        fields = type_spec.get("fields", {})
        return {
            "type": "object",
            "properties": {
                key: _expanded_type_to_json_schema(value)
                for key, value in fields.items()
            },
            "required": list(fields.keys()),
        }
    if kind == "list":
        return {
            "type": "array",
            "items": _expanded_type_to_json_schema(type_spec.get("items", "string")),
        }
    if kind == "map":
        return {
            "type": "object",
            "additionalProperties": _expanded_type_to_json_schema(
                type_spec.get("values", "string")
            ),
        }
    return {"type": "string"}


def build_completion_tool_json_schema(output_schema: dict[str, Any] | None) -> dict[str, Any]:
    if output_schema is None:
        return {
            "type": "object",
            "properties": {
                "output": {
                    "type": "object",
                    "description": "Optional output data for this graph node.",
                }
            },
            "required": [],
        }

    properties = {
        key: {
            **_expanded_type_to_json_schema(value),
            "description": f"The {key} output field.",
        }
        for key, value in output_schema.items()
    }
    return {
        "type": "object",
        "properties": {
            "output": {
                "type": "object",
                "description": "The output data for this node. It must match the required output schema.",
                "properties": properties,
                "required": list(output_schema.keys()),
            }
        },
        "required": ["output"],
    }


def build_completion_tool_content(
    *,
    backend_url: str,
    workspace_id: str,
    run_id: str,
    node_id: str,
    output_schema: dict[str, Any] | None,
) -> str:
    params_json = json.dumps(
        build_completion_tool_json_schema(output_schema),
        indent=6,
    )
    return (
        'import { tool } from "@opencode/tool";\n'
        "\n"
        f'const BACKEND_URL = {json.dumps(backend_url)};\n'
        f'const WORKSPACE_ID = {json.dumps(workspace_id)};\n'
        f'const RUN_ID = {json.dumps(run_id)};\n'
        f'const NODE_ID = {json.dumps(node_id)};\n'
        "\n"
        "async function api(body) {\n"
        "  const resp = await fetch(\n"
        "    `${BACKEND_URL}/workspaces/${WORKSPACE_ID}/runs/${RUN_ID}/nodes/${NODE_ID}/complete`,\n"
        "    {\n"
        '      method: "POST",\n'
        '      headers: { "Content-Type": "application/json" },\n'
        "      body: JSON.stringify(body),\n"
        "    },\n"
        "  );\n"
        "  const text = await resp.text();\n"
        "  if (!resp.ok) throw new Error(`API ${resp.status}: ${text}`);\n"
        '  return text || JSON.stringify({ ok: true });\n'
        "}\n"
        "\n"
        "export default tool({\n"
        '  name: "mark_node_complete",\n'
        '  description: "Call this tool when you have completed the task assigned to you. '
        'Use it to mark the current graph node complete.",\n'
        f"  parameters: {params_json},\n"
        "  async execute(params) {\n"
        "    const body = params.output === undefined ? {} : { output: params.output };\n"
        "    return await api(body);\n"
        "  },\n"
        "});\n"
    )


def write_completion_tool(
    workspace_dir: str,
    *,
    backend_url: str,
    workspace_id: str,
    run_id: str,
    node_id: str,
    output_schema: dict[str, Any] | None,
) -> None:
    tools_dir = os.path.join(workspace_dir, ".opencode", "tools")
    os.makedirs(tools_dir, exist_ok=True)
    path = os.path.join(tools_dir, "mark_node_complete.ts")
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(
            build_completion_tool_content(
                backend_url=backend_url,
                workspace_id=workspace_id,
                run_id=run_id,
                node_id=node_id,
                output_schema=output_schema,
            )
        )


def write_codex_mcp_config(
    home_dir: str,
    *,
    backend_url: str,
    workspace_id: str,
    graph_tools: bool,
    run_id: str | None,
    node_id: str | None,
    output_schema: dict[str, Any] | None,
) -> str:
    codex_dir = os.path.join(home_dir, ".codex")
    os.makedirs(codex_dir, exist_ok=True)
    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    env = {
        "ROMULUS_BACKEND_URL": backend_url,
        "ROMULUS_WORKSPACE_ID": workspace_id,
        "ROMULUS_ENABLE_GRAPH_TOOLS": "1" if graph_tools else "0",
        "ROMULUS_OUTPUT_SCHEMA_JSON": json.dumps(output_schema),
        "PYTHONPATH": project_root,
    }
    if run_id is not None:
        env["ROMULUS_RUN_ID"] = run_id
    if node_id is not None:
        env["ROMULUS_RUN_NODE_ID"] = node_id

    lines = [
        "[mcp_servers.romulus_run_tools]",
        f"command = {json.dumps(sys.executable)}",
        'args = ["-m", "app.run_tools_mcp_server"]',
        "enabled = true",
        "startup_timeout_sec = 30",
        "tool_timeout_sec = 60",
        "",
        "[mcp_servers.romulus_run_tools.env]",
    ]
    lines.extend(f"{key} = {json.dumps(value)}" for key, value in env.items())

    path = os.path.join(codex_dir, "config.toml")
    with open(path, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")
    return path


async def call_mark_node_complete(
    *,
    backend_url: str,
    workspace_id: str,
    run_id: str,
    node_id: str,
    output: dict[str, Any] | None,
) -> str:
    body = {} if output is None else {"output": output}
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            f"{backend_url}/workspaces/{workspace_id}/runs/{run_id}/nodes/{node_id}/complete",
            json=body,
            headers={"Content-Type": "application/json"},
        )
        text = resp.text
        if not resp.is_success:
            raise RuntimeError(f"API {resp.status_code}: {text}")
        return text or json.dumps({"ok": True})
