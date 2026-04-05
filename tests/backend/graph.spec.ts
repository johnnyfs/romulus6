import { test, expect } from '@playwright/test';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function createWorkspace(request: any): Promise<string> {
  const res = await request.post('/api/v1/workspaces', { data: { name: 'Graph Test WS' } });
  expect(res.status()).toBe(201);
  return (await res.json()).id;
}

async function deleteWorkspace(request: any, workspaceId: string) {
  await request.delete(`/api/v1/workspaces/${workspaceId}`);
}

test.describe('Graph API', () => {

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
          nodes: [{ node_type: 'nop' }, { node_type: 'nop' }],
          edges: [{ from_index: 0, to_index: 1 }],
        },
      });
      expect(res.status()).toBe(201);
      const body = await res.json();
      expect(body.nodes).toHaveLength(2);
      expect(body.edges).toHaveLength(1);
      expect(body.nodes[0].node_type).toBe('nop');
      expect(body.edges[0].from_node_id).toBe(body.nodes[0].id);
      expect(body.edges[0].to_node_id).toBe(body.nodes[1].id);

      await request.delete(`/api/v1/workspaces/${wid}/graphs/${body.id}`);
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
          nodes: [{ node_type: 'nop' }],
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
          nodes: [{ node_type: 'nop' }, { node_type: 'nop' }],
          edges: [{ from_index: 0, to_index: 1 }],
        },
      });
      const original = await createRes.json();
      const oldNodeIds = original.nodes.map((n: any) => n.id);

      const putRes = await request.put(`/api/v1/workspaces/${wid}/graphs/${original.id}`, {
        data: {
          name: 'updated',
          nodes: [{ node_type: 'nop' }],
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
        data: { node_type: 'nop' },
      });
      expect(addRes.status()).toBe(201);
      const node = await addRes.json();
      expect(node.id).toMatch(UUID_RE);
      expect(node.graph_id).toBe(graphId);
      expect(node.node_type).toBe('nop');

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
          nodes: [{ node_type: 'nop' }, { node_type: 'nop' }],
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
          nodes: [{ node_type: 'nop' }, { node_type: 'nop' }],
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
          nodes: [{ node_type: 'nop' }, { node_type: 'nop' }],
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
          nodes: [{ node_type: 'nop' }],
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
          nodes: [{ node_type: 'nop' }, { node_type: 'nop' }, { node_type: 'nop' }],
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
          nodes: [{ node_type: 'nop' }],
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
          nodes: [{ node_type: 'nop' }, { node_type: 'nop' }],
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
          nodes: [{ node_type: 'nop' }, { node_type: 'nop' }],
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
            { node_type: 'nop' },
            { node_type: 'nop' },
            { node_type: 'nop' },
            { node_type: 'nop' },
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

  test('nop nodes have null agent_config', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const res = await request.post(`/api/v1/workspaces/${wid}/graphs`, {
        data: {
          name: 'nop-null-config',
          nodes: [{ node_type: 'nop', name: 'n1' }],
          edges: [],
        },
      });
      expect(res.status()).toBe(201);
      const body = await res.json();
      expect(body.nodes[0].agent_config).toBeNull();

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
