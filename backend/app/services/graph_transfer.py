import datetime
import uuid
from collections.abc import Iterable
from typing import Any

from pydantic import BaseModel, ConfigDict, Field
from sqlmodel import Session, select

from app.models.graph import Graph, GraphEdge, GraphNode, NodeType
from app.models.template import (
    SubgraphTemplate,
    SubgraphTemplateArgument,
    SubgraphTemplateEdge,
    SubgraphTemplateNode,
    SubgraphTemplateNodeType,
    TaskTemplate,
    TaskTemplateArgument,
    TemplateArgType,
)
from app.services import graphs as graph_svc
from app.services import templates as template_svc
from app.services.graphs import EdgeInput, NodeInput
from app.services.structured_serialization import decoded_json_string, normalized_json_value
from app.services.templates import ArgumentInput, SubgraphEdgeInput, SubgraphNodeInput

BUNDLE_FORMAT = "romulus.graph-bundle"
BUNDLE_VERSION = 2


def _isoformat(value: datetime.datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


def _append_unique_suffix(name: str, used_names: set[str]) -> str:
    if name not in used_names:
        used_names.add(name)
        return name
    index = 2
    while True:
        candidate = f"{name} (imported {index})"
        if candidate not in used_names:
            used_names.add(candidate)
            return candidate
        index += 1


def _existing_names(session: Session, model, workspace_id: uuid.UUID) -> set[str]:
    return {
        obj.name
        for obj in session.exec(
            model.active().where(model.workspace_id == workspace_id)
        ).all()
    }


def _serialize_task_argument(arg: TaskTemplateArgument) -> dict[str, Any]:
    return {
        "id": str(arg.id),
        "name": arg.name,
        "arg_type": arg.arg_type.value if hasattr(arg.arg_type, "value") else str(arg.arg_type),
        "default_value": arg.default_value,
        "model_constraint": decoded_json_string(arg.model_constraint),
        "min_value": float(arg.min_value) if arg.min_value is not None else None,
        "max_value": float(arg.max_value) if arg.max_value is not None else None,
        "enum_options": decoded_json_string(arg.enum_options),
    }


def _serialize_subgraph_argument(arg: SubgraphTemplateArgument) -> dict[str, Any]:
    return {
        "id": str(arg.id),
        "name": arg.name,
        "arg_type": arg.arg_type.value if hasattr(arg.arg_type, "value") else str(arg.arg_type),
        "default_value": arg.default_value,
        "model_constraint": decoded_json_string(arg.model_constraint),
        "min_value": float(arg.min_value) if arg.min_value is not None else None,
        "max_value": float(arg.max_value) if arg.max_value is not None else None,
        "enum_options": decoded_json_string(arg.enum_options),
    }


def _serialize_task_template(template: TaskTemplate) -> dict[str, Any]:
    return {
        "id": str(template.id),
        "name": template.name,
        "task_type": template.task_type.value if hasattr(template.task_type, "value") else str(template.task_type),
        "agent_type": template.agent_type,
        "model": template.model,
        "prompt": template.prompt,
        "command": template.command,
        "graph_tools": template.graph_tools,
        "label": template.label,
        "output_schema": normalized_json_value(template.output_schema),
        "image_attachments": normalized_json_value(template.image_attachments),
        "arguments": [
            _serialize_task_argument(arg)
            for arg in template.arguments
            if not arg.deleted
        ],
    }


def _serialize_subgraph_template(template: SubgraphTemplate) -> dict[str, Any]:
    return {
        "id": str(template.id),
        "name": template.name,
        "label": template.label,
        "output_schema": normalized_json_value(template.output_schema),
        "arguments": [
            _serialize_subgraph_argument(arg)
            for arg in template.arguments
            if not arg.deleted
        ],
        "nodes": [
            {
                "id": str(node.id),
                "node_type": node.node_type.value if hasattr(node.node_type, "value") else str(node.node_type),
                "name": node.name,
                "agent_type": node.agent_type,
                "model": node.model,
                "prompt": node.prompt,
                "command": node.command,
                "graph_tools": node.graph_tools,
                "task_template_id": str(node.task_template_id) if node.task_template_id else None,
                "task_template_name": (
                    node.ref_task_template.name
                    if node.ref_task_template is not None
                    else None
                ),
                "ref_subgraph_template_id": (
                    str(node.ref_subgraph_template_id)
                    if node.ref_subgraph_template_id
                    else None
                ),
                "ref_subgraph_template_name": (
                    node.ref_subgraph.name if node.ref_subgraph is not None else None
                ),
                "argument_bindings": normalized_json_value(node.argument_bindings),
                "output_schema": normalized_json_value(node.output_schema),
                "image_attachments": normalized_json_value(node.image_attachments),
            }
            for node in template.nodes
            if not node.deleted
        ],
        "edges": [
            {
                "id": str(edge.id),
                "from_node_id": str(edge.from_node_id),
                "to_node_id": str(edge.to_node_id),
            }
            for edge in template.edges
            if not edge.deleted
        ],
    }


def _serialize_graph(graph: Graph) -> dict[str, Any]:
    return {
        "id": str(graph.id),
        "name": graph.name,
        "nodes": [
            {
                "id": str(node.id),
                "node_type": node.node_type.value if hasattr(node.node_type, "value") else str(node.node_type),
                "name": node.name,
                "agent_type": node.agent_type,
                "model": node.model,
                "prompt": node.prompt,
                "command": node.command,
                "graph_tools": node.graph_tools,
                "task_template_id": str(node.task_template_id) if node.task_template_id else None,
                "task_template_name": (
                    node.ref_task_template.name
                    if node.ref_task_template is not None
                    else None
                ),
                "subgraph_template_id": str(node.subgraph_template_id) if node.subgraph_template_id else None,
                "subgraph_template_name": (
                    node.ref_subgraph_template.name
                    if node.ref_subgraph_template is not None
                    else None
                ),
                "argument_bindings": normalized_json_value(node.argument_bindings),
                "output_schema": normalized_json_value(node.output_schema),
                "image_attachments": normalized_json_value(node.image_attachments),
            }
            for node in graph.nodes
            if not node.deleted
        ],
        "edges": [
            {
                "id": str(edge.id),
                "from_node_id": str(edge.from_node_id),
                "to_node_id": str(edge.to_node_id),
            }
            for edge in graph.edges
            if not edge.deleted
        ],
    }


def _collect_subgraph_dependencies(
    session: Session,
    workspace_id: uuid.UUID,
    subgraph_template_id: uuid.UUID,
    task_templates: dict[uuid.UUID, TaskTemplate],
    subgraphs: dict[uuid.UUID, SubgraphTemplate],
) -> None:
    if subgraph_template_id in subgraphs:
        return
    template = session.get(SubgraphTemplate, subgraph_template_id)
    if template is None or template.workspace_id != workspace_id or template.deleted:
        return
    subgraphs[template.id] = template
    for node in template.nodes:
        if node.deleted:
            continue
        if node.task_template_id:
            task = session.get(TaskTemplate, node.task_template_id)
            if task and task.workspace_id == workspace_id and not task.deleted:
                task_templates[task.id] = task
        if node.ref_subgraph_template_id:
            _collect_subgraph_dependencies(
                session,
                workspace_id,
                node.ref_subgraph_template_id,
                task_templates,
                subgraphs,
            )


def export_graph_bundle(
    session: Session,
    workspace_id: uuid.UUID,
    graph_id: uuid.UUID,
) -> dict[str, Any]:
    graph = graph_svc.get_graph(session, workspace_id, graph_id)
    if graph is None:
        raise ValueError("Graph not found")

    task_templates: dict[uuid.UUID, TaskTemplate] = {}
    subgraphs: dict[uuid.UUID, SubgraphTemplate] = {}

    for node in graph.nodes:
        if node.deleted:
            continue
        if node.task_template_id:
            task = session.get(TaskTemplate, node.task_template_id)
            if task and task.workspace_id == workspace_id and not task.deleted:
                task_templates[task.id] = task
        if node.subgraph_template_id:
            _collect_subgraph_dependencies(
                session,
                workspace_id,
                node.subgraph_template_id,
                task_templates,
                subgraphs,
            )

    return {
        "format": BUNDLE_FORMAT,
        "version": BUNDLE_VERSION,
        "exported_at": datetime.datetime.utcnow().isoformat(),
        "graph": _serialize_graph(graph),
        "task_templates": [
            _serialize_task_template(task_templates[task_id])
            for task_id in sorted(task_templates, key=lambda item: task_templates[item].name)
        ],
        "subgraph_templates": [
            _serialize_subgraph_template(subgraphs[subgraph_id])
            for subgraph_id in sorted(subgraphs, key=lambda item: subgraphs[item].name)
        ],
        "meta": {
            "workspace_id": str(workspace_id),
            "graph_id": str(graph.id),
            "graph_name": graph.name,
            "counts": {
                "task_templates": len(task_templates),
                "subgraph_templates": len(subgraphs),
                "graph_nodes": len([node for node in graph.nodes if not node.deleted]),
                "graph_edges": len([edge for edge in graph.edges if not edge.deleted]),
            },
        },
    }


class _ImportModel(BaseModel):
    model_config = ConfigDict(extra="ignore")


class ImportArgument(_ImportModel):
    id: str | None = None
    name: str | None = None
    arg_type: str | None = None
    default_value: str | None = None
    model_constraint: list[str] | None = None
    min_value: float | int | str | None = None
    max_value: float | int | str | None = None
    enum_options: list[str] | None = None


class ImportTaskTemplate(_ImportModel):
    id: str | None = None
    name: str | None = None
    task_type: str | None = None
    agent_type: str | None = None
    model: str | None = None
    prompt: str | None = None
    command: str | None = None
    graph_tools: bool = False
    label: str | None = None
    output_schema: dict[str, str] | None = None
    image_attachments: list[dict] | None = None
    arguments: list[ImportArgument] = Field(default_factory=list)


class ImportSubgraphNode(_ImportModel):
    id: str | None = None
    node_type: str | None = None
    name: str | None = None
    agent_type: str | None = None
    model: str | None = None
    prompt: str | None = None
    command: str | None = None
    graph_tools: bool = False
    task_template_id: str | None = None
    task_template_name: str | None = None
    ref_subgraph_template_id: str | None = None
    ref_subgraph_template_name: str | None = None
    argument_bindings: dict[str, str] | None = None
    output_schema: dict[str, str] | None = None
    image_attachments: list[dict] | None = None


class ImportSubgraphEdge(_ImportModel):
    id: str | None = None
    from_node_id: str | None = None
    to_node_id: str | None = None


class ImportSubgraphTemplate(_ImportModel):
    id: str | None = None
    name: str | None = None
    label: str | None = None
    output_schema: dict[str, str] | None = None
    arguments: list[ImportArgument] = Field(default_factory=list)
    nodes: list[ImportSubgraphNode] = Field(default_factory=list)
    edges: list[ImportSubgraphEdge] = Field(default_factory=list)


class ImportGraphNode(_ImportModel):
    id: str | None = None
    node_type: str | None = None
    name: str | None = None
    agent_type: str | None = None
    model: str | None = None
    prompt: str | None = None
    command: str | None = None
    graph_tools: bool = False
    task_template_id: str | None = None
    task_template_name: str | None = None
    subgraph_template_id: str | None = None
    subgraph_template_name: str | None = None
    argument_bindings: dict[str, str] | None = None
    output_schema: dict[str, str] | None = None
    image_attachments: list[dict] | None = None


class ImportGraphEdge(_ImportModel):
    id: str | None = None
    from_node_id: str | None = None
    to_node_id: str | None = None


class ImportGraph(_ImportModel):
    id: str | None = None
    name: str | None = None
    nodes: list[ImportGraphNode] = Field(default_factory=list)
    edges: list[ImportGraphEdge] = Field(default_factory=list)


class ImportBundle(_ImportModel):
    format: str | None = None
    version: int | None = None
    graph: ImportGraph | None = None
    task_templates: list[ImportTaskTemplate] = Field(default_factory=list)
    subgraph_templates: list[ImportSubgraphTemplate] = Field(default_factory=list)


def _coerce_template_arg_type(value: str | None, warnings: list[str], label: str) -> TemplateArgType:
    if value is None:
        warnings.append(f"{label}: missing arg_type, defaulted to 'string'")
        return TemplateArgType.string
    try:
        return TemplateArgType(value)
    except ValueError:
        warnings.append(f"{label}: unknown arg_type '{value}', defaulted to 'string'")
        return TemplateArgType.string


def _coerce_float(value: float | int | str | None, warnings: list[str], label: str) -> float | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(value)
    except ValueError:
        warnings.append(f"{label}: could not parse numeric value '{value}', ignored")
        return None


def _to_argument_input(arg: ImportArgument, warnings: list[str], label: str) -> ArgumentInput | None:
    if not arg.name:
        warnings.append(f"{label}: skipped argument without a name")
        return None
    return ArgumentInput(
        name=arg.name,
        arg_type=_coerce_template_arg_type(arg.arg_type, warnings, f"{label}/{arg.name}"),
        default_value=arg.default_value,
        model_constraint=arg.model_constraint,
        min_value=_coerce_float(arg.min_value, warnings, f"{label}/{arg.name}/min_value"),
        max_value=_coerce_float(arg.max_value, warnings, f"{label}/{arg.name}/max_value"),
        enum_options=arg.enum_options,
    )


def _resolve_task_template_ref(
    template_id: str | None,
    template_name: str | None,
    task_id_map: dict[str, uuid.UUID],
    task_name_map: dict[str, uuid.UUID],
) -> uuid.UUID | None:
    if template_id and template_id in task_id_map:
        return task_id_map[template_id]
    if template_name and template_name in task_name_map:
        return task_name_map[template_name]
    return None


def _resolve_subgraph_template_ref(
    template_id: str | None,
    template_name: str | None,
    subgraph_id_map: dict[str, uuid.UUID],
    subgraph_name_map: dict[str, uuid.UUID],
) -> uuid.UUID | None:
    if template_id and template_id in subgraph_id_map:
        return subgraph_id_map[template_id]
    if template_name and template_name in subgraph_name_map:
        return subgraph_name_map[template_name]
    return None


def _collect_named_task_maps(
    session: Session,
    workspace_id: uuid.UUID,
) -> dict[str, uuid.UUID]:
    return {
        task.name: task.id
        for task in session.exec(TaskTemplate.active().where(TaskTemplate.workspace_id == workspace_id)).all()
    }


def _collect_named_subgraph_maps(
    session: Session,
    workspace_id: uuid.UUID,
) -> dict[str, uuid.UUID]:
    return {
        template.name: template.id
        for template in session.exec(
            SubgraphTemplate.active().where(SubgraphTemplate.workspace_id == workspace_id)
        ).all()
    }


def import_graph_bundle(
    session: Session,
    workspace_id: uuid.UUID,
    payload: dict[str, Any],
) -> tuple[Graph, list[str]]:
    bundle = ImportBundle.model_validate(payload)
    warnings: list[str] = []

    if bundle.format and bundle.format != BUNDLE_FORMAT:
        warnings.append(
            f"bundle format '{bundle.format}' is unrecognized; attempted compatibility import"
        )
    if bundle.version and bundle.version > BUNDLE_VERSION:
        warnings.append(
            f"bundle version {bundle.version} is newer than supported version {BUNDLE_VERSION}; unknown fields were ignored"
        )
    if bundle.graph is None or not bundle.graph.name:
        raise ValueError("Import bundle must include a graph with a name")

    task_name_map = _collect_named_task_maps(session, workspace_id)
    subgraph_name_map = _collect_named_subgraph_maps(session, workspace_id)
    task_id_map: dict[str, uuid.UUID] = {}
    subgraph_id_map: dict[str, uuid.UUID] = {}

    used_task_names = _existing_names(session, TaskTemplate, workspace_id)
    for task in bundle.task_templates:
        if not task.name:
            warnings.append("skipped task template without a name")
            continue
        try:
            task_type = NodeType(task.task_type) if task.task_type else NodeType.agent
        except ValueError:
            warnings.append(f"task template '{task.name}': unknown task_type '{task.task_type}', skipped")
            continue

        arg_inputs = [
            argument
            for argument in (
                _to_argument_input(arg, warnings, f"task_template:{task.name}")
                for arg in task.arguments
            )
            if argument is not None
        ]
        import_name = _append_unique_suffix(task.name, used_task_names)
        if import_name != task.name:
            warnings.append(f"task template '{task.name}' renamed to '{import_name}' during import")
        try:
            created = template_svc.create_task_template(
                session,
                workspace_id=workspace_id,
                name=import_name,
                task_type=task_type,
                agent_type=task.agent_type,
                model=task.model,
                prompt=task.prompt,
                command=task.command,
                graph_tools=task.graph_tools,
                label=task.label,
                arguments=arg_inputs,
                output_schema=task.output_schema,
                image_attachments=task.image_attachments,
            )
        except ValueError as exc:
            warnings.append(f"task template '{task.name}' skipped: {exc}")
            continue
        if task.id:
            task_id_map[task.id] = created.id
        task_name_map[task.name] = created.id
        task_name_map[created.name] = created.id

    pending_subgraphs = list(bundle.subgraph_templates)
    used_subgraph_names = _existing_names(session, SubgraphTemplate, workspace_id)
    while pending_subgraphs:
        progressed = False
        next_pending: list[ImportSubgraphTemplate] = []
        for template in pending_subgraphs:
            if not template.name:
                warnings.append("skipped subgraph template without a name")
                progressed = True
                continue

            node_inputs: list[SubgraphNodeInput] = []
            old_to_new_node_index: dict[str, int] = {}
            skipped_node_ids: set[str] = set()
            blocked = False
            for node in template.nodes:
                if not node.node_type:
                    warnings.append(f"subgraph template '{template.name}': skipped node without node_type")
                    if node.id:
                        skipped_node_ids.add(node.id)
                    continue
                try:
                    node_type = SubgraphTemplateNodeType(node.node_type)
                except ValueError:
                    warnings.append(
                        f"subgraph template '{template.name}': skipped node with unknown node_type '{node.node_type}'"
                    )
                    if node.id:
                        skipped_node_ids.add(node.id)
                    continue

                task_template_id = _resolve_task_template_ref(
                    node.task_template_id,
                    node.task_template_name,
                    task_id_map,
                    task_name_map,
                )
                ref_subgraph_template_id = _resolve_subgraph_template_ref(
                    node.ref_subgraph_template_id,
                    node.ref_subgraph_template_name,
                    subgraph_id_map,
                    subgraph_name_map,
                )

                if node_type == SubgraphTemplateNodeType.task_template and task_template_id is None:
                    warnings.append(
                        f"subgraph template '{template.name}': skipped task-template node '{node.name or node.id or 'unnamed'}' because its template could not be resolved"
                    )
                    if node.id:
                        skipped_node_ids.add(node.id)
                    continue
                if node_type == SubgraphTemplateNodeType.subgraph_template and ref_subgraph_template_id is None:
                    blocked = True
                    break

                if node.id:
                    old_to_new_node_index[node.id] = len(node_inputs)
                node_inputs.append(
                    SubgraphNodeInput(
                        node_type=node_type,
                        name=node.name,
                        agent_type=node.agent_type,
                        model=node.model,
                        prompt=node.prompt,
                        command=node.command,
                        graph_tools=node.graph_tools,
                        task_template_id=task_template_id,
                        ref_subgraph_template_id=ref_subgraph_template_id,
                        argument_bindings=node.argument_bindings,
                        output_schema=node.output_schema,
                        image_attachments=node.image_attachments,
                    )
                )

            if blocked:
                next_pending.append(template)
                continue

            edge_inputs: list[SubgraphEdgeInput] = []
            for edge in template.edges:
                if not edge.from_node_id or not edge.to_node_id:
                    warnings.append(f"subgraph template '{template.name}': skipped edge without endpoints")
                    continue
                if edge.from_node_id in skipped_node_ids or edge.to_node_id in skipped_node_ids:
                    warnings.append(
                        f"subgraph template '{template.name}': skipped edge referencing a skipped node"
                    )
                    continue
                from_index = old_to_new_node_index.get(edge.from_node_id)
                to_index = old_to_new_node_index.get(edge.to_node_id)
                if from_index is None or to_index is None:
                    warnings.append(
                        f"subgraph template '{template.name}': skipped edge with unresolved node reference"
                    )
                    continue
                edge_inputs.append(SubgraphEdgeInput(from_index=from_index, to_index=to_index))

            arg_inputs = [
                argument
                for argument in (
                    _to_argument_input(arg, warnings, f"subgraph_template:{template.name}")
                    for arg in template.arguments
                )
                if argument is not None
            ]
            import_name = _append_unique_suffix(template.name, used_subgraph_names)
            if import_name != template.name:
                warnings.append(f"subgraph template '{template.name}' renamed to '{import_name}' during import")
            try:
                created = template_svc.create_subgraph_template(
                    session,
                    workspace_id=workspace_id,
                    name=import_name,
                    nodes=node_inputs,
                    edges=edge_inputs,
                    arguments=arg_inputs,
                    label=template.label,
                    output_schema=template.output_schema,
                )
            except ValueError as exc:
                warnings.append(f"subgraph template '{template.name}' skipped: {exc}")
                progressed = True
                continue
            if template.id:
                subgraph_id_map[template.id] = created.id
            subgraph_name_map[template.name] = created.id
            subgraph_name_map[created.name] = created.id
            progressed = True

        if not progressed:
            for template in next_pending:
                warnings.append(
                    f"subgraph template '{template.name or 'unnamed'}' skipped because one or more referenced subgraph templates could not be resolved"
                )
            break
        pending_subgraphs = next_pending

    graph_nodes: list[NodeInput] = []
    old_to_new_graph_index: dict[str, int] = {}
    skipped_graph_node_ids: set[str] = set()
    for node in bundle.graph.nodes:
        if not node.node_type:
            warnings.append("graph import: skipped node without node_type")
            if node.id:
                skipped_graph_node_ids.add(node.id)
            continue
        try:
            node_type = NodeType(node.node_type)
        except ValueError:
            warnings.append(f"graph import: skipped node with unknown node_type '{node.node_type}'")
            if node.id:
                skipped_graph_node_ids.add(node.id)
            continue

        task_template_id = _resolve_task_template_ref(
            node.task_template_id,
            node.task_template_name,
            task_id_map,
            task_name_map,
        )
        subgraph_template_id = _resolve_subgraph_template_ref(
            node.subgraph_template_id,
            node.subgraph_template_name,
            subgraph_id_map,
            subgraph_name_map,
        )
        if node_type == NodeType.task_template and task_template_id is None:
            warnings.append(
                f"graph '{bundle.graph.name}': skipped task-template node '{node.name or node.id or 'unnamed'}' because its template could not be resolved"
            )
            if node.id:
                skipped_graph_node_ids.add(node.id)
            continue
        if node_type == NodeType.subgraph_template and subgraph_template_id is None:
            warnings.append(
                f"graph '{bundle.graph.name}': skipped subgraph-template node '{node.name or node.id or 'unnamed'}' because its template could not be resolved"
            )
            if node.id:
                skipped_graph_node_ids.add(node.id)
            continue

        if node.id:
            old_to_new_graph_index[node.id] = len(graph_nodes)
        graph_nodes.append(
            NodeInput(
                node_type=node_type,
                name=node.name,
                agent_type=node.agent_type,
                model=node.model,
                prompt=node.prompt,
                command=node.command,
                graph_tools=node.graph_tools,
                task_template_id=task_template_id,
                subgraph_template_id=subgraph_template_id,
                argument_bindings=node.argument_bindings,
                output_schema=node.output_schema,
                image_attachments=node.image_attachments,
            )
        )

    graph_edges: list[EdgeInput] = []
    for edge in bundle.graph.edges:
        if not edge.from_node_id or not edge.to_node_id:
            warnings.append(f"graph '{bundle.graph.name}': skipped edge without endpoints")
            continue
        if edge.from_node_id in skipped_graph_node_ids or edge.to_node_id in skipped_graph_node_ids:
            warnings.append(f"graph '{bundle.graph.name}': skipped edge referencing a skipped node")
            continue
        from_index = old_to_new_graph_index.get(edge.from_node_id)
        to_index = old_to_new_graph_index.get(edge.to_node_id)
        if from_index is None or to_index is None:
            warnings.append(f"graph '{bundle.graph.name}': skipped edge with unresolved node reference")
            continue
        graph_edges.append(EdgeInput(from_index=from_index, to_index=to_index))

    graph_name = _append_unique_suffix(bundle.graph.name, _existing_names(session, Graph, workspace_id))
    if graph_name != bundle.graph.name:
        warnings.append(f"graph '{bundle.graph.name}' renamed to '{graph_name}' during import")

    graph = graph_svc.create_graph(
        session,
        workspace_id=workspace_id,
        name=graph_name,
        nodes=graph_nodes,
        edges=graph_edges,
    )
    return graph, warnings
