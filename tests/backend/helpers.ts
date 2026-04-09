import { expect, type APIRequestContext } from '@playwright/test';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function createWorkspace(
  request: APIRequestContext,
  namePrefix: string,
): Promise<string> {
  const res = await request.post('/api/v1/workspaces', {
    data: { name: `${namePrefix} ${crypto.randomUUID()}` },
  });
  expect(res.status()).toBe(201);
  return (await res.json()).id;
}

async function tryDelete(request: APIRequestContext, path: string): Promise<void> {
  try {
    await request.delete(path);
  } catch {
    // best-effort cleanup
  }
}

export async function deleteWorkspaceWithChildren(
  request: APIRequestContext,
  workspaceId: string,
): Promise<void> {
  const [graphsRes, agentsRes, sandboxesRes] = await Promise.all([
    request.get(`/api/v1/workspaces/${workspaceId}/graphs`).catch(() => null),
    request.get(`/api/v1/workspaces/${workspaceId}/agents`).catch(() => null),
    request.get(`/api/v1/workspaces/${workspaceId}/sandboxes`).catch(() => null),
  ]);

  const graphs: any[] = graphsRes?.ok() ? await graphsRes.json() : [];
  const agents: any[] = agentsRes?.ok() ? await agentsRes.json() : [];
  const sandboxes: any[] = sandboxesRes?.ok() ? await sandboxesRes.json() : [];

  await Promise.all([
    ...graphs.map((graph) => tryDelete(request, `/api/v1/workspaces/${workspaceId}/graphs/${graph.id}`)),
    ...agents.map((agent) => tryDelete(request, `/api/v1/workspaces/${workspaceId}/agents/${agent.id}`)),
    ...sandboxes.map((sandbox) => tryDelete(request, `/api/v1/workspaces/${workspaceId}/sandboxes/${sandbox.id}`)),
  ]);

  await tryDelete(request, `/api/v1/workspaces/${workspaceId}`);
}

export async function createGraph(
  request: APIRequestContext,
  workspaceId: string,
  nodes: any[],
  edges: any[],
  name = 'test-graph',
): Promise<any> {
  const res = await request.post(`/api/v1/workspaces/${workspaceId}/graphs`, {
    data: { name, nodes, edges },
  });
  expect(res.status()).toBe(201);
  return res.json();
}

export async function getBackendHealth(request: APIRequestContext): Promise<any> {
  const res = await request.get('/health');
  expect(res.status()).toBe(200);
  return res.json();
}

export async function getBackendDeployMode(request: APIRequestContext): Promise<string> {
  const health = await getBackendHealth(request);
  return typeof health.deploy_mode === 'string' ? health.deploy_mode : 'local';
}

export async function getRun(
  request: APIRequestContext,
  workspaceId: string,
  graphId: string,
  runId: string,
): Promise<any> {
  void graphId;
  const res = await request.get(`/api/v1/workspaces/${workspaceId}/runs/${runId}`);
  expect(res.status()).toBe(200);
  return res.json();
}

export async function waitForRun(
  request: APIRequestContext,
  workspaceId: string,
  graphId: string,
  runId: string,
  predicate: (run: any) => boolean,
  timeoutMs = 120_000,
  intervalMs = 1_000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await getRun(request, workspaceId, graphId, runId);
    if (predicate(run)) {
      return run;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Run ${runId} did not satisfy predicate within ${timeoutMs}ms`);
}

export async function waitForRunTerminal(
  request: APIRequestContext,
  workspaceId: string,
  graphId: string,
  runId: string,
  timeoutMs = 300_000,
): Promise<any> {
  return waitForRun(
    request,
    workspaceId,
    graphId,
    runId,
    (run) => run.state === 'completed' || run.state === 'error',
    timeoutMs,
    2_000,
  );
}

export async function listWorkspaceEvents(
  request: APIRequestContext,
  workspaceId: string,
  since = 0,
  limit = 200,
): Promise<any[]> {
  const res = await request.get(`/api/v1/workspaces/${workspaceId}/events?since=${since}&limit=${limit}`);
  expect(res.status()).toBe(200);
  return res.json();
}

export async function waitForWorkspaceEvents(
  request: APIRequestContext,
  workspaceId: string,
  predicate: (event: any) => boolean,
  since = 0,
  timeoutMs = 120_000,
  intervalMs = 2_000,
): Promise<{ event: any; cursor: number; events: any[] }> {
  const deadline = Date.now() + timeoutMs;
  let cursor = since;

  while (Date.now() < deadline) {
    const events = await listWorkspaceEvents(request, workspaceId, cursor, 200);
    cursor += events.length;
    const match = events.find(predicate);
    if (match) {
      return { event: match, cursor, events };
    }
    await sleep(intervalMs);
  }

  throw new Error(`Timed out waiting for workspace event in workspace ${workspaceId}`);
}
