import { execFileSync } from 'node:child_process';

import { test, expect } from '@playwright/test';

import {
  UUID_RE,
  createGraph,
  createWorkspace,
  deleteWorkspaceWithChildren,
  getRun,
  listWorkspaceEvents,
  sleep,
  waitForRunTerminal,
} from './helpers';

const KUBE_NAMESPACE = process.env.ROMULUS_K8S_NAMESPACE ?? 'romulus';

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
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(300_000);

  test('controller dispatches pending nodes and the workspace event stream captures run execution', async ({ request }) => {
    const wid = await createWorkspace(request, 'Run Execution Test WS');
    try {
      const graph = await createGraph(
        request, wid,
        [
          { node_type: 'command', name: 'start', command_config: { command: 'sleep 2; echo ok' } },
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

      // Agent node completed with agent metadata
      const agentNode = run.run_nodes.find((n: any) => n.node_type === 'agent');
      expect(agentNode).toBeTruthy();
      expect(agentNode.state).toBe('completed');
      expect(agentNode.agent_id).toMatch(UUID_RE);
      expect(agentNode.session_id).toBeTruthy();

      const workspaceEvents = await listWorkspaceEvents(request, wid, 0, 200);
      const runEvents = workspaceEvents.filter((event) => event.run_id === created.id);
      expect(runEvents.length).toBeGreaterThan(0);
      expect(runEvents.some((event) => event.node_id === cmdNode.id && event.type === 'command.output')).toBe(true);
      expect(runEvents.some((event) => event.node_id === agentNode.id && event.type === 'session.idle')).toBe(true);
      expect(runEvents.every((event) => event.worker_id && event.sandbox_id === run.sandbox_id)).toBe(true);
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

      const cmdNode = run.run_nodes.find((n: any) => n.node_type === 'command');
      expect(cmdNode.state).toBe('error');
    } finally {
      await deleteWorkspaceWithChildren(request, wid);
    }
  });

  test('worker loss fails an active run and the pool recovers automatically', async ({ request }) => {
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
