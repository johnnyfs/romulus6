import { request } from '@playwright/test';

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:8000';
const TEST_WORKSPACE_NAME_PREFIXES = [
  'Test Workspace',
  'To Be Deleted',
  'Graph Test WS',
  'Run Test WS',
  'Agent Test WS',
  'Run Execution Test WS',
  'Sandbox Test WS',
  'Workspace Events Test WS',
  'Worker API Test WS',
];

async function tryDelete(ctx: Awaited<ReturnType<typeof request.newContext>>, path: string) {
  try {
    await ctx.delete(path);
  } catch {
    // best-effort: ignore network errors (e.g. sandbox teardown disrupts connection)
  }
}

async function deleteWorkspaceWithChildren(ctx: Awaited<ReturnType<typeof request.newContext>>, id: string) {
  const [graphsRes, agentsRes, sandboxesRes, taskTmplRes, subTmplRes] = await Promise.all([
    ctx.get(`/api/v1/workspaces/${id}/graphs`).catch(() => null),
    ctx.get(`/api/v1/workspaces/${id}/agents`).catch(() => null),
    ctx.get(`/api/v1/workspaces/${id}/sandboxes`).catch(() => null),
    ctx.get(`/api/v1/workspaces/${id}/task-templates`).catch(() => null),
    ctx.get(`/api/v1/workspaces/${id}/subgraph-templates`).catch(() => null),
  ]);
  const graphs: any[] = graphsRes?.ok() ? await graphsRes.json() : [];
  const agents: any[] = agentsRes?.ok() ? await agentsRes.json() : [];
  const sandboxes: any[] = sandboxesRes?.ok() ? await sandboxesRes.json() : [];
  const taskTemplates: any[] = taskTmplRes?.ok() ? await taskTmplRes.json() : [];
  const subTemplates: any[] = subTmplRes?.ok() ? await subTmplRes.json() : [];

  await Promise.all([
    ...graphs.map((g) => tryDelete(ctx, `/api/v1/workspaces/${id}/graphs/${g.id}`)),
    ...agents.map((a) => tryDelete(ctx, `/api/v1/workspaces/${id}/agents/${a.id}`)),
    ...sandboxes.map((s) => tryDelete(ctx, `/api/v1/workspaces/${id}/sandboxes/${s.id}`)),
    ...subTemplates.map((t) => tryDelete(ctx, `/api/v1/workspaces/${id}/subgraph-templates/${t.id}`)),
    ...taskTemplates.map((t) => tryDelete(ctx, `/api/v1/workspaces/${id}/task-templates/${t.id}`)),
  ]);
  await tryDelete(ctx, `/api/v1/workspaces/${id}`);
}

export default async function globalSetup() {
  const ctx = await request.newContext({ baseURL: BASE_URL });
  try {
    const res = await ctx.get('/api/v1/workspaces');
    if (!res.ok()) return;
    const workspaces: any[] = await res.json();
    for (const ws of workspaces.filter((w) =>
      TEST_WORKSPACE_NAME_PREFIXES.some((prefix) => typeof w.name === 'string' && w.name.startsWith(prefix))
    )) {
      await deleteWorkspaceWithChildren(ctx, ws.id);
    }
  } finally {
    await ctx.dispose();
  }
}
