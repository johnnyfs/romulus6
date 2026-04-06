import { test, expect, type APIRequestContext } from '@playwright/test';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN_TIMEOUT_MS = 300_000;
const POLL_INTERVAL_MS = 5_000;

async function createWorkspace(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/workspaces', { data: { name: `Run Execution Test WS ${crypto.randomUUID()}` } });
  expect(res.status()).toBe(201);
  return (await res.json()).id;
}

async function deleteWorkspace(request: APIRequestContext, wid: string) {
  await request.delete(`/api/v1/workspaces/${wid}`);
}

async function createGraph(request: APIRequestContext, wid: string, nodes: any[], edges: any[]): Promise<any> {
  const res = await request.post(`/api/v1/workspaces/${wid}/graphs`, {
    data: { name: 'run-exec-test-graph', nodes, edges },
  });
  expect(res.status()).toBe(201);
  return res.json();
}

async function waitForRunTerminal(
  request: APIRequestContext,
  wid: string,
  gid: string,
  rid: string,
  timeoutMs = RUN_TIMEOUT_MS,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await request.get(
      `/api/v1/workspaces/${wid}/graphs/${gid}/runs/${rid}`,
    );
    expect(res.status()).toBe(200);
    const run = await res.json();
    if (run.state === 'completed' || run.state === 'error') {
      return run;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Run ${rid} did not reach terminal state within ${timeoutMs}ms`);
}

test.describe('Graph Run Execution', () => {
  test.setTimeout(300_000);

  test('command -> agent graph runs to completion', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const graph = await createGraph(
        request, wid,
        [
          { node_type: 'command', name: 'start', command_config: { command: 'echo ok' } },
          {
            node_type: 'agent',
            name: 'worker',
            agent_config: {
              agent_type: 'opencode',
              model: 'anthropic/claude-haiku-4-5',
              prompt: "Say the word 'hello'. That is your only task.",
            },
          },
        ],
        [{ from_index: 0, to_index: 1 }],
      );

      // Create the run
      const createRes = await request.post(`/api/v1/workspaces/${wid}/graphs/${graph.id}/runs`);
      expect(createRes.status()).toBe(201);
      const created = await createRes.json();
      expect(created.id).toMatch(UUID_RE);
      expect(created.run_nodes).toHaveLength(2);
      expect(created.run_edges).toHaveLength(1);

      // Poll until terminal state
      const run = await waitForRunTerminal(request, wid, graph.id, created.id);

      // Overall run completed
      expect(run.state).toBe('completed');
      expect(run.sandbox_id).toMatch(UUID_RE);

      // Command node completed
      const cmdNode = run.run_nodes.find((n: any) => n.name === 'start');
      expect(cmdNode).toBeTruthy();
      expect(cmdNode.state).toBe('completed');

      // Agent node completed with agent metadata
      const agentNode = run.run_nodes.find((n: any) => n.node_type === 'agent');
      expect(agentNode).toBeTruthy();
      expect(agentNode.state).toBe('completed');
      expect(agentNode.agent_id).toMatch(UUID_RE);
      expect(agentNode.session_id).toBeTruthy();
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('command node runs echo to completion', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const graph = await createGraph(
        request, wid,
        [
          { node_type: 'command', name: 'echo-cmd', command_config: { command: 'echo "hello"' } },
        ],
        [],
      );

      const createRes = await request.post(`/api/v1/workspaces/${wid}/graphs/${graph.id}/runs`);
      expect(createRes.status()).toBe(201);
      const created = await createRes.json();

      const run = await waitForRunTerminal(request, wid, graph.id, created.id);

      expect(run.state).toBe('completed');
      expect(run.sandbox_id).toMatch(UUID_RE);

      const cmdNode = run.run_nodes.find((n: any) => n.node_type === 'command');
      expect(cmdNode.state).toBe('completed');
      expect(cmdNode.command_config).toMatchObject({ command: 'echo "hello"' });
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('command node with bad command sets run to error', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const graph = await createGraph(
        request, wid,
        [
          { node_type: 'command', name: 'typo-cmd', command_config: { command: 'eche "Typo!"' } },
        ],
        [],
      );

      const createRes = await request.post(`/api/v1/workspaces/${wid}/graphs/${graph.id}/runs`);
      expect(createRes.status()).toBe(201);
      const created = await createRes.json();

      const run = await waitForRunTerminal(request, wid, graph.id, created.id);

      expect(run.state).toBe('error');

      const cmdNode = run.run_nodes.find((n: any) => n.node_type === 'command');
      expect(cmdNode.state).toBe('error');
    } finally {
      await deleteWorkspace(request, wid);
    }
  });
});
