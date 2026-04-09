import uuid

import pytest
from sqlmodel import select

from app.models.agent import Agent, AgentStatus, AgentType
from app.models.event import Event
from app.models.graph import Graph, GraphEdge, GraphNode, NodeType
from app.models.lease import WorkerLease, WorkerLeaseStatus
from app.models.reconcile import RunReconcile
from app.models.run import GraphRun, GraphRunNode
from app.models.sandbox import Sandbox
from app.models.template import (
    SubgraphTemplate,
    SubgraphTemplateEdge,
    SubgraphTemplateNode,
    SubgraphTemplateNodeType,
    TaskTemplate,
)
from app.models.worker import Worker, WorkerStatus
from app.models.workspace import Workspace
from app.services import graphs as graph_svc
from app.services import runs as run_svc
from app.services import templates as template_svc
from app.services import workspaces as workspace_svc
from app.services.graphs import EdgeInput, NodeInput
from app.services.templates import SubgraphNodeInput

pytestmark = pytest.mark.fast


def test_create_graph_rejects_cross_workspace_task_template_reference(session):
    source_workspace = workspace_svc.create_workspace(session, "source")
    target_workspace = workspace_svc.create_workspace(session, "target")
    external_template = template_svc.create_task_template(
        session,
        workspace_id=target_workspace.id,
        name="external-command",
        task_type=NodeType.command,
        command="echo hello",
    )

    with pytest.raises(ValueError, match="does not belong to workspace"):
        graph_svc.create_graph(
            session,
            workspace_id=source_workspace.id,
            name="invalid-graph",
            nodes=[
                NodeInput(
                    node_type=NodeType.task_template,
                    name="bad-ref",
                    task_template_id=external_template.id,
                )
            ],
            edges=[],
        )


def test_create_run_rejects_legacy_cross_workspace_template_reference(session):
    source_workspace = workspace_svc.create_workspace(session, "source")
    target_workspace = workspace_svc.create_workspace(session, "target")
    external_template = template_svc.create_task_template(
        session,
        workspace_id=target_workspace.id,
        name="external-command",
        task_type=NodeType.command,
        command="echo hello",
    )

    graph = Graph(workspace_id=source_workspace.id, name="legacy-graph")
    session.add(graph)
    session.flush()
    session.add(
        GraphNode(
            graph_id=graph.id,
            node_type=NodeType.task_template,
            name="bad-ref",
            task_template_id=external_template.id,
        )
    )
    session.commit()
    session.refresh(graph)

    with pytest.raises(ValueError, match="does not belong to workspace"):
        graph_svc.create_run(session, graph)


def test_delete_workspace_removes_complex_relation_chain(session, now):
    workspace = workspace_svc.create_workspace(session, "main")
    worker = Worker(
        status=WorkerStatus.running,
        worker_url="http://worker.test",
        worker_metadata={},
        last_heartbeat_at=now,
    )
    session.add(worker)
    session.flush()

    sandbox = Sandbox(
        workspace_id=workspace.id,
        name="shared-sandbox",
        worker_id=worker.id,
    )
    session.add(sandbox)
    session.flush()

    lease = WorkerLease(
        workspace_id=workspace.id,
        sandbox_id=sandbox.id,
        worker_id=worker.id,
        status=WorkerLeaseStatus.active,
        leased_at=now,
    )
    session.add(lease)
    session.flush()

    sandbox.current_lease_id = lease.id
    session.add(sandbox)

    launched_agent = Agent(
        workspace_id=workspace.id,
        sandbox_id=sandbox.id,
        agent_type=AgentType.opencode,
        model="openai/gpt-4o",
        status=AgentStatus.idle,
        name="launched-agent",
        prompt="do work",
    )
    session.add(launched_agent)
    session.flush()

    task_template = template_svc.create_task_template(
        session,
        workspace_id=workspace.id,
        name="command-task",
        task_type=NodeType.command,
        command="echo task",
    )
    subgraph_template = template_svc.create_subgraph_template(
        session,
        workspace_id=workspace.id,
        name="nested-subgraph",
        nodes=[
            SubgraphNodeInput(
                node_type=SubgraphTemplateNodeType.task_template,
                name="templated-command",
                task_template_id=task_template.id,
            )
        ],
        edges=[],
    )
    graph = graph_svc.create_graph(
        session,
        workspace_id=workspace.id,
        name="main-graph",
        nodes=[
            NodeInput(
                node_type=NodeType.subgraph_template,
                name="nested",
                subgraph_template_id=subgraph_template.id,
            ),
            NodeInput(
                node_type=NodeType.command,
                name="tail-command",
                command="echo tail",
            ),
        ],
        edges=[EdgeInput(from_index=0, to_index=1)],
    )
    run = graph_svc.create_run(session, graph)
    run.sandbox_id = sandbox.id
    session.add(run)
    session.flush()

    tail_node = next(
        node
        for node in run.run_nodes
        if node.name == "tail-command"
    )
    tail_node.agent_id = launched_agent.id
    tail_node.session_id = "session-tail"
    session.add(tail_node)
    session.flush()

    retry_node = GraphRunNode(
        run_id=run.id,
        source_node_id=tail_node.source_node_id,
        source_type=tail_node.source_type,
        attempt=tail_node.attempt + 1,
        retry_of_run_node_id=tail_node.id,
        node_type=tail_node.node_type,
        name=f"{tail_node.name}-retry",
        state="pending",
        command=tail_node.command,
    )
    session.add(retry_node)
    session.flush()

    tail_node.next_attempt_run_node_id = retry_node.id
    session.add(tail_node)

    event = Event(
        id=str(uuid.uuid4()),
        workspace_id=workspace.id,
        type="agent",
        source_id=str(launched_agent.id),
        session_id=tail_node.session_id,
        agent_id=launched_agent.id,
        run_id=run.id,
        node_id=tail_node.id,
        sandbox_id=sandbox.id,
        worker_id=worker.id,
        event_type="session.idle",
        timestamp=now.isoformat(),
        source_name=launched_agent.name,
        data={"data": {"message": "hello"}},
    )
    session.add(event)
    session.flush()

    reconcile = RunReconcile(run_id=run.id, reason="test cleanup")
    session.add(reconcile)
    session.commit()

    assert workspace_svc.delete_workspace(session, workspace.id) is True

    assert session.exec(select(Workspace)).all() == []
    assert session.exec(select(Graph)).all() == []
    assert session.exec(select(GraphNode)).all() == []
    assert session.exec(select(GraphEdge)).all() == []
    assert session.exec(select(GraphRun)).all() == []
    assert session.exec(select(GraphRunNode)).all() == []
    assert session.exec(select(TaskTemplate)).all() == []
    assert session.exec(select(SubgraphTemplate)).all() == []
    assert session.exec(select(SubgraphTemplateNode)).all() == []
    assert session.exec(select(SubgraphTemplateEdge)).all() == []
    assert session.exec(select(Sandbox)).all() == []
    assert session.exec(select(WorkerLease)).all() == []
    assert session.exec(select(Agent)).all() == []
    assert session.exec(select(Event)).all() == []
    assert session.exec(select(RunReconcile)).all() == []
    assert session.get(Worker, worker.id) is not None


def test_complete_node_emits_lifecycle_event(session):
    workspace = workspace_svc.create_workspace(session, "events")
    graph = Graph(workspace_id=workspace.id, name="event-graph")
    session.add(graph)
    session.flush()

    run = GraphRun(graph_id=graph.id, workspace_id=workspace.id, state="running")
    session.add(run)
    session.flush()

    node = GraphRunNode(
        run_id=run.id,
        node_type="command",
        name="eventful-node",
        state="running",
    )
    session.add(node)
    session.commit()

    run_svc.complete_node(session, run.id, node.id, output={"status": "ok"})

    events = session.exec(
        select(Event)
        .where(Event.run_id == run.id)
        .order_by(Event.received_at.asc(), Event.id.asc())
    ).all()
    assert [event.event_type for event in events] == ["run.node.completed"]
    assert events[0].data["data"]["output"] == {"status": "ok"}
