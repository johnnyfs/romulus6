import { execFileSync } from 'node:child_process';

import { test, expect } from '@playwright/test';

import {
  UUID_RE,
  createGraph,
  createWorkspace,
  deleteWorkspaceWithChildren,
  getBackendDeployMode,
  getRun,
  listWorkspaceEvents,
  sleep,
  waitForRun,
  waitForRunTerminal,
} from './helpers';

const KUBE_NAMESPACE = process.env.ROMULUS_K8S_NAMESPACE ?? 'romulus';
const GRAPH_AGENT_CASES = [
  {
    agentType: 'opencode',
    model: 'anthropic/claude-haiku-4-5',
  },
  {
    agentType: 'codex',
    model: 'openai/gpt-5.3-codex',
  },
  {
    agentType: 'claude_code',
    model: 'anthropic/claude-haiku-4-5',
  },
] as const;

function deleteWorkerPod(podName: string): void {
  execFileSync('kubectl', ['delete', 'pod', podName, '-n', KUBE_NAMESPACE, '--wait=true'], {
    encoding: 'utf8',
  });
}

function waitForWorkerRollout(): void {
  execFileSync('kubectl', ['rollout', 'status', 'deployment/worker', '-n', KUBE_NAMESPACE, '--timeout=180s'], {
    encoding: 'utf8',
  });
}

test.describe('Graph Run Execution', () => {
  test.setTimeout(300_000);

  test('controller dispatches dependent command nodes and the workspace event stream captures run execution', async ({ request }) => {
    const wid = await createWorkspace(request, 'Run Execution Test WS');
    try {
      const graph = await createGraph(
        request, wid,
        [
          { node_type: 'command', name: 'start', command_config: { command: 'sleep 2; echo ok' } },
          { node_type: 'command', name: 'finish', command_config: { command: 'printf hello' } },
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
      expect(created.run_nodes.every((node: any) => node.state === 'pending')).toBe(true);

      // Poll until terminal state
      const run = await waitForRunTerminal(request, wid, graph.id, created.id);

      // Overall run completed
      expect(run.state).toBe('completed');
      expect(run.sandbox_id).toMatch(UUID_RE);

      // Command node completed
      const cmdNode = run.run_nodes.find((n: any) => n.name === 'start');
      expect(cmdNode).toBeTruthy();
      expect(cmdNode.state).toBe('completed');
      expect(cmdNode.output).toMatchObject({ stdout: 'ok\n' });

      const finishNode = run.run_nodes.find((n: any) => n.name === 'finish');
      expect(finishNode).toBeTruthy();
      expect(finishNode.state).toBe('completed');
      expect(finishNode.output).toMatchObject({ stdout: 'hello' });

      const workspaceEvents = await listWorkspaceEvents(request, wid, 0, 200);
      const runEvents = workspaceEvents.filter((event) => event.run_id === created.id);
      expect(runEvents.length).toBeGreaterThan(0);
      expect(runEvents.some((event) => event.node_id === cmdNode.id && event.type === 'command.output')).toBe(true);
      expect(runEvents.some((event) => event.node_id === finishNode.id && event.type === 'command.output')).toBe(true);
      expect(runEvents.some((event) => event.node_id === cmdNode.id && event.type === 'run.node.running')).toBe(true);
      expect(runEvents.some((event) => event.node_id === finishNode.id && event.type === 'run.node.running')).toBe(true);
      expect(runEvents.every((event) => event.sandbox_id === run.sandbox_id)).toBe(true);
      expect(runEvents.some((event) => Boolean(event.worker_id))).toBe(true);
    } finally {
      await deleteWorkspaceWithChildren(request, wid);
    }
  });

  test('command node runs echo to completion', async ({ request }) => {
    const wid = await createWorkspace(request, 'Run Execution Test WS');
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
      await deleteWorkspaceWithChildren(request, wid);
    }
  });

  test('command node with bad command sets run to error', async ({ request }) => {
    const wid = await createWorkspace(request, 'Run Execution Test WS');
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
      const cmdNodes = run.run_nodes
        .filter((n: any) => n.node_type === 'command')
        .sort((a: any, b: any) => a.attempt - b.attempt);
      expect(cmdNodes).toHaveLength(3);
      expect(cmdNodes.map((n: any) => n.attempt)).toEqual([1, 2, 3]);
      expect(cmdNodes.every((n: any) => n.state === 'error')).toBe(true);
      expect(cmdNodes[0].next_attempt_run_node_id).toBe(cmdNodes[1].id);
      expect(cmdNodes[1].retry_of_run_node_id).toBe(cmdNodes[0].id);
      expect(cmdNodes[1].next_attempt_run_node_id).toBe(cmdNodes[2].id);
      expect(cmdNodes[2].retry_of_run_node_id).toBe(cmdNodes[1].id);
      expect(cmdNodes[2].next_attempt_run_node_id).toBe(null);
    } finally {
      await deleteWorkspaceWithChildren(request, wid);
    }
  });

  test('failed command node retries in a new run node and downstream nodes wait for the successful attempt', async ({ request }) => {
    const wid = await createWorkspace(request, 'Run Execution Retry WS');
    try {
      const graph = await createGraph(
        request,
        wid,
        [
          {
            node_type: 'command',
            name: 'flaky',
            command_config: {
              command: [
                'count_file=.retry-count',
                'count=$(cat "$count_file" 2>/dev/null || echo 0)',
                'count=$((count + 1))',
                'echo "$count" > "$count_file"',
                'if [ "$count" -lt 2 ]; then exit 1; fi',
                'printf ok',
              ].join('; '),
            },
          },
          {
            node_type: 'command',
            name: 'after-flaky',
            command_config: { command: 'test "{{ flaky.stdout }}" = "ok"' },
          },
        ],
        [{ from_index: 0, to_index: 1 }],
      );

      const createRes = await request.post(`/api/v1/workspaces/${wid}/graphs/${graph.id}/runs`);
      expect(createRes.status()).toBe(201);
      const created = await createRes.json();

      const run = await waitForRunTerminal(request, wid, graph.id, created.id);
      expect(run.state).toBe('completed');

      const flakyAttempts = run.run_nodes
        .filter((n: any) => n.name === 'flaky')
        .sort((a: any, b: any) => a.attempt - b.attempt);
      expect(flakyAttempts).toHaveLength(2);
      expect(flakyAttempts[0].state).toBe('error');
      expect(flakyAttempts[0].attempt).toBe(1);
      expect(flakyAttempts[0].next_attempt_run_node_id).toBe(flakyAttempts[1].id);
      expect(flakyAttempts[1].state).toBe('completed');
      expect(flakyAttempts[1].attempt).toBe(2);
      expect(flakyAttempts[1].retry_of_run_node_id).toBe(flakyAttempts[0].id);

      const downstreamNodes = run.run_nodes.filter((n: any) => n.name === 'after-flaky');
      expect(downstreamNodes).toHaveLength(1);
      expect(downstreamNodes[0].state).toBe('completed');
      expect(downstreamNodes[0].attempt).toBe(1);
    } finally {
      await deleteWorkspaceWithChildren(request, wid);
    }
  });

  test('workspace delete succeeds after a retrying run creates retry links', async ({ request }) => {
    const wid = await createWorkspace(request, 'Run Execution Retry Delete WS');
    try {
      const graph = await createGraph(
        request,
        wid,
        [
          {
            node_type: 'command',
            name: 'flaky',
            command_config: {
              command: [
                'count_file=.retry-delete-count',
                'count=$(cat "$count_file" 2>/dev/null || echo 0)',
                'count=$((count + 1))',
                'echo "$count" > "$count_file"',
                'if [ "$count" -lt 2 ]; then exit 1; fi',
                'printf ok',
              ].join('; '),
            },
          },
        ],
        [],
      );

      const createRes = await request.post(`/api/v1/workspaces/${wid}/graphs/${graph.id}/runs`);
      expect(createRes.status()).toBe(201);
      const created = await createRes.json();

      const run = await waitForRunTerminal(request, wid, graph.id, created.id);
      expect(run.state).toBe('completed');

      const flakyAttempts = run.run_nodes
        .filter((n: any) => n.name === 'flaky')
        .sort((a: any, b: any) => a.attempt - b.attempt);
      expect(flakyAttempts).toHaveLength(2);
      expect(flakyAttempts[0].next_attempt_run_node_id).toBe(flakyAttempts[1].id);
      expect(flakyAttempts[1].retry_of_run_node_id).toBe(flakyAttempts[0].id);

      const deleteRes = await request.delete(`/api/v1/workspaces/${wid}`);
      expect(deleteRes.status()).toBe(204);
    } finally {
      await deleteWorkspaceWithChildren(request, wid);
    }
  });

  for (const testCase of GRAPH_AGENT_CASES) {
    test(`${testCase.agentType} graph nodes fail if the session ends without explicit completion`, async ({ request }) => {
      const wid = await createWorkspace(request, `Explicit Completion ${testCase.agentType}`);
      try {
        const graph = await createGraph(
          request,
          wid,
          [
            {
              node_type: 'agent',
              name: 'needs-done-tool',
              agent_config: {
                agent_type: testCase.agentType,
                model: testCase.model,
                prompt: 'Wait for further instructions. Do not call any tools yet.',
              },
            },
          ],
          [],
        );

        const createRes = await request.post(`/api/v1/workspaces/${wid}/graphs/${graph.id}/runs`);
        expect(createRes.status()).toBe(201);
        const created = await createRes.json();

        const runningRun = await waitForRun(
          request,
          wid,
          graph.id,
          created.id,
          (run) => run.run_nodes.some((node: any) => node.name === 'needs-done-tool' && node.state === 'running' && node.session_id),
          120_000,
          1_000,
        );
        const node = runningRun.run_nodes.find((item: any) => item.name === 'needs-done-tool');
        expect(node?.session_id).toBeTruthy();

        const workspaceEvents = await listWorkspaceEvents(request, wid, 0, 200);
        const runningEvent = workspaceEvents.find((event) => event.node_id === node.id && event.type === 'run.node.running');
        expect(runningEvent?.worker_id).toMatch(UUID_RE);

        const ingestRes = await request.post(`/api/v1/workers/${runningEvent.worker_id}/events`, {
          data: {
            event: {
              session_id: node.session_id,
              type: 'session.idle',
              timestamp: new Date().toISOString(),
              data: {},
            },
          },
        });
        expect(ingestRes.status()).toBe(202);

        const terminalRun = await waitForRunTerminal(request, wid, graph.id, created.id);
        const terminalNode = terminalRun.run_nodes.find((item: any) => item.id === node.id);
        expect(terminalRun.state).toBe('error');
        expect(terminalNode?.state).toBe('error');
      } finally {
        await deleteWorkspaceWithChildren(request, wid);
      }
    });

    test(`${testCase.agentType} graph nodes can be completed without structured output`, async ({ request }) => {
      const wid = await createWorkspace(request, `Done Tool No Output ${testCase.agentType}`);
      try {
        const graph = await createGraph(
          request,
          wid,
          [
            {
              node_type: 'agent',
              name: 'manual-complete',
              agent_config: {
                agent_type: testCase.agentType,
                model: testCase.model,
                prompt: 'Wait for further instructions. Do not call any tools yet.',
              },
            },
          ],
          [],
        );

        const createRes = await request.post(`/api/v1/workspaces/${wid}/graphs/${graph.id}/runs`);
        expect(createRes.status()).toBe(201);
        const created = await createRes.json();

        const runningRun = await waitForRun(
          request,
          wid,
          graph.id,
          created.id,
          (run) => run.run_nodes.some((node: any) => node.name === 'manual-complete' && node.state === 'running'),
          120_000,
          1_000,
        );
        const node = runningRun.run_nodes.find((item: any) => item.name === 'manual-complete');

        const completeRes = await request.post(
          `/api/v1/workspaces/${wid}/runs/${created.id}/nodes/${node.id}/complete`,
          { data: {} },
        );
        expect(completeRes.status()).toBe(200);

        const terminalRun = await waitForRunTerminal(request, wid, graph.id, created.id);
        const terminalNode = terminalRun.run_nodes.find((item: any) => item.id === node.id);
        expect(terminalRun.state).toBe('completed');
        expect(terminalNode?.state).toBe('completed');
        expect(terminalNode?.output ?? null).toBeNull();
      } finally {
        await deleteWorkspaceWithChildren(request, wid);
      }
    });

    test(`${testCase.agentType} graph node completion enforces output schemas`, async ({ request }) => {
      const wid = await createWorkspace(request, `Done Tool Output ${testCase.agentType}`);
      try {
        const graph = await createGraph(
          request,
          wid,
          [
            {
              node_type: 'agent',
              name: 'manual-output',
              agent_config: {
                agent_type: testCase.agentType,
                model: testCase.model,
                prompt: 'Wait for further instructions. Do not call any tools yet.',
              },
              output_schema: { result: 'string' },
            },
          ],
          [],
        );

        const createRes = await request.post(`/api/v1/workspaces/${wid}/graphs/${graph.id}/runs`);
        expect(createRes.status()).toBe(201);
        const created = await createRes.json();

        const runningRun = await waitForRun(
          request,
          wid,
          graph.id,
          created.id,
          (run) => run.run_nodes.some((node: any) => node.name === 'manual-output' && node.state === 'running'),
          120_000,
          1_000,
        );
        const node = runningRun.run_nodes.find((item: any) => item.name === 'manual-output');

        const badCompleteRes = await request.post(
          `/api/v1/workspaces/${wid}/runs/${created.id}/nodes/${node.id}/complete`,
          { data: {} },
        );
        expect(badCompleteRes.status()).toBe(422);

        const goodCompleteRes = await request.post(
          `/api/v1/workspaces/${wid}/runs/${created.id}/nodes/${node.id}/complete`,
          { data: { output: { result: 'ok' } } },
        );
        expect(goodCompleteRes.status()).toBe(200);

        const terminalRun = await waitForRunTerminal(request, wid, graph.id, created.id);
        const terminalNode = terminalRun.run_nodes.find((item: any) => item.id === node.id);
        expect(terminalRun.state).toBe('completed');
        expect(terminalNode?.state).toBe('completed');
        expect(terminalNode?.output).toMatchObject({ result: 'ok' });
      } finally {
        await deleteWorkspaceWithChildren(request, wid);
      }
    });
  }

  test('running graph runs can be interrupted explicitly', async ({ request }) => {
    const wid = await createWorkspace(request, 'Run Interrupt Test');
    try {
      const graph = await createGraph(
        request,
        wid,
        [
          {
            node_type: 'command',
            name: 'slow-command',
            command_config: { command: 'sleep 60' },
          },
        ],
        [],
      );

      const createRes = await request.post(`/api/v1/workspaces/${wid}/graphs/${graph.id}/runs`);
      expect(createRes.status()).toBe(201);
      const created = await createRes.json();

      const runningRun = await waitForRun(
        request,
        wid,
        graph.id,
        created.id,
        (run) => run.run_nodes.some((node: any) => node.name === 'slow-command' && node.state === 'running'),
        60_000,
        1_000,
      );
      const node = runningRun.run_nodes.find((item: any) => item.name === 'slow-command');

      const interruptRes = await request.post(`/api/v1/workspaces/${wid}/runs/${created.id}/interrupt`, {
        data: { reason: 'test_interrupt' },
      });
      expect(interruptRes.status()).toBe(200);

      const terminalRun = await waitForRunTerminal(request, wid, graph.id, created.id, 60_000);
      const terminalNode = terminalRun.run_nodes.find((item: any) => item.id === node.id);
      expect(terminalRun.state).toBe('error');
      expect(terminalNode?.state).toBe('error');

      const workspaceEvents = await listWorkspaceEvents(request, wid, 0, 200);
      expect(workspaceEvents.some((event) => event.run_id === created.id && event.type === 'run.interrupted')).toBe(true);
    } finally {
      await deleteWorkspaceWithChildren(request, wid);
    }
  });

  test('deleted runs disappear from run history and workspace events', async ({ request }) => {
    const wid = await createWorkspace(request, 'Run Delete History Test');
    try {
      const graph = await createGraph(
        request,
        wid,
        [
          {
            node_type: 'command',
            name: 'fast-command',
            command_config: { command: 'echo done' },
          },
        ],
        [],
      );

      const createRes = await request.post(`/api/v1/workspaces/${wid}/graphs/${graph.id}/runs`);
      expect(createRes.status()).toBe(201);
      const created = await createRes.json();

      await waitForRunTerminal(request, wid, graph.id, created.id, 60_000);
      const beforeDeleteEvents = await listWorkspaceEvents(request, wid, 0, 200);
      expect(beforeDeleteEvents.some((event) => event.run_id === created.id)).toBe(true);

      const deleteRes = await request.delete(`/api/v1/workspaces/${wid}/runs/${created.id}`);
      expect(deleteRes.status()).toBe(204);

      const getDeletedRes = await request.get(`/api/v1/workspaces/${wid}/runs/${created.id}`);
      expect(getDeletedRes.status()).toBe(404);

      const listRunsRes = await request.get(`/api/v1/workspaces/${wid}/graphs/${graph.id}/runs`);
      expect(listRunsRes.status()).toBe(200);
      expect(await listRunsRes.json()).toEqual([]);

      const afterDeleteEvents = await listWorkspaceEvents(request, wid, 0, 200);
      expect(afterDeleteEvents.some((event) => event.run_id === created.id)).toBe(false);
    } finally {
      await deleteWorkspaceWithChildren(request, wid);
    }
  });

  test('worker loss fails an active run and the pool recovers automatically', async ({ request }) => {
    const deployMode = await getBackendDeployMode(request);
    test.skip(deployMode !== 'kubernetes', 'worker pod-loss recovery only applies to kubernetes deploys');

    const wid = await createWorkspace(request, 'Run Execution Test WS');
    try {
      const graph = await createGraph(
        request,
        wid,
        [{ node_type: 'command', name: 'long-command', command_config: { command: 'sleep 120' } }],
        [],
      );

      const createRes = await request.post(`/api/v1/workspaces/${wid}/graphs/${graph.id}/runs`);
      expect(createRes.status()).toBe(201);
      const created = await createRes.json();
      await sleep(2_000);

      const run = await getRun(request, wid, graph.id, created.id);
      expect(run.sandbox_id).toMatch(UUID_RE);

      const sandboxRes = await request.get(`/api/v1/workspaces/${wid}/sandboxes/${run.sandbox_id}`);
      expect(sandboxRes.status()).toBe(200);
      const sandbox = await sandboxRes.json();
      expect(sandbox.worker.pod_name).toBeTruthy();

      const podName = sandbox.worker.pod_name as string;
      deleteWorkerPod(podName);

      const failedRun = await waitForRunTerminal(request, wid, graph.id, created.id, 180_000);
      expect(failedRun.state).toBe('error');
      expect(failedRun.run_nodes[0].state).toBe('error');

      await sleep(2_000);
      waitForWorkerRollout();
    } finally {
      await deleteWorkspaceWithChildren(request, wid);
      await sleep(2_000);
      waitForWorkerRollout();
    }
  });
});
