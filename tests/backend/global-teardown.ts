import { request } from '@playwright/test';

const TEST_WORKSPACE_NAMES = new Set([
  'Test Workspace',
  'To Be Deleted',
  'Graph Test WS',
  'Run Test WS',
  'Agent Test WS',
]);

async function tryDelete(ctx: Awaited<ReturnType<typeof request.newContext>>, path: string) {
  try {
    await ctx.delete(path);
  } catch {
    // best-effort: ignore network errors (e.g. sandbox teardown disrupts connection)
  }
}

async function deleteWorkspaceWithChildren(ctx: Awaited<ReturnType<typeof request.newContext>>, id: string) {
  const [graphsRes, agentsRes, sandboxesRes] = await Promise.all([
    ctx.get(`/api/v1/workspaces/${id}/graphs`).catch(() => null),
    ctx.get(`/api/v1/workspaces/${id}/agents`).catch(() => null),
    ctx.get(`/api/v1/workspaces/${id}/sandboxes`).catch(() => null),
  ]);
  const graphs: any[] = graphsRes?.ok() ? await graphsRes.json() : [];
  const agents: any[] = agentsRes?.ok() ? await agentsRes.json() : [];
  const sandboxes: any[] = sandboxesRes?.ok() ? await sandboxesRes.json() : [];

  await Promise.all([
    ...graphs.map((g) => tryDelete(ctx, `/api/v1/workspaces/${id}/graphs/${g.id}`)),
    ...agents.map((a) => tryDelete(ctx, `/api/v1/workspaces/${id}/agents/${a.id}`)),
    ...sandboxes.map((s) => tryDelete(ctx, `/api/v1/workspaces/${id}/sandboxes/${s.id}`)),
  ]);
  await tryDelete(ctx, `/api/v1/workspaces/${id}`);
}

export default async function globalTeardown() {
  const ctx = await request.newContext({ baseURL: 'http://localhost:8000' });
  try {
    const res = await ctx.get('/api/v1/workspaces');
    if (!res.ok()) return;
    const workspaces: any[] = await res.json();
    for (const ws of workspaces.filter((w) => TEST_WORKSPACE_NAMES.has(w.name))) {
      await deleteWorkspaceWithChildren(ctx, ws.id);
    }
  } finally {
    await ctx.dispose();
  }
}
