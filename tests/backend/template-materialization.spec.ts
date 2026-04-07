import { test, expect } from '@playwright/test';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function createWorkspace(request: any): Promise<string> {
  const res = await request.post('/api/v1/workspaces', {
    data: { name: `Materialization Test WS ${crypto.randomUUID()}` },
  });
  expect(res.status()).toBe(201);
  return (await res.json()).id;
}

async function deleteWorkspace(request: any, wid: string) {
  await request.delete(`/api/v1/workspaces/${wid}`);
}

async function createTaskTemplate(
  request: any,
  wid: string,
  data: Record<string, any>,
): Promise<any> {
  const res = await request.post(`/api/v1/workspaces/${wid}/task-templates`, { data });
  expect(res.status()).toBe(201);
  return res.json();
}

async function createSubgraphTemplate(
  request: any,
  wid: string,
  data: Record<string, any>,
): Promise<any> {
  const res = await request.post(`/api/v1/workspaces/${wid}/subgraph-templates`, { data });
  expect(res.status()).toBe(201);
  return res.json();
}

async function createGraph(
  request: any,
  wid: string,
  data: Record<string, any>,
): Promise<any> {
  const res = await request.post(`/api/v1/workspaces/${wid}/graphs`, { data });
  expect(res.status()).toBe(201);
  return res.json();
}

async function createRun(request: any, wid: string, graphId: string): Promise<any> {
  const res = await request.post(`/api/v1/workspaces/${wid}/graphs/${graphId}/runs`);
  expect(res.status()).toBe(201);
  return res.json();
}

async function getRun(request: any, wid: string, runId: string): Promise<any> {
  const res = await request.get(`/api/v1/workspaces/${wid}/runs/${runId}`);
  expect(res.status()).toBe(200);
  return res.json();
}

async function waitForRunTerminal(
  request: any,
  wid: string,
  runId: string,
  timeoutMs = 120_000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await getRun(request, wid, runId);
    if (run.state === 'completed' || run.state === 'error') {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Run ${runId} did not reach a terminal state within ${timeoutMs}ms`);
}

async function listWorkspaceEvents(request: any, wid: string): Promise<any[]> {
  const res = await request.get(`/api/v1/workspaces/${wid}/events?since=0&limit=200`);
  expect(res.status()).toBe(200);
  return res.json();
}

// =============================================================================
// Graph nodes with template references
// =============================================================================

test.describe('Graph nodes with template references', () => {
  test('POST /graphs with task_template node creates graph with template reference', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const tmpl = await createTaskTemplate(request, wid, {
        name: 'agent-tmpl',
        task_type: 'agent',
        prompt: 'You are {{ role }}',
        arguments: [{ name: 'role', arg_type: 'string' }],
      });

      const graph = await createGraph(request, wid, {
        name: 'tmpl-graph',
        nodes: [
          {
            node_type: 'task_template',
            name: 'my-node',
            task_template_id: tmpl.id,
            argument_bindings: { role: 'tester' },
          },
        ],
        edges: [],
      });

      expect(graph.nodes).toHaveLength(1);
      expect(graph.nodes[0].node_type).toBe('task_template');
      expect(graph.nodes[0].task_template_id).toBe(tmpl.id);
      expect(graph.nodes[0].argument_bindings).toEqual({ role: 'tester' });
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('POST /graphs with subgraph_template node creates graph', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const sg = await createSubgraphTemplate(request, wid, { name: 'sub-tmpl' });

      const graph = await createGraph(request, wid, {
        name: 'sg-graph',
        nodes: [
          {
            node_type: 'subgraph_template',
            name: 'sub-node',
            subgraph_template_id: sg.id,
          },
        ],
        edges: [],
      });

      expect(graph.nodes).toHaveLength(1);
      expect(graph.nodes[0].node_type).toBe('subgraph_template');
      expect(graph.nodes[0].subgraph_template_id).toBe(sg.id);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('POST /nodes adds task_template node to existing graph', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const tmpl = await createTaskTemplate(request, wid, {
        name: 'cmd-tmpl',
        task_type: 'command',
        command: 'echo {{ msg }}',
      });
      const graph = await createGraph(request, wid, { name: 'add-node-graph' });

      const res = await request.post(`/api/v1/workspaces/${wid}/graphs/${graph.id}/nodes`, {
        data: {
          node_type: 'task_template',
          name: 'added',
          task_template_id: tmpl.id,
          argument_bindings: { msg: 'hello' },
        },
      });
      expect(res.status()).toBe(201);
      const node = await res.json();
      expect(node.node_type).toBe('task_template');
      expect(node.task_template_id).toBe(tmpl.id);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('POST /nodes adds subgraph_template node to existing graph', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const sg = await createSubgraphTemplate(request, wid, { name: 'add-sg-tmpl' });
      const graph = await createGraph(request, wid, { name: 'add-sg-graph' });

      const res = await request.post(`/api/v1/workspaces/${wid}/graphs/${graph.id}/nodes`, {
        data: {
          node_type: 'subgraph_template',
          name: 'sub',
          subgraph_template_id: sg.id,
        },
      });
      expect(res.status()).toBe(201);
      expect((await res.json()).subgraph_template_id).toBe(sg.id);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('PATCH /nodes updates argument_bindings on template node', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const tmpl = await createTaskTemplate(request, wid, {
        name: 'patch-tmpl',
        task_type: 'agent',
        prompt: '{{ x }}',
      });
      const graph = await createGraph(request, wid, {
        name: 'patch-graph',
        nodes: [
          {
            node_type: 'task_template',
            task_template_id: tmpl.id,
            argument_bindings: { x: 'old' },
          },
        ],
        edges: [],
      });

      const res = await request.patch(
        `/api/v1/workspaces/${wid}/graphs/${graph.id}/nodes/${graph.nodes[0].id}`,
        { data: { argument_bindings: { x: 'new' } } },
      );
      expect(res.status()).toBe(200);
      expect((await res.json()).argument_bindings).toEqual({ x: 'new' });
    } finally {
      await deleteWorkspace(request, wid);
    }
  });
});

// =============================================================================
// Task template materialization in runs
// =============================================================================

test.describe('Task template materialization in runs', () => {
  test('POST /runs materializes task_template node into concrete agent node', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const tmpl = await createTaskTemplate(request, wid, {
        name: 'agent-run-tmpl',
        task_type: 'agent',
        agent_type: 'opencode',
        model: 'anthropic/claude-haiku-4-5',
        prompt: 'You are {{ role }}',
        arguments: [{ name: 'role', arg_type: 'string' }],
      });

      const graph = await createGraph(request, wid, {
        name: 'mat-agent-graph',
        nodes: [
          {
            node_type: 'task_template',
            name: 'tmpl-node',
            task_template_id: tmpl.id,
            argument_bindings: { role: 'tester' },
          },
        ],
        edges: [],
      });

      const run = await createRun(request, wid, graph.id);
      expect(run.run_nodes).toHaveLength(1);
      const rn = run.run_nodes[0];
      expect(rn.node_type).toBe('agent');
      expect(rn.source_type).toBe('template_node');
      expect(rn.agent_config).toBeDefined();
      expect(rn.agent_config.prompt).toBe('You are tester');
      expect(rn.agent_config.agent_type).toBe('opencode');
      expect(rn.state).toBe('pending');
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('POST /runs materializes task_template with default argument values', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const tmpl = await createTaskTemplate(request, wid, {
        name: 'default-arg-tmpl',
        task_type: 'agent',
        agent_type: 'opencode',
        model: 'anthropic/claude-haiku-4-5',
        prompt: 'Hello {{ name }}',
        arguments: [{ name: 'name', arg_type: 'string', default_value: 'world' }],
      });

      const graph = await createGraph(request, wid, {
        name: 'default-arg-graph',
        nodes: [
          {
            node_type: 'task_template',
            task_template_id: tmpl.id,
            // No argument_bindings — should use default
          },
        ],
        edges: [],
      });

      const run = await createRun(request, wid, graph.id);
      const rn = run.run_nodes[0];
      expect(rn.node_type).toBe('agent');
      expect(rn.agent_config).toBeDefined();
      expect(rn.agent_config.prompt).toBe('Hello world');
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('POST /runs materializes command task_template with argument substitution', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const tmpl = await createTaskTemplate(request, wid, {
        name: 'cmd-run-tmpl',
        task_type: 'command',
        command: 'echo {{ msg }}',
        arguments: [{ name: 'msg', arg_type: 'string' }],
      });

      const graph = await createGraph(request, wid, {
        name: 'mat-cmd-graph',
        nodes: [
          {
            node_type: 'task_template',
            task_template_id: tmpl.id,
            argument_bindings: { msg: 'hello' },
          },
        ],
        edges: [],
      });

      const run = await createRun(request, wid, graph.id);
      const rn = run.run_nodes[0];
      expect(rn.node_type).toBe('command');
      expect(rn.command_config.command).toBe('echo hello');
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('POST /runs materializes mix of regular and template nodes', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const tmpl = await createTaskTemplate(request, wid, {
        name: 'mix-tmpl',
        task_type: 'command',
        command: 'echo mixed',
      });

      const graph = await createGraph(request, wid, {
        name: 'mixed-graph',
        nodes: [
          { node_type: 'command', name: 'cmd1', command_config: { command: 'echo regular' } },
          { node_type: 'task_template', name: 'tmpl1', task_template_id: tmpl.id },
          { node_type: 'agent', name: 'agent1', agent_config: { agent_type: 'opencode', model: 'anthropic/claude-haiku-4-5', prompt: 'do stuff' } },
        ],
        edges: [{ from_index: 0, to_index: 1 }, { from_index: 1, to_index: 2 }],
      });

      const run = await createRun(request, wid, graph.id);
      expect(run.run_nodes).toHaveLength(3);
      expect(run.run_edges).toHaveLength(2);
      // All nodes should be pending
      for (const rn of run.run_nodes) {
        expect(rn.state).toBe('pending');
      }
    } finally {
      await deleteWorkspace(request, wid);
    }
  });
});

// =============================================================================
// Subgraph template materialization in runs
// =============================================================================

test.describe('Subgraph template materialization in runs', () => {
  test('POST /runs materializes subgraph_template node into subgraph run node with child_run_id', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const taskTmpl = await createTaskTemplate(request, wid, {
        name: 'sg-task-tmpl',
        task_type: 'command',
        command: 'echo sg-node',
      });

      const sg = await createSubgraphTemplate(request, wid, {
        name: 'sg-mat-tmpl',
        nodes: [
          { node_type: 'task_template', name: 'n1', task_template_id: taskTmpl.id },
          { node_type: 'task_template', name: 'n2', task_template_id: taskTmpl.id },
        ],
        edges: [{ from_index: 0, to_index: 1 }],
      });

      const graph = await createGraph(request, wid, {
        name: 'sg-mat-graph',
        nodes: [
          {
            node_type: 'subgraph_template',
            name: 'sub-run',
            subgraph_template_id: sg.id,
          },
        ],
        edges: [],
      });

      const run = await createRun(request, wid, graph.id);
      expect(run.run_nodes).toHaveLength(1);
      const sgNode = run.run_nodes[0];
      expect(sgNode.node_type).toBe('subgraph');
      expect(sgNode.child_run_id).toMatch(UUID_RE);
      expect(sgNode.state).toBe('pending');
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('POST /runs child run has correct structure', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const taskTmpl = await createTaskTemplate(request, wid, {
        name: 'child-struct-tmpl',
        task_type: 'command',
        command: 'echo child',
      });

      const sg = await createSubgraphTemplate(request, wid, {
        name: 'child-struct-sg',
        nodes: [
          { node_type: 'task_template', name: 'c1', task_template_id: taskTmpl.id },
          { node_type: 'task_template', name: 'c2', task_template_id: taskTmpl.id },
        ],
        edges: [{ from_index: 0, to_index: 1 }],
      });

      const graph = await createGraph(request, wid, {
        name: 'child-struct-graph',
        nodes: [
          { node_type: 'subgraph_template', subgraph_template_id: sg.id },
        ],
        edges: [],
      });

      const run = await createRun(request, wid, graph.id);
      const childRunId = run.run_nodes[0].child_run_id;

      // Fetch child run via workspace-scoped endpoint
      const childRun = await getRun(request, wid, childRunId);
      expect(childRun.graph_id).toBeNull();
      expect(childRun.parent_run_node_id).toBe(run.run_nodes[0].id);
      expect(childRun.run_nodes).toHaveLength(2);
      expect(childRun.run_edges).toHaveLength(1);
      // Child nodes should be concrete command nodes
      for (const rn of childRun.run_nodes) {
        expect(rn.node_type).toBe('command');
        expect(rn.source_type).toBe('template_node');
      }
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('POST /runs nested subgraph template materializes recursively', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const taskTmpl = await createTaskTemplate(request, wid, {
        name: 'nested-task-tmpl',
        task_type: 'command',
        command: 'echo nested',
      });

      // Inner subgraph template
      const innerSg = await createSubgraphTemplate(request, wid, {
        name: 'inner-sg',
        nodes: [
          { node_type: 'task_template', name: 'inner-n', task_template_id: taskTmpl.id },
        ],
        edges: [],
      });

      // Outer subgraph template references inner
      const outerSg = await createSubgraphTemplate(request, wid, {
        name: 'outer-sg',
        nodes: [
          { node_type: 'task_template', name: 'outer-task', task_template_id: taskTmpl.id },
          { node_type: 'subgraph_template', name: 'outer-sub', ref_subgraph_template_id: innerSg.id },
        ],
        edges: [{ from_index: 0, to_index: 1 }],
      });

      const graph = await createGraph(request, wid, {
        name: 'nested-sg-graph',
        nodes: [
          { node_type: 'subgraph_template', subgraph_template_id: outerSg.id },
        ],
        edges: [],
      });

      const run = await createRun(request, wid, graph.id);
      // Parent run has one subgraph node
      expect(run.run_nodes).toHaveLength(1);
      expect(run.run_nodes[0].node_type).toBe('subgraph');

      // First child run (outer subgraph)
      const outerChildRun = await getRun(request, wid, run.run_nodes[0].child_run_id);
      expect(outerChildRun.run_nodes).toHaveLength(2);
      const nestedSubNode = outerChildRun.run_nodes.find((n: any) => n.node_type === 'subgraph');
      expect(nestedSubNode).toBeDefined();
      expect(nestedSubNode.child_run_id).toMatch(UUID_RE);

      // Second child run (inner subgraph)
      const innerChildRun = await getRun(request, wid, nestedSubNode.child_run_id);
      expect(innerChildRun.run_nodes).toHaveLength(1);
      expect(innerChildRun.run_nodes[0].node_type).toBe('command');
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('POST /runs with argument binding cascading through subgraph', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const taskTmpl = await createTaskTemplate(request, wid, {
        name: 'cascade-tmpl',
        task_type: 'command',
        command: 'echo {{ message }}',
        arguments: [{ name: 'message', arg_type: 'string' }],
      });

      const sg = await createSubgraphTemplate(request, wid, {
        name: 'cascade-sg',
        nodes: [
          {
            node_type: 'task_template',
            name: 'cascaded',
            task_template_id: taskTmpl.id,
            argument_bindings: { message: '{{ outer_msg }}' },
          },
        ],
        edges: [],
        arguments: [{ name: 'outer_msg', arg_type: 'string' }],
      });

      const graph = await createGraph(request, wid, {
        name: 'cascade-graph',
        nodes: [
          {
            node_type: 'subgraph_template',
            subgraph_template_id: sg.id,
            argument_bindings: { outer_msg: 'cascaded_value' },
          },
        ],
        edges: [],
      });

      const run = await createRun(request, wid, graph.id);
      const childRunId = run.run_nodes[0].child_run_id;
      const childRun = await getRun(request, wid, childRunId);

      expect(childRun.run_nodes).toHaveLength(1);
      expect(childRun.run_nodes[0].command_config.command).toBe('echo cascaded_value');
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('nested subgraph execution completes in one shared sandbox and emits child-run events', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const taskTmpl = await createTaskTemplate(request, wid, {
        name: 'say',
        task_type: 'command',
        command: 'echo {{ message }}',
        arguments: [{ name: 'message', arg_type: 'string' }],
      });

      const subgraph = await createSubgraphTemplate(request, wid, {
        name: 'say twice',
        arguments: [
          { name: 'first', arg_type: 'string' },
          { name: 'second', arg_type: 'string' },
        ],
        nodes: [
          {
            node_type: 'task_template',
            name: 'say first',
            task_template_id: taskTmpl.id,
            argument_bindings: { message: '{{ first }}' },
          },
          {
            node_type: 'task_template',
            name: 'say second',
            task_template_id: taskTmpl.id,
            argument_bindings: { message: '{{ second }}' },
          },
        ],
        edges: [{ from_index: 0, to_index: 1 }],
      });

      const graph = await createGraph(request, wid, {
        name: 'top-level nested graph',
        nodes: [
          {
            node_type: 'subgraph_template',
            name: 'subgraph node',
            subgraph_template_id: subgraph.id,
            argument_bindings: { first: 'hello', second: 'there' },
          },
          {
            node_type: 'task_template',
            name: 'goodbye node',
            task_template_id: taskTmpl.id,
            argument_bindings: { message: 'goodbye' },
          },
        ],
        edges: [{ from_index: 0, to_index: 1 }],
      });

      const created = await createRun(request, wid, graph.id);
      const childRunId = created.run_nodes[0].child_run_id;
      expect(childRunId).toMatch(UUID_RE);

      const rootRun = await waitForRunTerminal(request, wid, created.id);
      const childRun = await waitForRunTerminal(request, wid, childRunId);

      expect(rootRun.state).toBe('completed');
      expect(childRun.state).toBe('completed');
      expect(rootRun.sandbox_id).toMatch(UUID_RE);
      expect(childRun.sandbox_id).toBe(rootRun.sandbox_id);

      const rootSubgraphNode = rootRun.run_nodes.find((n: any) => n.name === 'subgraph node');
      const rootGoodbyeNode = rootRun.run_nodes.find((n: any) => n.name === 'goodbye node');
      expect(rootSubgraphNode?.state).toBe('completed');
      expect(rootGoodbyeNode?.state).toBe('completed');
      expect(rootSubgraphNode?.child_run_id).toBe(childRun.id);

      const childNodeStates = Object.fromEntries(
        childRun.run_nodes.map((node: any) => [node.name, node.state]),
      );
      expect(childNodeStates).toEqual({
        'say first': 'completed',
        'say second': 'completed',
      });

      const events = await listWorkspaceEvents(request, wid);
      const relevant = events.filter((event) => event.run_id === rootRun.id || event.run_id === childRun.id);
      const outputs = relevant
        .filter((event) => event.type === 'command.output')
        .map((event) => ({
          runId: event.run_id,
          stdout: String(event.data?.stdout ?? '').trim(),
          sandboxId: event.sandbox_id,
        }));

      expect(outputs).toEqual([
        { runId: childRun.id, stdout: 'hello', sandboxId: rootRun.sandbox_id },
        { runId: childRun.id, stdout: 'there', sandboxId: rootRun.sandbox_id },
        { runId: rootRun.id, stdout: 'goodbye', sandboxId: rootRun.sandbox_id },
      ]);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('workspace delete succeeds after nested subgraph execution', async ({ request }) => {
    const wid = await createWorkspace(request);
    const graphName = `delete-nested-${crypto.randomUUID()}`;
    try {
      const taskTmpl = await createTaskTemplate(request, wid, {
        name: 'cleanup-say',
        task_type: 'command',
        command: 'echo {{ message }}',
        arguments: [{ name: 'message', arg_type: 'string' }],
      });

      const subgraph = await createSubgraphTemplate(request, wid, {
        name: 'cleanup-subgraph',
        arguments: [{ name: 'message', arg_type: 'string' }],
        nodes: [
          {
            node_type: 'task_template',
            name: 'say message',
            task_template_id: taskTmpl.id,
            argument_bindings: { message: '{{ message }}' },
          },
        ],
        edges: [],
      });

      const graph = await createGraph(request, wid, {
        name: graphName,
        nodes: [
          {
            node_type: 'subgraph_template',
            name: 'cleanup root',
            subgraph_template_id: subgraph.id,
            argument_bindings: { message: 'bye' },
          },
        ],
        edges: [],
      });

      const run = await createRun(request, wid, graph.id);
      await waitForRunTerminal(request, wid, run.id);
    } finally {
      const delRes = await request.delete(`/api/v1/workspaces/${wid}`);
      expect(delRes.status()).toBe(204);
    }
  });
});

// =============================================================================
// Subgraph templates with inline agent/command nodes
// =============================================================================

test.describe('Subgraph templates with inline agent/command nodes', () => {
  test('POST /subgraph-templates creates with inline command nodes', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const sg = await createSubgraphTemplate(request, wid, {
        name: 'inline-cmd-sg',
        nodes: [
          { node_type: 'command', name: 'step1', command_config: { command: 'echo step1' } },
          { node_type: 'command', name: 'step2', command_config: { command: 'echo step2' } },
        ],
        edges: [{ from_index: 0, to_index: 1 }],
      });

      expect(sg.nodes).toHaveLength(2);
      expect(sg.nodes[0].node_type).toBe('command');
      expect(sg.nodes[0].command_config).toMatchObject({ command: 'echo step1' });
      expect(sg.edges).toHaveLength(1);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('POST /subgraph-templates creates with inline agent node', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const sg = await createSubgraphTemplate(request, wid, {
        name: 'inline-agent-sg',
        nodes: [
          {
            node_type: 'agent',
            name: 'agent-step',
            agent_config: { agent_type: 'opencode', model: 'anthropic/claude-haiku-4-5', prompt: 'do work' },
          },
        ],
        edges: [],
      });

      expect(sg.nodes).toHaveLength(1);
      expect(sg.nodes[0].node_type).toBe('agent');
      expect(sg.nodes[0].agent_config).toMatchObject({
        agent_type: 'opencode',
        prompt: 'do work',
      });
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('POST /subgraph-templates creates with mixed node types', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const taskTmpl = await createTaskTemplate(request, wid, {
        name: 'mixed-task-tmpl',
        task_type: 'command',
        command: 'echo template',
      });

      const sg = await createSubgraphTemplate(request, wid, {
        name: 'mixed-sg',
        nodes: [
          { node_type: 'command', name: 'inline-cmd', command_config: { command: 'echo inline' } },
          { node_type: 'task_template', name: 'ref-task', task_template_id: taskTmpl.id },
          {
            node_type: 'agent',
            name: 'inline-agent',
            agent_config: {
              agent_type: 'opencode',
              model: 'anthropic/claude-haiku-4-5',
              prompt: 'x',
            },
          },
        ],
        edges: [{ from_index: 0, to_index: 1 }, { from_index: 1, to_index: 2 }],
      });

      expect(sg.nodes).toHaveLength(3);
      const types = sg.nodes.map((n: any) => n.node_type).sort();
      expect(types).toEqual(['agent', 'command', 'task_template']);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('POST /runs materializes subgraph with inline command nodes', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const sg = await createSubgraphTemplate(request, wid, {
        name: 'run-inline-cmd-sg',
        nodes: [
          { node_type: 'command', name: 'c1', command_config: { command: 'echo first' } },
          { node_type: 'command', name: 'c2', command_config: { command: 'echo second' } },
        ],
        edges: [{ from_index: 0, to_index: 1 }],
      });

      const graph = await createGraph(request, wid, {
        name: 'run-inline-cmd-graph',
        nodes: [{ node_type: 'subgraph_template', subgraph_template_id: sg.id }],
        edges: [],
      });

      const run = await createRun(request, wid, graph.id);
      const childRun = await getRun(request, wid, run.run_nodes[0].child_run_id);

      expect(childRun.run_nodes).toHaveLength(2);
      for (const rn of childRun.run_nodes) {
        expect(rn.node_type).toBe('command');
        expect(rn.source_type).toBe('template_node');
      }
      expect(childRun.run_edges).toHaveLength(1);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('POST /runs materializes subgraph with inline agent node', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const sg = await createSubgraphTemplate(request, wid, {
        name: 'run-inline-agent-sg',
        nodes: [
          {
            node_type: 'agent',
            name: 'a1',
            agent_config: { agent_type: 'opencode', model: 'anthropic/claude-haiku-4-5', prompt: 'do {{ task }}' },
          },
        ],
        edges: [],
        arguments: [{ name: 'task', arg_type: 'string' }],
      });

      const graph = await createGraph(request, wid, {
        name: 'run-inline-agent-graph',
        nodes: [{
          node_type: 'subgraph_template',
          subgraph_template_id: sg.id,
          argument_bindings: { task: 'testing' },
        }],
        edges: [],
      });

      const run = await createRun(request, wid, graph.id);
      const childRun = await getRun(request, wid, run.run_nodes[0].child_run_id);

      expect(childRun.run_nodes).toHaveLength(1);
      expect(childRun.run_nodes[0].node_type).toBe('agent');
      expect(childRun.run_nodes[0].agent_config.prompt).toBe('do testing');
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('POST /runs materializes subgraph with mixed inline and template nodes', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const taskTmpl = await createTaskTemplate(request, wid, {
        name: 'mixed-run-tmpl',
        task_type: 'command',
        command: 'echo from-template',
      });

      const sg = await createSubgraphTemplate(request, wid, {
        name: 'mixed-run-sg',
        nodes: [
          { node_type: 'command', name: 'inline', command_config: { command: 'echo inline' } },
          { node_type: 'task_template', name: 'ref', task_template_id: taskTmpl.id },
        ],
        edges: [{ from_index: 0, to_index: 1 }],
      });

      const graph = await createGraph(request, wid, {
        name: 'mixed-run-graph',
        nodes: [{ node_type: 'subgraph_template', subgraph_template_id: sg.id }],
        edges: [],
      });

      const run = await createRun(request, wid, graph.id);
      const childRun = await getRun(request, wid, run.run_nodes[0].child_run_id);

      expect(childRun.run_nodes).toHaveLength(2);
      // Both should be concrete command nodes
      for (const rn of childRun.run_nodes) {
        expect(rn.node_type).toBe('command');
      }
      expect(childRun.run_edges).toHaveLength(1);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });
});

// =============================================================================
// Cycle detection
// =============================================================================

test.describe('Cycle detection', () => {
  test('POST /graphs with subgraph_template referencing self returns 422', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      // Create a subgraph template, then add a node referencing itself
      const sg = await createSubgraphTemplate(request, wid, { name: 'self-ref-sg' });

      // Adding self-referencing node to the template should fail
      const nodeRes = await request.post(`/api/v1/workspaces/${wid}/subgraph-templates/${sg.id}/nodes`, {
        data: { node_type: 'subgraph_template', ref_subgraph_template_id: sg.id },
      });
      expect(nodeRes.status()).toBe(422);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('PUT /subgraph-templates blocks introducing a recursive cycle after graph creation', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const taskTmpl = await createTaskTemplate(request, wid, {
        name: 'mut-task',
        task_type: 'command',
        command: 'echo ok',
      });

      // Create two subgraph templates: A and B
      const sgA = await createSubgraphTemplate(request, wid, {
        name: 'mut-sg-A',
        nodes: [{ node_type: 'task_template', task_template_id: taskTmpl.id }],
        edges: [],
      });
      const sgB = await createSubgraphTemplate(request, wid, {
        name: 'mut-sg-B',
        nodes: [{ node_type: 'task_template', task_template_id: taskTmpl.id }],
        edges: [],
      });

      // Create graph referencing A
      const graph = await createGraph(request, wid, {
        name: 'mut-graph',
        nodes: [{ node_type: 'subgraph_template', subgraph_template_id: sgA.id }],
        edges: [],
      });

      // Now mutate A to reference B, and B to reference A (create cycle)
      // First: A references B
      const updateARes = await request.put(`/api/v1/workspaces/${wid}/subgraph-templates/${sgA.id}`, {
        data: {
          name: 'mut-sg-A',
          nodes: [{ node_type: 'subgraph_template', ref_subgraph_template_id: sgB.id }],
          edges: [],
        },
      });
      expect(updateARes.status()).toBe(200);

      // Then: B references A — this should be rejected immediately because it would
      // introduce a recursive containment cycle.
      const updateBRes = await request.put(`/api/v1/workspaces/${wid}/subgraph-templates/${sgB.id}`, {
        data: {
          name: 'mut-sg-B',
          nodes: [{ node_type: 'subgraph_template', ref_subgraph_template_id: sgA.id }],
          edges: [],
        },
      });
      expect(updateBRes.status()).toBe(422);
      const body = await updateBRes.json();
      expect(body.detail).toContain('recursive');

      const runRes = await request.post(`/api/v1/workspaces/${wid}/graphs/${graph.id}/runs`);
      expect(runRes.status()).toBe(201);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });
});

// =============================================================================
// Run listing
// =============================================================================

test.describe('Run listing', () => {
  test('GET /runs excludes child runs from top-level list', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const taskTmpl = await createTaskTemplate(request, wid, {
        name: 'list-task-tmpl',
        task_type: 'command',
        command: 'echo list',
      });
      const sg = await createSubgraphTemplate(request, wid, {
        name: 'list-sg',
        nodes: [{ node_type: 'task_template', task_template_id: taskTmpl.id }],
        edges: [],
      });
      const graph = await createGraph(request, wid, {
        name: 'list-graph',
        nodes: [{ node_type: 'subgraph_template', subgraph_template_id: sg.id }],
        edges: [],
      });

      await createRun(request, wid, graph.id);

      const listRes = await request.get(`/api/v1/workspaces/${wid}/graphs/${graph.id}/runs`);
      expect(listRes.status()).toBe(200);
      const runs = await listRes.json();
      // Only the parent run should appear, not the child run
      expect(runs).toHaveLength(1);
      expect(runs[0].parent_run_node_id).toBeNull();
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('GET /runs/{run_id} returns child run detail via workspace endpoint', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const taskTmpl = await createTaskTemplate(request, wid, {
        name: 'detail-task-tmpl',
        task_type: 'command',
        command: 'echo detail',
      });
      const sg = await createSubgraphTemplate(request, wid, {
        name: 'detail-sg',
        nodes: [{ node_type: 'task_template', task_template_id: taskTmpl.id }],
        edges: [],
      });
      const graph = await createGraph(request, wid, {
        name: 'detail-graph',
        nodes: [{ node_type: 'subgraph_template', subgraph_template_id: sg.id }],
        edges: [],
      });

      const run = await createRun(request, wid, graph.id);
      const childRunId = run.run_nodes[0].child_run_id;

      const childRun = await getRun(request, wid, childRunId);
      expect(childRun.id).toBe(childRunId);
      expect(childRun.parent_run_node_id).toBe(run.run_nodes[0].id);
      expect(childRun.graph_id).toBeNull();
    } finally {
      await deleteWorkspace(request, wid);
    }
  });
});

// =============================================================================
// Edge cases
// =============================================================================

test.describe('Edge cases', () => {
  test('POST /runs with deleted task template returns 422', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const tmpl = await createTaskTemplate(request, wid, {
        name: 'deleted-tmpl',
        task_type: 'command',
        command: 'echo ok',
      });

      const graph = await createGraph(request, wid, {
        name: 'deleted-tmpl-graph',
        nodes: [
          { node_type: 'task_template', task_template_id: tmpl.id },
        ],
        edges: [],
      });

      // Delete the template
      const delRes = await request.delete(`/api/v1/workspaces/${wid}/task-templates/${tmpl.id}`);
      expect(delRes.status()).toBe(204);

      // Creating a run should fail
      const runRes = await request.post(`/api/v1/workspaces/${wid}/graphs/${graph.id}/runs`);
      expect(runRes.status()).toBe(422);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('POST /runs on graph with empty subgraph template creates child run with no nodes', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const sg = await createSubgraphTemplate(request, wid, { name: 'empty-sg' });

      const graph = await createGraph(request, wid, {
        name: 'empty-sg-graph',
        nodes: [
          { node_type: 'subgraph_template', subgraph_template_id: sg.id },
        ],
        edges: [],
      });

      const run = await createRun(request, wid, graph.id);
      expect(run.run_nodes).toHaveLength(1);
      expect(run.run_nodes[0].node_type).toBe('subgraph');

      const childRun = await getRun(request, wid, run.run_nodes[0].child_run_id);
      expect(childRun.run_nodes).toHaveLength(0);
      expect(childRun.run_edges).toHaveLength(0);
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('POST /runs uses task template label for run node name when set', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const tmpl = await createTaskTemplate(request, wid, {
        name: 'say_something',
        task_type: 'command',
        command: 'echo {{ message }}',
        label: 'Say {{ message }}',
        arguments: [{ name: 'message', arg_type: 'string' }],
      });

      const graph = await createGraph(request, wid, {
        name: 'label-graph',
        nodes: [
          {
            node_type: 'task_template',
            task_template_id: tmpl.id,
            argument_bindings: { message: 'Hello' },
          },
        ],
        edges: [],
      });

      const run = await createRun(request, wid, graph.id);
      expect(run.run_nodes).toHaveLength(1);
      expect(run.run_nodes[0].name).toBe('Say Hello');
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('POST /runs falls back to template name when label is not set', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const tmpl = await createTaskTemplate(request, wid, {
        name: 'no-label-tmpl',
        task_type: 'command',
        command: 'echo ok',
      });

      const graph = await createGraph(request, wid, {
        name: 'no-label-graph',
        nodes: [
          { node_type: 'task_template', task_template_id: tmpl.id },
        ],
        edges: [],
      });

      const run = await createRun(request, wid, graph.id);
      expect(run.run_nodes[0].name).toBe('no-label-tmpl');
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('POST /runs uses subgraph template label for run node name when set', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const taskTmpl = await createTaskTemplate(request, wid, {
        name: 'sg-label-task',
        task_type: 'command',
        command: 'echo {{ item }}',
        arguments: [{ name: 'item', arg_type: 'string' }],
      });

      const sg = await createSubgraphTemplate(request, wid, {
        name: 'process_sg',
        label: 'Process {{ item }}',
        arguments: [{ name: 'item', arg_type: 'string' }],
        nodes: [
          {
            node_type: 'task_template',
            task_template_id: taskTmpl.id,
            argument_bindings: { item: '{{ item }}' },
          },
        ],
        edges: [],
      });

      const graph = await createGraph(request, wid, {
        name: 'sg-label-graph',
        nodes: [
          {
            node_type: 'subgraph_template',
            subgraph_template_id: sg.id,
            argument_bindings: { item: 'Widget' },
          },
        ],
        edges: [],
      });

      const run = await createRun(request, wid, graph.id);
      expect(run.run_nodes).toHaveLength(1);
      expect(run.run_nodes[0].name).toBe('Process Widget');
    } finally {
      await deleteWorkspace(request, wid);
    }
  });

  test('POST /runs preserves edges between mixed node types', async ({ request }) => {
    const wid = await createWorkspace(request);
    try {
      const tmpl = await createTaskTemplate(request, wid, {
        name: 'edge-mix-tmpl',
        task_type: 'command',
        command: 'echo template',
      });

      const graph = await createGraph(request, wid, {
        name: 'edge-mix-graph',
        nodes: [
          { node_type: 'command', name: 'start', command_config: { command: 'echo start' } },
          { node_type: 'task_template', name: 'middle', task_template_id: tmpl.id },
          { node_type: 'command', name: 'end', command_config: { command: 'echo end' } },
        ],
        edges: [
          { from_index: 0, to_index: 1 },
          { from_index: 1, to_index: 2 },
        ],
      });

      const run = await createRun(request, wid, graph.id);
      expect(run.run_nodes).toHaveLength(3);
      expect(run.run_edges).toHaveLength(2);

      // Verify edge connectivity is preserved
      const nodeIds = run.run_nodes.map((n: any) => n.id);
      for (const edge of run.run_edges) {
        expect(nodeIds).toContain(edge.from_run_node_id);
        expect(nodeIds).toContain(edge.to_run_node_id);
      }
    } finally {
      await deleteWorkspace(request, wid);
    }
  });
});
