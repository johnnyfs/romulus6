import { test, expect } from '@playwright/test';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function createWorkspace(request: any): Promise<string> {
  const res = await request.post('/api/v1/workspaces', { data: { name: `Graph Test WS ${crypto.randomUUID()}` } });
  expect(res.status()).toBe(201);
  return (await res.json()).id;
}

async function deleteWorkspace(request: any, workspaceId: string) {
  await request.delete(`/api/v1/workspaces/${workspaceId}`);
}

test.describe('Graph API', () => {

  test('GET /graphs/{id}/export and POST /graphs/import round-trip a graph with dependent templates', async ({ request }) => {
    const sourceWid = await createWorkspace(request);
    const targetWid = await createWorkspace(request);
    try {
      const taskTemplateRes = await request.post(`/api/v1/workspaces/${sourceWid}/task-templates`, {
        data: {
          name: 'shared-task',
          task_type: 'agent',
          agent_type: 'opencode',
          model: 'anthropic/claude-haiku-4-5',
          prompt: 'Use {{ tone }}',
          arguments: [{ name: 'tone', arg_type: 'string', default_value: 'calm' }],
        },
      });
      expect(taskTemplateRes.status()).toBe(201);
      const taskTemplate = await taskTemplateRes.json();

      const childSubgraphRes = await request.post(`/api/v1/workspaces/${sourceWid}/subgraph-templates`, {
        data: {
          name: 'child-subgraph',
          nodes: [
            {
              node_type: 'task_template',
              name: 'child-task',
              task_template_id: taskTemplate.id,
              argument_bindings: { tone: 'friendly' },
            },
          ],
          edges: [],
        },
      });
      expect(childSubgraphRes.status()).toBe(201);
      const childSubgraph = await childSubgraphRes.json();

      const parentSubgraphRes = await request.post(`/api/v1/workspaces/${sourceWid}/subgraph-templates`, {
        data: {
          name: 'parent-subgraph',
          nodes: [
            {
              node_type: 'subgraph_template',
              name: 'nested-child',
              ref_subgraph_template_id: childSubgraph.id,
              argument_bindings: { tone: 'nested' },
            },
          ],
          edges: [],
        },
      });
      expect(parentSubgraphRes.status()).toBe(201);
      const parentSubgraph = await parentSubgraphRes.json();

      const graphRes = await request.post(`/api/v1/workspaces/${sourceWid}/graphs`, {
        data: {
          name: 'portable-graph',
          nodes: [
            {
              node_type: 'task_template',
              name: 'top-task',
              task_template_id: taskTemplate.id,
              argument_bindings: { tone: 'direct' },
            },
            {
              node_type: 'subgraph_template',
              name: 'top-subgraph',
              subgraph_template_id: parentSubgraph.id,
              argument_bindings: { tone: 'recursive' },
              output_schema: { result: 'string' },
            },
          ],
          edges: [{ from_index: 0, to_index: 1 }],
        },
      });
      expect(graphRes.status()).toBe(201);
      const graph = await graphRes.json();

      const exportRes = await request.get(`/api/v1/workspaces/${sourceWid}/graphs/${graph.id}/export`);
      expect(exportRes.status()).toBe(200);
      const bundle = await exportRes.json();
      expect(bundle.format).toBe('romulus.graph-bundle');
      expect(bundle.graph.name).toBe('portable-graph');
      expect(bundle.task_templates).toHaveLength(1);
      expect(bundle.subgraph_templates).toHaveLength(2);
      expect(bundle.graph.nodes[0].task_template_name).toBe('shared-task');
      expect(bundle.graph.nodes[1].subgraph_template_name).toBe('parent-subgraph');

      const importRes = await request.post(`/api/v1/workspaces/${targetWid}/graphs/import`, {
        data: { bundle },
      });
      expect(importRes.status()).toBe(201);
      const imported = await importRes.json();
      expect(imported.warnings).toEqual([]);
      expect(imported.graph.name).toBe('portable-graph');
      expect(imported.graph.nodes).toHaveLength(2);
      expect(imported.graph.edges).toHaveLength(1);

      const importedTaskTemplatesRes = await request.get(`/api/v1/workspaces/${targetWid}/task-templates`);
      expect(importedTaskTemplatesRes.status()).toBe(200);
      const importedTaskTemplates = await importedTaskTemplatesRes.json();
      expect(importedTaskTemplates).toHaveLength(1);
      expect(importedTaskTemplates[0].name).toBe('shared-task');

      const importedSubgraphsRes = await request.get(`/api/v1/workspaces/${targetWid}/subgraph-templates`);
      expect(importedSubgraphsRes.status()).toBe(200);
      const importedSubgraphs = await importedSubgraphsRes.json();
      expect(importedSubgraphs).toHaveLength(2);
      expect(importedSubgraphs.map((item: any) => item.name).sort()).toEqual(['child-subgraph', 'parent-subgraph']);
    } finally {
      await deleteWorkspace(request, sourceWid);
      await deleteWorkspace(request, targetWid);
    }
  });

  test('POST /graphs/import tolerates extra fields and falls back to template names when ids do not match', async ({ request }) => {
    const sourceWid = await createWorkspace(request);
    const targetWid = await createWorkspace(request);
    try {
      const taskTemplateRes = await request.post(`/api/v1/workspaces/${sourceWid}/task-templates`, {
        data: {
          name: 'portable-task',
          task_type: 'command',
          command: 'echo {{ value }}',
        },
      });
      expect(taskTemplateRes.status()).toBe(201);
      const taskTemplate = await taskTemplateRes.json();

      const subgraphRes = await request.post(`/api/v1/workspaces/${sourceWid}/subgraph-templates`, {
        data: {
          name: 'portable-subgraph',
          nodes: [
            {
              node_type: 'task_template',
              name: 'inner-task',
              task_template_id: taskTemplate.id,
            },
          ],
          edges: [],
        },
      });
      expect(subgraphRes.status()).toBe(201);
      const subgraph = await subgraphRes.json();

      const graphRes = await request.post(`/api/v1/workspaces/${sourceWid}/graphs`, {
        data: {
          name: 'tolerant-graph',
          nodes: [
            {
              node_type: 'task_template',
              name: 'graph-task',
              task_template_id: taskTemplate.id,
            },
            {
              node_type: 'subgraph_template',
              name: 'graph-subgraph',
              subgraph_template_id: subgraph.id,
            },
          ],
          edges: [{ from_index: 0, to_index: 1 }],
        },
      });
      expect(graphRes.status()).toBe(201);
      const graph = await graphRes.json();

      const exportRes = await request.get(`/api/v1/workspaces/${sourceWid}/graphs/${graph.id}/export`);
      expect(exportRes.status()).toBe(200);
      const bundle = await exportRes.json();

      bundle.version = 999;
      bundle.unrecognized_top_level = { keep: 'going' };
      bundle.task_templates[0].extra_field = 'ignored';
      bundle.subgraph_templates[0].nodes[0].task_template_id = '00000000-0000-4000-8000-000000000000';
      bundle.graph.nodes[0].task_template_id = '00000000-0000-4000-8000-000000000000';
      bundle.graph.nodes[1].subgraph_template_id = '00000000-0000-4000-8000-000000000000';
      bundle.graph.nodes.push({ id: crypto.randomUUID(), node_type: 'mystery_type', name: 'bad-node' });
      bundle.graph.edges.push({
        id: crypto.randomUUID(),
        from_node_id: bundle.graph.nodes.at(-1)!.id,
        to_node_id: bundle.graph.nodes[0].id,
      });

      const importRes = await request.post(`/api/v1/workspaces/${targetWid}/graphs/import`, {
        data: { bundle },
      });
      expect(importRes.status()).toBe(201);
      const imported = await importRes.json();
      expect(imported.graph.name).toBe('tolerant-graph');
      expect(imported.graph.nodes).toHaveLength(2);
      expect(imported.graph.edges).toHaveLength(1);
      expect(imported.warnings.some((warning: string) => warning.includes('newer than supported version'))).toBe(true);
      expect(imported.warnings.some((warning: string) => warning.includes("unknown node_type 'mystery_type'"))).toBe(true);
      expect(imported.warnings.some((warning: string) => warning.includes('skipped edge referencing a skipped node'))).toBe(true);

      const importedTaskTemplatesRes = await request.get(`/api/v1/workspaces/${targetWid}/task-templates`);
      expect(importedTaskTemplatesRes.status()).toBe(200);
      const importedTaskTemplates = await importedTaskTemplatesRes.json();
      expect(importedTaskTemplates).toHaveLength(1);
      expect(importedTaskTemplates[0].name).toBe('portable-task');
    } finally {
      await deleteWorkspace(request, sourceWid);
      await deleteWorkspace(request, targetWid);
    }
  });

  // --- Graph CRUD ---

  test('POST /graphs creates an empty graph and returns 201', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const res = await request.post(`/api/v1/workspaces/${wid}/graphs`, {
        data: { name: 'empty graph' },
      });
      expect(res.status()).toBe(201);
      const body = await res.json();
      expect(body.name).toBe('empty graph');
      expect(body.id).toMatch(UUID_RE);
      expect(body.workspace_id).toBe(wid);
      expect(body.nodes).toEqual([]);
      expect(body.edges).toEqual([]);

      await request.delete(`/api/v1/workspaces/${wid}/graphs/${body.id}`);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('POST /graphs creates a graph with nodes and edges', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const res = await request.post(`/api/v1/workspaces/${wid}/graphs`, {
        data: {
          name: 'graph with nodes',
          nodes: [{ node_type: 'command', command_config: { command: 'echo ok' } }, { node_type: 'command', command_config: { command: 'echo ok' } }],
          edges: [{ from_index: 0, to_index: 1 }],
        },
      });
      expect(res.status()).toBe(201);
      const body = await res.json();
      expect(body.nodes).toHaveLength(2);
      expect(body.edges).toHaveLength(1);
      expect(body.nodes[0].node_type).toBe('command');
      expect(body.edges[0].from_node_id).toBe(body.nodes[0].id);
      expect(body.edges[0].to_node_id).toBe(body.nodes[1].id);

      await request.delete(`/api/v1/workspaces/${wid}/graphs/${body.id}`);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('deleting a graph also deletes its run history', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const graphRes = await request.post(`/api/v1/workspaces/${wid}/graphs`, {
        data: {
          name: 'graph-delete-runs',
          nodes: [{ node_type: 'command', name: 'echo', command_config: { command: 'echo ok' } }],
          edges: [],
        },
      });
      expect(graphRes.status()).toBe(201);
      const graph = await graphRes.json();

      const createRunRes = await request.post(`/api/v1/workspaces/${wid}/graphs/${graph.id}/runs`);
      expect(createRunRes.status()).toBe(201);
      const run = await createRunRes.json();

      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const runRes = await request.get(`/api/v1/workspaces/${wid}/runs/${run.id}`);
        expect(runRes.status()).toBe(200);
        const currentRun = await runRes.json();
        if (currentRun.state === 'completed' || currentRun.state === 'error') break;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }

      const deleteRes = await request.delete(`/api/v1/workspaces/${wid}/graphs/${graph.id}`);
      expect(deleteRes.status()).toBe(204);

      const deletedRunRes = await request.get(`/api/v1/workspaces/${wid}/runs/${run.id}`);
      expect(deletedRunRes.status()).toBe(404);

      const eventsRes = await request.get(`/api/v1/workspaces/${wid}/events?since=0&limit=200`);
      expect(eventsRes.status()).toBe(200);
      const events = await eventsRes.json();
      expect(events.some((event: any) => event.run_id === run.id)).toBe(false);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('GET /graphs lists graphs', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const createRes = await request.post(`/api/v1/workspaces/${wid}/graphs`, {
        data: { name: 'listed graph' },
      });
      const graphId = (await createRes.json()).id;

      const listRes = await request.get(`/api/v1/workspaces/${wid}/graphs`);
      expect(listRes.status()).toBe(200);
      const list = await listRes.json();
      expect(Array.isArray(list)).toBe(true);
      expect(list.some((g: any) => g.id === graphId)).toBe(true);

      await request.delete(`/api/v1/workspaces/${wid}/graphs/${graphId}`);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('GET /graphs/{id} returns graph detail with nodes and edges', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const createRes = await request.post(`/api/v1/workspaces/${wid}/graphs`, {
        data: {
          name: 'detail graph',
          nodes: [{ node_type: 'command', command_config: { command: 'echo ok' } }],
          edges: [],
        },
      });
      const graphId = (await createRes.json()).id;

      const getRes = await request.get(`/api/v1/workspaces/${wid}/graphs/${graphId}`);
      expect(getRes.status()).toBe(200);
      const body = await getRes.json();
      expect(body.id).toBe(graphId);
      expect(body.nodes).toHaveLength(1);
      expect(body.edges).toHaveLength(0);

      await request.delete(`/api/v1/workspaces/${wid}/graphs/${graphId}`);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('PUT /graphs/{id} replaces name and node/edge set', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const createRes = await request.post(`/api/v1/workspaces/${wid}/graphs`, {
        data: {
          name: 'original',
          nodes: [{ node_type: 'command', command_config: { command: 'echo ok' } }, { node_type: 'command', command_config: { command: 'echo ok' } }],
          edges: [{ from_index: 0, to_index: 1 }],
        },
      });
      const original = await createRes.json();
      const oldNodeIds = original.nodes.map((n: any) => n.id);

      const putRes = await request.put(`/api/v1/workspaces/${wid}/graphs/${original.id}`, {
        data: {
          name: 'updated',
          nodes: [{ node_type: 'command', command_config: { command: 'echo ok' } }],
          edges: [],
        },
      });
      expect(putRes.status()).toBe(200);
      const updated = await putRes.json();
      expect(updated.name).toBe('updated');
      expect(updated.nodes).toHaveLength(1);
      expect(updated.edges).toHaveLength(0);
      // Old node IDs should not appear
      for (const oldId of oldNodeIds) {
        expect(updated.nodes.some((n: any) => n.id === oldId)).toBe(false);
      }

      await request.delete(`/api/v1/workspaces/${wid}/graphs/${original.id}`);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('DELETE /graphs/{id} returns 204 and subsequent GET returns 404', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const createRes = await request.post(`/api/v1/workspaces/${wid}/graphs`, {
        data: { name: 'to delete' },
      });
      const graphId = (await createRes.json()).id;

      const delRes = await request.delete(`/api/v1/workspaces/${wid}/graphs/${graphId}`);
      expect(delRes.status()).toBe(204);

      const getRes = await request.get(`/api/v1/workspaces/${wid}/graphs/${graphId}`);
      expect(getRes.status()).toBe(404);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  // --- Node sub-resource ---

  test('POST /graphs/{id}/nodes adds a node', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const createRes = await request.post(`/api/v1/workspaces/${wid}/graphs`, {
        data: { name: 'node test' },
      });
      const graphId = (await createRes.json()).id;

      const addRes = await request.post(`/api/v1/workspaces/${wid}/graphs/${graphId}/nodes`, {
        data: { node_type: 'command', command_config: { command: 'echo ok' } },
      });
      expect(addRes.status()).toBe(201);
      const node = await addRes.json();
      expect(node.id).toMatch(UUID_RE);
      expect(node.graph_id).toBe(graphId);
      expect(node.node_type).toBe('command');

      await request.delete(`/api/v1/workspaces/${wid}/graphs/${graphId}`);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('DELETE /graphs/{id}/nodes/{node_id} deletes a node and its edges', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const createRes = await request.post(`/api/v1/workspaces/${wid}/graphs`, {
        data: {
          name: 'node delete test',
          nodes: [{ node_type: 'command', command_config: { command: 'echo ok' } }, { node_type: 'command', command_config: { command: 'echo ok' } }],
          edges: [{ from_index: 0, to_index: 1 }],
        },
      });
      const graph = await createRes.json();
      const nodeToDelete = graph.nodes[0].id;
      const graphId = graph.id;

      const delRes = await request.delete(
        `/api/v1/workspaces/${wid}/graphs/${graphId}/nodes/${nodeToDelete}`
      );
      expect(delRes.status()).toBe(204);

      const getRes = await request.get(`/api/v1/workspaces/${wid}/graphs/${graphId}`);
      const updated = await getRes.json();
      expect(updated.nodes).toHaveLength(1);
      expect(updated.edges).toHaveLength(0); // edge also deleted

      await request.delete(`/api/v1/workspaces/${wid}/graphs/${graphId}`);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  // --- Edge sub-resource ---

  test('POST /graphs/{id}/edges adds an edge', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const createRes = await request.post(`/api/v1/workspaces/${wid}/graphs`, {
        data: {
          name: 'edge test',
          nodes: [{ node_type: 'command', command_config: { command: 'echo ok' } }, { node_type: 'command', command_config: { command: 'echo ok' } }],
          edges: [],
        },
      });
      const graph = await createRes.json();
      const [n0, n1] = graph.nodes;

      const addRes = await request.post(
        `/api/v1/workspaces/${wid}/graphs/${graph.id}/edges`,
        { data: { from_node_id: n0.id, to_node_id: n1.id } }
      );
      expect(addRes.status()).toBe(201);
      const edge = await addRes.json();
      expect(edge.from_node_id).toBe(n0.id);
      expect(edge.to_node_id).toBe(n1.id);

      await request.delete(`/api/v1/workspaces/${wid}/graphs/${graph.id}`);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('DELETE /graphs/{id}/edges/{edge_id} deletes an edge', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const createRes = await request.post(`/api/v1/workspaces/${wid}/graphs`, {
        data: {
          name: 'edge delete test',
          nodes: [{ node_type: 'command', command_config: { command: 'echo ok' } }, { node_type: 'command', command_config: { command: 'echo ok' } }],
          edges: [{ from_index: 0, to_index: 1 }],
        },
      });
      const graph = await createRes.json();
      const edgeId = graph.edges[0].id;

      const delRes = await request.delete(
        `/api/v1/workspaces/${wid}/graphs/${graph.id}/edges/${edgeId}`
      );
      expect(delRes.status()).toBe(204);

      const getRes = await request.get(`/api/v1/workspaces/${wid}/graphs/${graph.id}`);
      const updated = await getRes.json();
      expect(updated.edges).toHaveLength(0);

      await request.delete(`/api/v1/workspaces/${wid}/graphs/${graph.id}`);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('POST /edges with non-existent node returns 404', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const createRes = await request.post(`/api/v1/workspaces/${wid}/graphs`, {
        data: {
          name: 'edge 404 test',
          nodes: [{ node_type: 'command', command_config: { command: 'echo ok' } }],
          edges: [],
        },
      });
      const graph = await createRes.json();
      const realNodeId = graph.nodes[0].id;
      const fakeNodeId = '00000000-0000-4000-8000-000000000000';

      const res = await request.post(
        `/api/v1/workspaces/${wid}/graphs/${graph.id}/edges`,
        { data: { from_node_id: realNodeId, to_node_id: fakeNodeId } }
      );
      expect(res.status()).toBe(404);

      await request.delete(`/api/v1/workspaces/${wid}/graphs/${graph.id}`);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  // --- Cycle detection ---

  test('POST /graphs with a 3-cycle returns 422', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const res = await request.post(`/api/v1/workspaces/${wid}/graphs`, {
        data: {
          name: 'cyclic',
          nodes: [{ node_type: 'command', command_config: { command: 'echo ok' } }, { node_type: 'command', command_config: { command: 'echo ok' } }, { node_type: 'command', command_config: { command: 'echo ok' } }],
          edges: [
            { from_index: 0, to_index: 1 },
            { from_index: 1, to_index: 2 },
            { from_index: 2, to_index: 0 },
          ],
        },
      });
      expect(res.status()).toBe(422);
      const body = await res.json();
      expect(body.detail).toBe('cycle detected');
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('POST /graphs with a self-loop returns 422', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const res = await request.post(`/api/v1/workspaces/${wid}/graphs`, {
        data: {
          name: 'self-loop',
          nodes: [{ node_type: 'command', command_config: { command: 'echo ok' } }],
          edges: [{ from_index: 0, to_index: 0 }],
        },
      });
      expect(res.status()).toBe(422);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('PUT /graphs with cyclic edges returns 422', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const createRes = await request.post(`/api/v1/workspaces/${wid}/graphs`, {
        data: { name: 'valid initially' },
      });
      const graphId = (await createRes.json()).id;

      const putRes = await request.put(`/api/v1/workspaces/${wid}/graphs/${graphId}`, {
        data: {
          name: 'now cyclic',
          nodes: [{ node_type: 'command', command_config: { command: 'echo ok' } }, { node_type: 'command', command_config: { command: 'echo ok' } }],
          edges: [
            { from_index: 0, to_index: 1 },
            { from_index: 1, to_index: 0 },
          ],
        },
      });
      expect(putRes.status()).toBe(422);

      await request.delete(`/api/v1/workspaces/${wid}/graphs/${graphId}`);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('POST /edges that creates a cycle returns 422', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const createRes = await request.post(`/api/v1/workspaces/${wid}/graphs`, {
        data: {
          name: 'cycle via edge add',
          nodes: [{ node_type: 'command', command_config: { command: 'echo ok' } }, { node_type: 'command', command_config: { command: 'echo ok' } }],
          edges: [{ from_index: 0, to_index: 1 }],
        },
      });
      const graph = await createRes.json();
      const [n0, n1] = graph.nodes;

      // Adding 1→0 would create a cycle
      const res = await request.post(
        `/api/v1/workspaces/${wid}/graphs/${graph.id}/edges`,
        { data: { from_node_id: n1.id, to_node_id: n0.id } }
      );
      expect(res.status()).toBe(422);

      await request.delete(`/api/v1/workspaces/${wid}/graphs/${graph.id}`);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('POST /edges in a valid diamond DAG succeeds', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      // Diamond: 0→1, 0→2, 1→3, 2→3 — still a DAG
      const createRes = await request.post(`/api/v1/workspaces/${wid}/graphs`, {
        data: {
          name: 'diamond',
          nodes: [
            { node_type: 'command', command_config: { command: 'echo ok' } },
            { node_type: 'command', command_config: { command: 'echo ok' } },
            { node_type: 'command', command_config: { command: 'echo ok' } },
            { node_type: 'command', command_config: { command: 'echo ok' } },
          ],
          edges: [
            { from_index: 0, to_index: 1 },
            { from_index: 0, to_index: 2 },
            { from_index: 1, to_index: 3 },
            { from_index: 2, to_index: 3 },
          ],
        },
      });
      expect(createRes.status()).toBe(201);
      const graph = await createRes.json();
      expect(graph.edges).toHaveLength(4);

      await request.delete(`/api/v1/workspaces/${wid}/graphs/${graph.id}`);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  // --- 404 error cases ---

  test('GET /graphs/{non_existent} returns 404', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const res = await request.get(
        `/api/v1/workspaces/${wid}/graphs/00000000-0000-4000-8000-000000000000`
      );
      expect(res.status()).toBe(404);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('PUT /graphs/{non_existent} returns 404', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const res = await request.put(
        `/api/v1/workspaces/${wid}/graphs/00000000-0000-4000-8000-000000000000`,
        { data: { name: 'nope' } }
      );
      expect(res.status()).toBe(404);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('DELETE /graphs/{non_existent} returns 404', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const res = await request.delete(
        `/api/v1/workspaces/${wid}/graphs/00000000-0000-4000-8000-000000000000`
      );
      expect(res.status()).toBe(404);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('DELETE /nodes/{non_existent} returns 404', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const createRes = await request.post(`/api/v1/workspaces/${wid}/graphs`, {
        data: { name: 'node 404' },
      });
      const graphId = (await createRes.json()).id;

      const res = await request.delete(
        `/api/v1/workspaces/${wid}/graphs/${graphId}/nodes/00000000-0000-4000-8000-000000000000`
      );
      expect(res.status()).toBe(404);

      await request.delete(`/api/v1/workspaces/${wid}/graphs/${graphId}`);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  // --- Agent node type ---

  test('POST /graphs creates a graph with an agent node', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const agentConfig = {
        agent_type: 'opencode',
        model: 'anthropic/claude-haiku-4-5',
        prompt: 'do stuff',
      };
      const res = await request.post(`/api/v1/workspaces/${wid}/graphs`, {
        data: {
          name: 'agent graph',
          nodes: [{ node_type: 'agent', name: 'my-agent', agent_config: agentConfig }],
          edges: [],
        },
      });
      expect(res.status()).toBe(201);
      const body = await res.json();
      expect(body.nodes).toHaveLength(1);
      expect(body.nodes[0].node_type).toBe('agent');
      expect(body.nodes[0].name).toBe('my-agent');
      expect(body.nodes[0].agent_config).toMatchObject(agentConfig);

      await request.delete(`/api/v1/workspaces/${wid}/graphs/${body.id}`);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('POST /nodes adds an agent node to an existing graph', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const createRes = await request.post(`/api/v1/workspaces/${wid}/graphs`, {
        data: { name: 'add-agent-node' },
      });
      const graph = await createRes.json();

      const agentConfig = {
        agent_type: 'opencode',
        model: 'anthropic/claude-haiku-4-5',
        prompt: 'hello',
      };
      const nodeRes = await request.post(
        `/api/v1/workspaces/${wid}/graphs/${graph.id}/nodes`,
        { data: { node_type: 'agent', name: 'a1', agent_config: agentConfig } },
      );
      expect(nodeRes.status()).toBe(201);
      const node = await nodeRes.json();
      expect(node.node_type).toBe('agent');
      expect(node.agent_config).toMatchObject(agentConfig);

      await request.delete(`/api/v1/workspaces/${wid}/graphs/${graph.id}`);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('PATCH /nodes updates agent config on a node', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const agentConfig = {
        agent_type: 'opencode',
        model: 'anthropic/claude-haiku-4-5',
        prompt: 'original',
      };
      const createRes = await request.post(`/api/v1/workspaces/${wid}/graphs`, {
        data: {
          name: 'patch-agent',
          nodes: [{ node_type: 'agent', name: 'a1', agent_config: agentConfig }],
          edges: [],
        },
      });
      const graph = await createRes.json();
      const nodeId = graph.nodes[0].id;

      const updatedConfig = {
        agent_type: 'opencode',
        model: 'anthropic/claude-sonnet-4-6',
        prompt: 'updated',
      };
      const patchRes = await request.patch(
        `/api/v1/workspaces/${wid}/graphs/${graph.id}/nodes/${nodeId}`,
        { data: { agent_config: updatedConfig } },
      );
      expect(patchRes.status()).toBe(200);
      const patched = await patchRes.json();
      expect(patched.agent_config).toMatchObject(updatedConfig);

      await request.delete(`/api/v1/workspaces/${wid}/graphs/${graph.id}`);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  // --- Command node type ---

  test('POST /graphs creates a graph with a command node', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const commandConfig = { command: 'echo hello\nls -la' };
      const res = await request.post(`/api/v1/workspaces/${wid}/graphs`, {
        data: {
          name: 'command graph',
          nodes: [{ node_type: 'command', name: 'my-cmd', command_config: commandConfig }],
          edges: [],
        },
      });
      expect(res.status()).toBe(201);
      const body = await res.json();
      expect(body.nodes).toHaveLength(1);
      expect(body.nodes[0].node_type).toBe('command');
      expect(body.nodes[0].name).toBe('my-cmd');
      expect(body.nodes[0].command_config).toMatchObject(commandConfig);
      expect(body.nodes[0].agent_config).toBeNull();

      await request.delete(`/api/v1/workspaces/${wid}/graphs/${body.id}`);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('POST /nodes adds a command node to an existing graph', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const createRes = await request.post(`/api/v1/workspaces/${wid}/graphs`, {
        data: { name: 'add-cmd-node' },
      });
      const graph = await createRes.json();

      const commandConfig = { command: 'whoami' };
      const nodeRes = await request.post(
        `/api/v1/workspaces/${wid}/graphs/${graph.id}/nodes`,
        { data: { node_type: 'command', name: 'c1', command_config: commandConfig } },
      );
      expect(nodeRes.status()).toBe(201);
      const node = await nodeRes.json();
      expect(node.node_type).toBe('command');
      expect(node.command_config).toMatchObject(commandConfig);

      await request.delete(`/api/v1/workspaces/${wid}/graphs/${graph.id}`);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('PATCH /nodes updates command config on a node', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const commandConfig = { command: 'echo original' };
      const createRes = await request.post(`/api/v1/workspaces/${wid}/graphs`, {
        data: {
          name: 'patch-cmd',
          nodes: [{ node_type: 'command', name: 'c1', command_config: commandConfig }],
          edges: [],
        },
      });
      const graph = await createRes.json();
      const nodeId = graph.nodes[0].id;

      const updatedConfig = { command: 'echo updated\npwd' };
      const patchRes = await request.patch(
        `/api/v1/workspaces/${wid}/graphs/${graph.id}/nodes/${nodeId}`,
        { data: { command_config: updatedConfig } },
      );
      expect(patchRes.status()).toBe(200);
      const patched = await patchRes.json();
      expect(patched.command_config).toMatchObject(updatedConfig);

      await request.delete(`/api/v1/workspaces/${wid}/graphs/${graph.id}`);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('command nodes have null agent_config', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const res = await request.post(`/api/v1/workspaces/${wid}/graphs`, {
        data: {
          name: 'cmd-null-agent',
          nodes: [{ node_type: 'command', name: 'c1', command_config: { command: 'ls' } }],
          edges: [],
        },
      });
      expect(res.status()).toBe(201);
      const body = await res.json();
      expect(body.nodes[0].agent_config).toBeNull();
      expect(body.nodes[0].command_config).toMatchObject({ command: 'ls' });

      await request.delete(`/api/v1/workspaces/${wid}/graphs/${body.id}`);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  // --- 404 cases ---

  test('DELETE /edges/{non_existent} returns 404', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const createRes = await request.post(`/api/v1/workspaces/${wid}/graphs`, {
        data: { name: 'edge 404' },
      });
      const graphId = (await createRes.json()).id;

      const res = await request.delete(
        `/api/v1/workspaces/${wid}/graphs/${graphId}/edges/00000000-0000-4000-8000-000000000000`
      );
      expect(res.status()).toBe(404);

      await request.delete(`/api/v1/workspaces/${wid}/graphs/${graphId}`);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

});
