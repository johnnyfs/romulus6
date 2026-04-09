import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlmodel import select

from app.database import get_session
from app.models.graph import Graph, GraphNode, NodeType
from app.models.template import (
    SubgraphTemplate,
    SubgraphTemplateNodeType,
    TaskTemplate,
)
from app.routers.graphs import router as graphs_router
from app.routers.templates import sub_router as subgraph_templates_router
from app.routers.templates import task_router as task_templates_router
from app.services import graph_transfer as transfer_svc
from app.services import graphs as graph_svc
from app.services import templates as template_svc
from app.services import workspaces as workspace_svc
from app.services.graphs import NodeInput
from app.services.templates import SubgraphNodeInput

pytestmark = pytest.mark.fast


def _client(session):
    app = FastAPI()
    app.include_router(graphs_router)
    app.include_router(task_templates_router)
    app.include_router(subgraph_templates_router)

    def override_get_session():
        yield session

    app.dependency_overrides[get_session] = override_get_session
    return TestClient(app)


def test_graph_bundle_round_trip_preserves_structured_fields(session):
    source_workspace = workspace_svc.create_workspace(session, "source")
    target_workspace = workspace_svc.create_workspace(session, "target")

    task_template = template_svc.create_task_template(
        session,
        workspace_id=source_workspace.id,
        name="vision-task",
        task_type=NodeType.agent,
        agent_type="pydantic",
        model="openai/gpt-4o",
        prompt="Describe the image",
        label="Vision task",
        output_schema={"answer": "string"},
        image_attachments=[{"type": "url", "url": "https://example.com/source.png"}],
    )
    subgraph_template = template_svc.create_subgraph_template(
        session,
        workspace_id=source_workspace.id,
        name="nested-flow",
        label="Nested flow",
        nodes=[
            SubgraphNodeInput(
                node_type=SubgraphTemplateNodeType.task_template,
                name="templated-step",
                task_template_id=task_template.id,
                argument_bindings={"topic": "birds"},
                output_schema={"answer": "string"},
            ),
            SubgraphNodeInput(
                node_type=SubgraphTemplateNodeType.agent,
                name="pydantic-step",
                agent_type="pydantic",
                model="openai/gpt-4o",
                prompt="Describe gallery",
                image_attachments=[{"type": "url", "url": "https://example.com/gallery.png"}],
                output_schema={"description": "string"},
            ),
        ],
        edges=[],
        output_schema={"answer": "string"},
    )
    graph = graph_svc.create_graph(
        session,
        workspace_id=source_workspace.id,
        name="structured-graph",
        nodes=[
            NodeInput(
                node_type=NodeType.task_template,
                name="templated-entry",
                task_template_id=task_template.id,
                argument_bindings={"topic": "cats"},
                output_schema={"answer": "string"},
            ),
            NodeInput(
                node_type=NodeType.subgraph_template,
                name="nested-entry",
                subgraph_template_id=subgraph_template.id,
                argument_bindings={"topic": "dogs"},
                output_schema={"answer": "string"},
            ),
            NodeInput(
                node_type=NodeType.agent,
                name="graph-pydantic",
                agent_type="pydantic",
                model="openai/gpt-4o",
                prompt="Describe graph image",
                image_attachments=[{"type": "url", "url": "https://example.com/graph.png"}],
                output_schema={"description": "string"},
            ),
        ],
        edges=[],
    )

    bundle = transfer_svc.export_graph_bundle(session, source_workspace.id, graph.id)

    exported_task = next(
        item for item in bundle["task_templates"] if item["name"] == "vision-task"
    )
    assert exported_task["output_schema"] == {"answer": "string"}
    assert exported_task["image_attachments"] == [
        {"type": "url", "url": "https://example.com/source.png", "path": None}
    ]

    exported_graph_node = next(
        item for item in bundle["graph"]["nodes"] if item["name"] == "templated-entry"
    )
    assert exported_graph_node["argument_bindings"] == {"topic": "cats"}
    assert exported_graph_node["output_schema"] == {"answer": "string"}

    exported_pydantic_node = next(
        item for item in bundle["graph"]["nodes"] if item["name"] == "graph-pydantic"
    )
    assert exported_pydantic_node["image_attachments"] == [
        {"type": "url", "url": "https://example.com/graph.png", "path": None}
    ]

    imported_graph, warnings = transfer_svc.import_graph_bundle(
        session,
        target_workspace.id,
        bundle,
    )
    assert warnings == []

    imported_task_template = session.exec(
        select(TaskTemplate)
        .where(TaskTemplate.workspace_id == target_workspace.id)
        .where(TaskTemplate.name == "vision-task")
    ).one()
    imported_subgraph_template = session.exec(
        select(SubgraphTemplate)
        .where(SubgraphTemplate.workspace_id == target_workspace.id)
        .where(SubgraphTemplate.name == "nested-flow")
    ).one()
    imported_graph = session.exec(
        select(Graph)
        .where(Graph.workspace_id == target_workspace.id)
        .where(Graph.id == imported_graph.id)
    ).one()

    assert imported_task_template.output_schema == {"answer": "string"}
    assert imported_task_template.image_attachments == [
        {"type": "url", "url": "https://example.com/source.png", "path": None}
    ]
    assert imported_subgraph_template.output_schema == {"answer": "string"}

    imported_nodes = {
        node.name: node
        for node in session.exec(
            select(GraphNode).where(GraphNode.graph_id == imported_graph.id)
        ).all()
    }
    assert imported_nodes["templated-entry"].argument_bindings == {"topic": "cats"}
    assert imported_nodes["templated-entry"].output_schema == {"answer": "string"}
    assert imported_nodes["graph-pydantic"].image_attachments == [
        {"type": "url", "url": "https://example.com/graph.png", "path": None}
    ]


def test_graph_and_template_routes_return_structured_fields(session):
    workspace = workspace_svc.create_workspace(session, "api")
    task_template = template_svc.create_task_template(
        session,
        workspace_id=workspace.id,
        name="vision-task",
        task_type=NodeType.agent,
        agent_type="pydantic",
        model="openai/gpt-4o",
        prompt="Describe the image",
        output_schema={"answer": "string"},
        image_attachments=[{"type": "url", "url": "https://example.com/source.png"}],
    )
    graph = graph_svc.create_graph(
        session,
        workspace_id=workspace.id,
        name="api-graph",
        nodes=[
            NodeInput(
                node_type=NodeType.task_template,
                name="templated-entry",
                task_template_id=task_template.id,
                argument_bindings={"topic": "cats"},
                output_schema={"answer": "string"},
            ),
            NodeInput(
                node_type=NodeType.agent,
                name="graph-pydantic",
                agent_type="pydantic",
                model="openai/gpt-4o",
                prompt="Describe graph image",
                image_attachments=[{"type": "url", "url": "https://example.com/graph.png"}],
                output_schema={"description": "string"},
            ),
        ],
        edges=[],
    )

    with _client(session) as client:
        task_response = client.get(
            f"/workspaces/{workspace.id}/task-templates/{task_template.id}"
        )
        assert task_response.status_code == 200
        assert task_response.json()["output_schema"] == {"answer": "string"}
        assert task_response.json()["image_attachments"] == [
            {"type": "url", "url": "https://example.com/source.png", "path": None}
        ]

        graph_response = client.get(f"/workspaces/{workspace.id}/graphs/{graph.id}")
        assert graph_response.status_code == 200
        graph_payload = graph_response.json()

    templated_entry = next(
        node for node in graph_payload["nodes"] if node["name"] == "templated-entry"
    )
    graph_pydantic = next(
        node for node in graph_payload["nodes"] if node["name"] == "graph-pydantic"
    )

    assert templated_entry["argument_bindings"] == {"topic": "cats"}
    assert templated_entry["output_schema"] == {"answer": "string"}
    assert graph_pydantic["agent_config"]["agent_type"] == "pydantic"


def test_codex_sandbox_mode_round_trips_through_templates_graphs_and_runs(session):
    workspace = workspace_svc.create_workspace(session, "codex-sandbox")
    task_template = template_svc.create_task_template(
        session,
        workspace_id=workspace.id,
        name="codex-task",
        task_type=NodeType.agent,
        agent_type="codex",
        model="openai/gpt-5.3-codex",
        prompt="Inspect repo",
        graph_tools=True,
        sandbox_mode="workspace-write",
    )
    graph = graph_svc.create_graph(
        session,
        workspace_id=workspace.id,
        name="codex-graph",
        nodes=[
            NodeInput(
                node_type=NodeType.agent,
                name="codex-node",
                agent_type="codex",
                model="openai/gpt-5.3-codex",
                prompt="Inspect graph repo",
                graph_tools=True,
                sandbox_mode="danger-full-access",
            ),
            NodeInput(
                node_type=NodeType.task_template,
                name="templated-codex",
                task_template_id=task_template.id,
            ),
        ],
        edges=[],
    )
    run = graph_svc.create_run(session, graph)
    run_nodes = {
        node.name: node
        for node in run.run_nodes
    }

    with _client(session) as client:
        task_response = client.get(
            f"/workspaces/{workspace.id}/task-templates/{task_template.id}"
        )
        graph_response = client.get(f"/workspaces/{workspace.id}/graphs/{graph.id}")

    assert task_template.sandbox_mode == "workspace-write"
    assert run_nodes["codex-node"].sandbox_mode == "danger-full-access"
    assert run_nodes["templated-codex"].sandbox_mode == "workspace-write"
    assert task_response.status_code == 200
    assert task_response.json()["sandbox_mode"] == "workspace-write"
    codex_node = next(
        node for node in graph_response.json()["nodes"] if node["name"] == "codex-node"
    )
    assert codex_node["agent_config"]["sandbox_mode"] == "danger-full-access"
