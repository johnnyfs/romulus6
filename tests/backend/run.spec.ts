import { test, expect } from '@playwright/test';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FAKE_UUID = '00000000-0000-4000-8000-000000000000';

async function createWorkspace(request: any): Promise<string> {
  const res = await request.post('/api/v1/workspaces', { data: { name: `Run Test WS ${crypto.randomUUID()}` } });
  expect(res.status()).toBe(201);
  return (await res.json()).id;
}

async function deleteWorkspace(request: any, wid: string) {
  await request.delete(`/api/v1/workspaces/${wid}`);
}

async function createGraph(request: any, wid: string, nodes: any[], edges: any[], name = 'run-test-graph'): Promise<any> {
  const res = await request.post(`/api/v1/workspaces/${wid}/graphs`, {
    data: { name, nodes, edges },
  });
  expect(res.status()).toBe(201);
  return res.json();
}

test.describe('Graph Runs API', () => {

  test('POST /runs on a graph with no nodes returns 201 with empty run', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const graph = await createGraph(request, wid, [], []);
      const res = await request.post(`/api/v1/workspaces/${wid}/graphs/${graph.id}/runs`);
      expect(res.status()).toBe(201);
      const run = await res.json();
      expect(run.id).toMatch(UUID_RE);
      expect(run.graph_id).toBe(graph.id);
      expect(run.workspace_id).toBe(wid);
      expect(run.run_nodes).toEqual([]);
      expect(run.run_edges).toEqual([]);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('POST /runs copies nodes and edges as a snapshot', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const graph = await createGraph(
        request, wid,
        [{ node_type: 'command', name: 'alpha', command_config: { command: 'echo ok' } }, { node_type: 'command', name: 'beta', command_config: { command: 'echo ok' } }],
        [{ from_index: 0, to_index: 1 }],
      );
      const [origN0, origN1] = graph.nodes;
      const origEdge = graph.edges[0];

      const res = await request.post(`/api/v1/workspaces/${wid}/graphs/${graph.id}/runs`);
      expect(res.status()).toBe(201);
      const run = await res.json();

      expect(run.run_nodes).toHaveLength(2);
      expect(run.run_edges).toHaveLength(1);

      // Run node IDs are new UUIDs, not the original node IDs
      const runNodeIds = run.run_nodes.map((n: any) => n.id);
      expect(runNodeIds).not.toContain(origN0.id);
      expect(runNodeIds).not.toContain(origN1.id);

      // All run nodes have state='pending' and valid shape
      for (const rn of run.run_nodes) {
        expect(rn.state).toBe('pending');
        expect(rn.id).toMatch(UUID_RE);
        expect(rn.run_id).toBe(run.id);
        // command nodes have no agent config
        expect(rn.agent_config).toBeNull();
      }

      // source_node_id links back to the originals
      const sourceIds = run.run_nodes.map((n: any) => n.source_node_id);
      expect(sourceIds).toContain(origN0.id);
      expect(sourceIds).toContain(origN1.id);

      // name and node_type are copied
      const alphaRunNode = run.run_nodes.find((n: any) => n.source_node_id === origN0.id);
      expect(alphaRunNode.name).toBe('alpha');
      expect(alphaRunNode.node_type).toBe('command');

      // Run edge references run-node IDs, NOT original node IDs
      const runEdge = run.run_edges[0];
      expect(runEdge.from_run_node_id).not.toBe(origEdge.from_node_id);
      expect(runEdge.to_run_node_id).not.toBe(origEdge.to_node_id);
      expect(runNodeIds).toContain(runEdge.from_run_node_id);
      expect(runNodeIds).toContain(runEdge.to_run_node_id);

      // Edge direction is preserved
      const fromRunNode = run.run_nodes.find((n: any) => n.id === runEdge.from_run_node_id);
      const toRunNode = run.run_nodes.find((n: any) => n.id === runEdge.to_run_node_id);
      expect(fromRunNode.source_node_id).toBe(origN0.id);
      expect(toRunNode.source_node_id).toBe(origN1.id);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('POST /runs copies agent node config to run node', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const agentConfig = {
        agent_type: 'opencode',
        model: 'anthropic/claude-haiku-4-5',
        prompt: 'do stuff',
      };
      const graph = await createGraph(
        request, wid,
        [{ node_type: 'agent', name: 'my-agent', agent_config: agentConfig }],
        [],
      );

      expect(graph.nodes).toHaveLength(1);
      expect(graph.nodes[0].node_type).toBe('agent');
      expect(graph.nodes[0].agent_config).toMatchObject(agentConfig);

      const res = await request.post(`/api/v1/workspaces/${wid}/graphs/${graph.id}/runs`);
      expect(res.status()).toBe(201);
      const run = await res.json();

      expect(run.run_nodes).toHaveLength(1);
      const rn = run.run_nodes[0];
      expect(rn.node_type).toBe('agent');
      expect(rn.name).toBe('my-agent');
      expect(rn.source_node_id).toBe(graph.nodes[0].id);
      expect(rn.agent_config).toMatchObject(agentConfig);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('POST /runs copies command node config to run node', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const commandConfig = { command: 'echo hello\nls -la' };
      const graph = await createGraph(
        request, wid,
        [{ node_type: 'command', name: 'my-cmd', command_config: commandConfig }],
        [],
      );

      expect(graph.nodes).toHaveLength(1);
      expect(graph.nodes[0].node_type).toBe('command');
      expect(graph.nodes[0].command_config).toMatchObject(commandConfig);

      const res = await request.post(`/api/v1/workspaces/${wid}/graphs/${graph.id}/runs`);
      expect(res.status()).toBe(201);
      const run = await res.json();

      expect(run.run_nodes).toHaveLength(1);
      const rn = run.run_nodes[0];
      expect(rn.node_type).toBe('command');
      expect(rn.name).toBe('my-cmd');
      expect(rn.source_node_id).toBe(graph.nodes[0].id);
      expect(rn.command_config).toMatchObject(commandConfig);
      expect(rn.agent_config).toBeNull();
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('POST /runs on a node with null name preserves null', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const graph = await createGraph(request, wid, [{ node_type: 'command', command_config: { command: 'echo ok' } }], []);
      const res = await request.post(`/api/v1/workspaces/${wid}/graphs/${graph.id}/runs`);
      expect(res.status()).toBe(201);
      const run = await res.json();
      expect(run.run_nodes[0].name).toBeNull();
      expect(run.run_nodes[0].agent_config).toBeNull();
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('POST /runs on non-existent graph returns 404', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const res = await request.post(`/api/v1/workspaces/${wid}/graphs/${FAKE_UUID}/runs`);
      expect(res.status()).toBe(404);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('POST /runs on non-existent workspace returns 404', async ({ request }) => {
    const res = await request.post(`/api/v1/workspaces/${FAKE_UUID}/graphs/${FAKE_UUID}/runs`);
    expect(res.status()).toBe(404);
  });

  test('multiple runs of the same graph are independent snapshots', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const graph = await createGraph(request, wid, [{ node_type: 'command', command_config: { command: 'echo ok' } }], []);

      const r1 = await (await request.post(`/api/v1/workspaces/${wid}/graphs/${graph.id}/runs`)).json();
      const r2 = await (await request.post(`/api/v1/workspaces/${wid}/graphs/${graph.id}/runs`)).json();

      expect(r1.id).not.toBe(r2.id);
      expect(r1.run_nodes[0].id).not.toBe(r2.run_nodes[0].id);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('GET /runs returns empty list for graph with no runs', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const graph = await createGraph(request, wid, [{ node_type: 'command', command_config: { command: 'echo ok' } }], []);
      const res = await request.get(`/api/v1/workspaces/${wid}/graphs/${graph.id}/runs`);
      expect(res.status()).toBe(200);
      expect(await res.json()).toEqual([]);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('GET /runs returns runs ordered by created_at desc', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const graph = await createGraph(request, wid, [{ node_type: 'command', command_config: { command: 'echo ok' } }], []);
      const r1 = await (await request.post(`/api/v1/workspaces/${wid}/graphs/${graph.id}/runs`)).json();
      const r2 = await (await request.post(`/api/v1/workspaces/${wid}/graphs/${graph.id}/runs`)).json();

      const res = await request.get(`/api/v1/workspaces/${wid}/graphs/${graph.id}/runs`);
      expect(res.status()).toBe(200);
      const runs = await res.json();
      expect(runs).toHaveLength(2);
      // Most recent first
      expect(runs[0].id).toBe(r2.id);
      expect(runs[1].id).toBe(r1.id);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('GET /runs scoped to specific graph', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const g1 = await createGraph(request, wid, [{ node_type: 'command', command_config: { command: 'echo ok' } }], [], 'scoped-g1');
      const g2 = await createGraph(request, wid, [{ node_type: 'command', command_config: { command: 'echo ok' } }], [], 'scoped-g2');

      await request.post(`/api/v1/workspaces/${wid}/graphs/${g1.id}/runs`);
      await request.post(`/api/v1/workspaces/${wid}/graphs/${g2.id}/runs`);
      await request.post(`/api/v1/workspaces/${wid}/graphs/${g2.id}/runs`);

      const res1 = await request.get(`/api/v1/workspaces/${wid}/graphs/${g1.id}/runs`);
      expect((await res1.json())).toHaveLength(1);

      const res2 = await request.get(`/api/v1/workspaces/${wid}/graphs/${g2.id}/runs`);
      expect((await res2.json())).toHaveLength(2);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('deleting a graph node does not break existing runs', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const graph = await createGraph(
        request, wid,
        [{ node_type: 'command', name: 'alpha', command_config: { command: 'echo ok' } }, { node_type: 'command', name: 'beta', command_config: { command: 'echo ok' } }],
        [{ from_index: 0, to_index: 1 }],
      );
      const origNodeId = graph.nodes[0].id;

      // Create a run that snapshots the nodes
      const runRes = await request.post(`/api/v1/workspaces/${wid}/graphs/${graph.id}/runs`);
      expect(runRes.status()).toBe(201);
      const run = await runRes.json();
      expect(run.run_nodes).toHaveLength(2);

      // Delete the original node — should succeed despite run reference
      const delRes = await request.delete(
        `/api/v1/workspaces/${wid}/graphs/${graph.id}/nodes/${origNodeId}`,
      );
      expect(delRes.status()).toBe(204);

      // Run still has the snapshot with the original source_node_id
      const runsRes = await request.get(`/api/v1/workspaces/${wid}/graphs/${graph.id}/runs`);
      expect(runsRes.status()).toBe(200);
      const runs = await runsRes.json();
      expect(runs).toHaveLength(1);
      const alphaRunNode = runs[0].run_nodes.find((n: any) => n.source_node_id === origNodeId);
      expect(alphaRunNode).toBeDefined();
      expect(alphaRunNode.name).toBe('alpha');
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('GET /runs on non-existent graph returns 404', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const res = await request.get(`/api/v1/workspaces/${wid}/graphs/${FAKE_UUID}/runs`);
      expect(res.status()).toBe(404);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

});
