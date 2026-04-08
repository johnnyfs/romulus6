import { test, expect } from '@playwright/test';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function createWorkspace(request: any): Promise<string> {
  const res = await request.post('/api/v1/workspaces', { data: { name: `Template Test WS ${crypto.randomUUID()}` } });
  expect(res.status()).toBe(201);
  return (await res.json()).id;
}

async function deleteWorkspace(request: any, workspaceId: string) {
  await request.delete(`/api/v1/workspaces/${workspaceId}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Task Template CRUD
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('Task Template API', () => {

  test('POST /task-templates creates an agent task template with arguments', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const res = await request.post(`/api/v1/workspaces/${wid}/task-templates`, {
        data: {
          name: 'my-agent-template',
          task_type: 'agent',
          agent_type: 'opencode',
          model: '{{ model_arg }}',
          prompt: 'You are {{ role }}',
          graph_tools: false,
          arguments: [
            { name: 'model_arg', arg_type: 'model_type', default_value: 'anthropic/claude-haiku-4-5' },
            { name: 'role', arg_type: 'string' },
          ],
        },
      });
      expect(res.status()).toBe(201);
      const body = await res.json();
      expect(body.id).toMatch(UUID_RE);
      expect(body.name).toBe('my-agent-template');
      expect(body.task_type).toBe('agent');
      expect(body.model).toBe('{{ model_arg }}');
      expect(body.prompt).toBe('You are {{ role }}');
      expect(body.arguments).toHaveLength(2);
      expect(body.arguments[0].name).toBe('model_arg');
      expect(body.arguments[0].arg_type).toBe('model_type');
      expect(body.arguments[1].name).toBe('role');

      await request.delete(`/api/v1/workspaces/${wid}/task-templates/${body.id}`);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('POST /task-templates creates a command task template', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const res = await request.post(`/api/v1/workspaces/${wid}/task-templates`, {
        data: {
          name: 'my-cmd-template',
          task_type: 'command',
          command: 'echo {{ message }}',
        },
      });
      expect(res.status()).toBe(201);
      const body = await res.json();
      expect(body.task_type).toBe('command');
      expect(body.command).toBe('echo {{ message }}');

      await request.delete(`/api/v1/workspaces/${wid}/task-templates/${body.id}`);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('POST /task-templates rejects template-realizing task types', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const res = await request.post(`/api/v1/workspaces/${wid}/task-templates`, {
        data: {
          name: 'bad-template',
          task_type: 'subgraph_template',
        },
      });
      expect(res.status()).toBe(422);
      expect(await res.text()).toContain('task templates may only realize concrete node types');
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('GET /task-templates lists task templates', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const createRes = await request.post(`/api/v1/workspaces/${wid}/task-templates`, {
        data: { name: 'listed', task_type: 'agent' },
      });
      const tmplId = (await createRes.json()).id;

      const listRes = await request.get(`/api/v1/workspaces/${wid}/task-templates`);
      expect(listRes.status()).toBe(200);
      const list = await listRes.json();
      expect(list.some((t: any) => t.id === tmplId)).toBe(true);

      await request.delete(`/api/v1/workspaces/${wid}/task-templates/${tmplId}`);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('GET /task-templates/{id} returns detail with arguments', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const createRes = await request.post(`/api/v1/workspaces/${wid}/task-templates`, {
        data: {
          name: 'detail-test',
          task_type: 'agent',
          arguments: [{ name: 'arg1', arg_type: 'string', default_value: 'hello' }],
        },
      });
      const tmpl = await createRes.json();

      const getRes = await request.get(`/api/v1/workspaces/${wid}/task-templates/${tmpl.id}`);
      expect(getRes.status()).toBe(200);
      const body = await getRes.json();
      expect(body.id).toBe(tmpl.id);
      expect(body.arguments).toHaveLength(1);
      expect(body.arguments[0].default_value).toBe('hello');

      await request.delete(`/api/v1/workspaces/${wid}/task-templates/${tmpl.id}`);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('PUT /task-templates/{id} replaces template', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const createRes = await request.post(`/api/v1/workspaces/${wid}/task-templates`, {
        data: { name: 'original', task_type: 'agent', prompt: 'old' },
      });
      const tmpl = await createRes.json();

      const putRes = await request.put(`/api/v1/workspaces/${wid}/task-templates/${tmpl.id}`, {
        data: { name: 'updated', task_type: 'command', command: 'echo new' },
      });
      expect(putRes.status()).toBe(200);
      const updated = await putRes.json();
      expect(updated.name).toBe('updated');
      expect(updated.task_type).toBe('command');
      expect(updated.command).toBe('echo new');

      await request.delete(`/api/v1/workspaces/${wid}/task-templates/${tmpl.id}`);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('DELETE /task-templates/{id} returns 204 and subsequent GET returns 404', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const createRes = await request.post(`/api/v1/workspaces/${wid}/task-templates`, {
        data: { name: 'to-delete', task_type: 'agent' },
      });
      const tmplId = (await createRes.json()).id;

      const delRes = await request.delete(`/api/v1/workspaces/${wid}/task-templates/${tmplId}`);
      expect(delRes.status()).toBe(204);

      const getRes = await request.get(`/api/v1/workspaces/${wid}/task-templates/${tmplId}`);
      expect(getRes.status()).toBe(404);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('GET /task-templates/{non_existent} returns 404', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const res = await request.get(`/api/v1/workspaces/${wid}/task-templates/00000000-0000-4000-8000-000000000000`);
      expect(res.status()).toBe(404);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// Subgraph Template CRUD
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('Subgraph Template API', () => {

  test('POST /subgraph-templates creates an empty subgraph template', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const res = await request.post(`/api/v1/workspaces/${wid}/subgraph-templates`, {
        data: { name: 'empty-sg' },
      });
      expect(res.status()).toBe(201);
      const body = await res.json();
      expect(body.id).toMatch(UUID_RE);
      expect(body.name).toBe('empty-sg');
      expect(body.nodes).toEqual([]);
      expect(body.edges).toEqual([]);

      await request.delete(`/api/v1/workspaces/${wid}/subgraph-templates/${body.id}`);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('POST /subgraph-templates creates with nodes and edges', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      // Create a task template to reference
      const ttRes = await request.post(`/api/v1/workspaces/${wid}/task-templates`, {
        data: { name: 'ref-task', task_type: 'agent' },
      });
      const taskTmpl = await ttRes.json();

      const res = await request.post(`/api/v1/workspaces/${wid}/subgraph-templates`, {
        data: {
          name: 'with-nodes',
          nodes: [
            { node_type: 'task_template', name: 'n1', task_template_id: taskTmpl.id },
            { node_type: 'task_template', name: 'n2', task_template_id: taskTmpl.id },
          ],
          edges: [{ from_index: 0, to_index: 1 }],
        },
      });
      expect(res.status()).toBe(201);
      const body = await res.json();
      expect(body.nodes).toHaveLength(2);
      expect(body.edges).toHaveLength(1);
      expect(body.edges[0].from_node_id).toBe(body.nodes[0].id);
      expect(body.edges[0].to_node_id).toBe(body.nodes[1].id);

      await request.delete(`/api/v1/workspaces/${wid}/subgraph-templates/${body.id}`);
      await request.delete(`/api/v1/workspaces/${wid}/task-templates/${taskTmpl.id}`);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('GET /subgraph-templates lists templates', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const createRes = await request.post(`/api/v1/workspaces/${wid}/subgraph-templates`, {
        data: { name: 'listed-sg' },
      });
      const sgId = (await createRes.json()).id;

      const listRes = await request.get(`/api/v1/workspaces/${wid}/subgraph-templates`);
      expect(listRes.status()).toBe(200);
      const list = await listRes.json();
      expect(list.some((t: any) => t.id === sgId)).toBe(true);

      await request.delete(`/api/v1/workspaces/${wid}/subgraph-templates/${sgId}`);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('GET /subgraph-templates/{id} returns detail', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const createRes = await request.post(`/api/v1/workspaces/${wid}/subgraph-templates`, {
        data: {
          name: 'detail-sg',
          arguments: [{ name: 'sg_arg', arg_type: 'string' }],
        },
      });
      const sg = await createRes.json();

      const getRes = await request.get(`/api/v1/workspaces/${wid}/subgraph-templates/${sg.id}`);
      expect(getRes.status()).toBe(200);
      const body = await getRes.json();
      expect(body.id).toBe(sg.id);
      expect(body.arguments).toHaveLength(1);
      expect(body.arguments[0].name).toBe('sg_arg');

      await request.delete(`/api/v1/workspaces/${wid}/subgraph-templates/${sg.id}`);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('PUT /subgraph-templates/{id} replaces template', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const createRes = await request.post(`/api/v1/workspaces/${wid}/subgraph-templates`, {
        data: {
          name: 'original-sg',
          nodes: [{ node_type: 'task_template' }],
          edges: [],
        },
      });
      const sg = await createRes.json();

      const putRes = await request.put(`/api/v1/workspaces/${wid}/subgraph-templates/${sg.id}`, {
        data: { name: 'updated-sg', nodes: [], edges: [] },
      });
      expect(putRes.status()).toBe(200);
      const updated = await putRes.json();
      expect(updated.name).toBe('updated-sg');
      expect(updated.nodes).toHaveLength(0);

      await request.delete(`/api/v1/workspaces/${wid}/subgraph-templates/${sg.id}`);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('DELETE /subgraph-templates/{id} returns 204 then GET returns 404', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const createRes = await request.post(`/api/v1/workspaces/${wid}/subgraph-templates`, {
        data: { name: 'to-delete-sg' },
      });
      const sgId = (await createRes.json()).id;

      const delRes = await request.delete(`/api/v1/workspaces/${wid}/subgraph-templates/${sgId}`);
      expect(delRes.status()).toBe(204);

      const getRes = await request.get(`/api/v1/workspaces/${wid}/subgraph-templates/${sgId}`);
      expect(getRes.status()).toBe(404);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  // --- Node sub-resource ---

  test('POST /subgraph-templates/{id}/nodes adds a task_template node', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const sgRes = await request.post(`/api/v1/workspaces/${wid}/subgraph-templates`, {
        data: { name: 'node-test-sg' },
      });
      const sg = await sgRes.json();

      const nodeRes = await request.post(`/api/v1/workspaces/${wid}/subgraph-templates/${sg.id}/nodes`, {
        data: { node_type: 'task_template', name: 'n1' },
      });
      expect(nodeRes.status()).toBe(201);
      const node = await nodeRes.json();
      expect(node.node_type).toBe('task_template');
      expect(node.name).toBe('n1');

      await request.delete(`/api/v1/workspaces/${wid}/subgraph-templates/${sg.id}`);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('POST /subgraph-templates/{id}/nodes adds a subgraph_template node', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      // Create two subgraph templates: A and B. Add node in A referencing B.
      const sgARes = await request.post(`/api/v1/workspaces/${wid}/subgraph-templates`, { data: { name: 'sg-A' } });
      const sgA = await sgARes.json();
      const sgBRes = await request.post(`/api/v1/workspaces/${wid}/subgraph-templates`, { data: { name: 'sg-B' } });
      const sgB = await sgBRes.json();

      const nodeRes = await request.post(`/api/v1/workspaces/${wid}/subgraph-templates/${sgA.id}/nodes`, {
        data: { node_type: 'subgraph_template', name: 'ref-b', ref_subgraph_template_id: sgB.id },
      });
      expect(nodeRes.status()).toBe(201);
      const node = await nodeRes.json();
      expect(node.node_type).toBe('subgraph_template');
      expect(node.ref_subgraph_template_id).toBe(sgB.id);

      await request.delete(`/api/v1/workspaces/${wid}/subgraph-templates/${sgA.id}`);
      await request.delete(`/api/v1/workspaces/${wid}/subgraph-templates/${sgB.id}`);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('PATCH /subgraph-templates/{id}/nodes/{node_id} updates node', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const sgRes = await request.post(`/api/v1/workspaces/${wid}/subgraph-templates`, {
        data: { name: 'patch-node-sg' },
      });
      const sg = await sgRes.json();

      const nodeRes = await request.post(`/api/v1/workspaces/${wid}/subgraph-templates/${sg.id}/nodes`, {
        data: { node_type: 'task_template', name: 'old-name' },
      });
      const node = await nodeRes.json();

      const patchRes = await request.patch(`/api/v1/workspaces/${wid}/subgraph-templates/${sg.id}/nodes/${node.id}`, {
        data: { name: 'new-name' },
      });
      expect(patchRes.status()).toBe(200);
      const patched = await patchRes.json();
      expect(patched.name).toBe('new-name');

      await request.delete(`/api/v1/workspaces/${wid}/subgraph-templates/${sg.id}`);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('PATCH /subgraph-templates/{id}/nodes/{node_id} updates node to view type', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const sgRes = await request.post(`/api/v1/workspaces/${wid}/subgraph-templates`, {
        data: { name: 'patch-view-node-sg' },
      });
      const sg = await sgRes.json();

      const nodeRes = await request.post(`/api/v1/workspaces/${wid}/subgraph-templates/${sg.id}/nodes`, {
        data: { node_type: 'agent', name: 'asset-viewer' },
      });
      const node = await nodeRes.json();

      const patchRes = await request.patch(
        `/api/v1/workspaces/${wid}/subgraph-templates/${sg.id}/nodes/${node.id}`,
        {
          data: {
            node_type: 'view',
            view_config: {
              images: [
                { type: 'url', url: '{{ asset_path }}' },
              ],
            },
          },
        },
      );
      expect(patchRes.status()).toBe(200);
      const patched = await patchRes.json();
      expect(patched.node_type).toBe('view');
      expect(patched.agent_config).toBeNull();
      expect(patched.command_config).toBeNull();
      expect(patched.view_config).toEqual({
        images: [
          { type: 'url', url: '{{ asset_path }}', path: null },
        ],
      });

      await request.delete(`/api/v1/workspaces/${wid}/subgraph-templates/${sg.id}`);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('DELETE /subgraph-templates/{id}/nodes/{node_id} deletes node and its edges', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const sgRes = await request.post(`/api/v1/workspaces/${wid}/subgraph-templates`, {
        data: {
          name: 'del-node-sg',
          nodes: [{ node_type: 'task_template' }, { node_type: 'task_template' }],
          edges: [{ from_index: 0, to_index: 1 }],
        },
      });
      const sg = await sgRes.json();
      const nodeToDelete = sg.nodes[0].id;

      const delRes = await request.delete(`/api/v1/workspaces/${wid}/subgraph-templates/${sg.id}/nodes/${nodeToDelete}`);
      expect(delRes.status()).toBe(204);

      const getRes = await request.get(`/api/v1/workspaces/${wid}/subgraph-templates/${sg.id}`);
      const updated = await getRes.json();
      expect(updated.nodes).toHaveLength(1);
      expect(updated.edges).toHaveLength(0);

      await request.delete(`/api/v1/workspaces/${wid}/subgraph-templates/${sg.id}`);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  // --- Edge sub-resource ---

  test('POST /subgraph-templates/{id}/edges adds an edge', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const sgRes = await request.post(`/api/v1/workspaces/${wid}/subgraph-templates`, {
        data: {
          name: 'edge-test-sg',
          nodes: [{ node_type: 'task_template' }, { node_type: 'task_template' }],
          edges: [],
        },
      });
      const sg = await sgRes.json();
      const [n0, n1] = sg.nodes;

      const edgeRes = await request.post(`/api/v1/workspaces/${wid}/subgraph-templates/${sg.id}/edges`, {
        data: { from_node_id: n0.id, to_node_id: n1.id },
      });
      expect(edgeRes.status()).toBe(201);
      const edge = await edgeRes.json();
      expect(edge.from_node_id).toBe(n0.id);
      expect(edge.to_node_id).toBe(n1.id);

      await request.delete(`/api/v1/workspaces/${wid}/subgraph-templates/${sg.id}`);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('DELETE /subgraph-templates/{id}/edges/{edge_id} deletes an edge', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const sgRes = await request.post(`/api/v1/workspaces/${wid}/subgraph-templates`, {
        data: {
          name: 'edge-del-sg',
          nodes: [{ node_type: 'task_template' }, { node_type: 'task_template' }],
          edges: [{ from_index: 0, to_index: 1 }],
        },
      });
      const sg = await sgRes.json();
      const edgeId = sg.edges[0].id;

      const delRes = await request.delete(`/api/v1/workspaces/${wid}/subgraph-templates/${sg.id}/edges/${edgeId}`);
      expect(delRes.status()).toBe(204);

      const getRes = await request.get(`/api/v1/workspaces/${wid}/subgraph-templates/${sg.id}`);
      const updated = await getRes.json();
      expect(updated.edges).toHaveLength(0);

      await request.delete(`/api/v1/workspaces/${wid}/subgraph-templates/${sg.id}`);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  // --- Recursion detection ---

  test('adding node referencing self returns 422', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const sgRes = await request.post(`/api/v1/workspaces/${wid}/subgraph-templates`, { data: { name: 'self-ref' } });
      const sg = await sgRes.json();

      const nodeRes = await request.post(`/api/v1/workspaces/${wid}/subgraph-templates/${sg.id}/nodes`, {
        data: { node_type: 'subgraph_template', ref_subgraph_template_id: sg.id },
      });
      expect(nodeRes.status()).toBe(422);

      await request.delete(`/api/v1/workspaces/${wid}/subgraph-templates/${sg.id}`);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('mutual recursion (A→B→A) returns 422', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const sgARes = await request.post(`/api/v1/workspaces/${wid}/subgraph-templates`, { data: { name: 'recur-A' } });
      const sgA = await sgARes.json();
      const sgBRes = await request.post(`/api/v1/workspaces/${wid}/subgraph-templates`, { data: { name: 'recur-B' } });
      const sgB = await sgBRes.json();

      // A contains B
      const n1Res = await request.post(`/api/v1/workspaces/${wid}/subgraph-templates/${sgA.id}/nodes`, {
        data: { node_type: 'subgraph_template', ref_subgraph_template_id: sgB.id },
      });
      expect(n1Res.status()).toBe(201);

      // B contains A → should fail
      const n2Res = await request.post(`/api/v1/workspaces/${wid}/subgraph-templates/${sgB.id}/nodes`, {
        data: { node_type: 'subgraph_template', ref_subgraph_template_id: sgA.id },
      });
      expect(n2Res.status()).toBe(422);

      await request.delete(`/api/v1/workspaces/${wid}/subgraph-templates/${sgA.id}`);
      await request.delete(`/api/v1/workspaces/${wid}/subgraph-templates/${sgB.id}`);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  // --- DAG validation ---

  test('POST /subgraph-templates with cyclic edges returns 422', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const res = await request.post(`/api/v1/workspaces/${wid}/subgraph-templates`, {
        data: {
          name: 'cyclic-sg',
          nodes: [{ node_type: 'task_template' }, { node_type: 'task_template' }, { node_type: 'task_template' }],
          edges: [
            { from_index: 0, to_index: 1 },
            { from_index: 1, to_index: 2 },
            { from_index: 2, to_index: 0 },
          ],
        },
      });
      expect(res.status()).toBe(422);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('POST /subgraph-templates/{id}/edges that creates cycle returns 422', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const sgRes = await request.post(`/api/v1/workspaces/${wid}/subgraph-templates`, {
        data: {
          name: 'cycle-edge-sg',
          nodes: [{ node_type: 'task_template' }, { node_type: 'task_template' }],
          edges: [{ from_index: 0, to_index: 1 }],
        },
      });
      const sg = await sgRes.json();
      const [n0, n1] = sg.nodes;

      // Adding 1→0 would create a cycle
      const res = await request.post(`/api/v1/workspaces/${wid}/subgraph-templates/${sg.id}/edges`, {
        data: { from_node_id: n1.id, to_node_id: n0.id },
      });
      expect(res.status()).toBe(422);

      await request.delete(`/api/v1/workspaces/${wid}/subgraph-templates/${sg.id}`);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('diamond DAG in subgraph template succeeds', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const res = await request.post(`/api/v1/workspaces/${wid}/subgraph-templates`, {
        data: {
          name: 'diamond-sg',
          nodes: [
            { node_type: 'task_template' },
            { node_type: 'task_template' },
            { node_type: 'task_template' },
            { node_type: 'task_template' },
          ],
          edges: [
            { from_index: 0, to_index: 1 },
            { from_index: 0, to_index: 2 },
            { from_index: 1, to_index: 3 },
            { from_index: 2, to_index: 3 },
          ],
        },
      });
      expect(res.status()).toBe(201);
      const body = await res.json();
      expect(body.edges).toHaveLength(4);

      await request.delete(`/api/v1/workspaces/${wid}/subgraph-templates/${body.id}`);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  // --- 404 cases ---

  test('GET /subgraph-templates/{non_existent} returns 404', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const res = await request.get(`/api/v1/workspaces/${wid}/subgraph-templates/00000000-0000-4000-8000-000000000000`);
      expect(res.status()).toBe(404);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('DELETE /subgraph-templates/{non_existent} returns 404', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const res = await request.delete(`/api/v1/workspaces/${wid}/subgraph-templates/00000000-0000-4000-8000-000000000000`);
      expect(res.status()).toBe(404);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('DELETE /nodes/{non_existent} returns 404', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const sgRes = await request.post(`/api/v1/workspaces/${wid}/subgraph-templates`, { data: { name: 'node-404-sg' } });
      const sg = await sgRes.json();

      const res = await request.delete(`/api/v1/workspaces/${wid}/subgraph-templates/${sg.id}/nodes/00000000-0000-4000-8000-000000000000`);
      expect(res.status()).toBe(404);

      await request.delete(`/api/v1/workspaces/${wid}/subgraph-templates/${sg.id}`);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('DELETE /edges/{non_existent} returns 404', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const sgRes = await request.post(`/api/v1/workspaces/${wid}/subgraph-templates`, { data: { name: 'edge-404-sg' } });
      const sg = await sgRes.json();

      const res = await request.delete(`/api/v1/workspaces/${wid}/subgraph-templates/${sg.id}/edges/00000000-0000-4000-8000-000000000000`);
      expect(res.status()).toBe(404);

      await request.delete(`/api/v1/workspaces/${wid}/subgraph-templates/${sg.id}`);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('POST /edges with non-existent node returns 404', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const sgRes = await request.post(`/api/v1/workspaces/${wid}/subgraph-templates`, {
        data: {
          name: 'edge-node-404-sg',
          nodes: [{ node_type: 'task_template' }],
          edges: [],
        },
      });
      const sg = await sgRes.json();
      const realNodeId = sg.nodes[0].id;
      const fakeNodeId = '00000000-0000-4000-8000-000000000000';

      const res = await request.post(`/api/v1/workspaces/${wid}/subgraph-templates/${sg.id}/edges`, {
        data: { from_node_id: realNodeId, to_node_id: fakeNodeId },
      });
      expect(res.status()).toBe(404);

      await request.delete(`/api/v1/workspaces/${wid}/subgraph-templates/${sg.id}`);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

});
