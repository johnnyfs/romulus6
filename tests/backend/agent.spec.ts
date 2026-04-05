import { test, expect, type APIRequestContext } from '@playwright/test';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPLY_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 3_000;

async function waitForTextReply(
  request: APIRequestContext,
  workspaceId: string,
  agentId: string,
  since = 0,
  timeoutMs = REPLY_TIMEOUT_MS,
): Promise<{ text: string; since: number }> {
  const deadline = Date.now() + timeoutMs;
  let cursor = since;
  let text = '';
  let gotText = false;

  while (Date.now() < deadline) {
    const res = await request.get(
      `/api/v1/workspaces/${workspaceId}/agents/${agentId}/events?since=${cursor}`,
    );
    expect(res.status()).toBe(200);
    const events: any[] = await res.json();
    cursor += events.length;

    for (const ev of events) {
      if (ev.type === 'text.delta') {
        text += ev.data.delta ?? '';
        gotText = true;
      }
      if (gotText && (ev.type === 'session.idle' || ev.type === 'session.completed')) {
        return { text, since: cursor };
      }
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw new Error(`Timed out waiting for reply from agent ${agentId} (received so far: "${text}")`);
}

test.describe('Agent API', () => {
  test.setTimeout(300_000);

  test('create two agents, get replies, send follow-up, delete agents and sandboxes', async ({ request }) => {
    // --- setup ---
    const wsRes = await request.post('/api/v1/workspaces', { data: { name: 'Agent Test WS' } });
    expect(wsRes.status()).toBe(201);
    const { id: workspaceId } = await wsRes.json();

    // --- create Greeter and Farewell agents ---
    const greeterRes = await request.post(`/api/v1/workspaces/${workspaceId}/agents`, {
      data: { type: 'opencode', model: 'anthropic/claude-haiku-4-5', name: 'Greeter', prompt: 'Just say hi. One sentence only.' },
    });
    expect(greeterRes.status()).toBe(201);
    const greeter = await greeterRes.json();
    expect(greeter.name).toBe('Greeter');
    expect(greeter.id).toMatch(UUID_RE);
    expect(greeter.session_id).toBeTruthy();

    const farewellRes = await request.post(`/api/v1/workspaces/${workspaceId}/agents`, {
      data: { type: 'opencode', model: 'anthropic/claude-haiku-4-5', name: 'Farewell', prompt: 'Just say bye. One sentence only.' },
    });
    expect(farewellRes.status()).toBe(201);
    const farewell = await farewellRes.json();
    expect(farewell.name).toBe('Farewell');
    expect(farewell.id).toMatch(UUID_RE);
    expect(farewell.session_id).toBeTruthy();

    // --- both agents appear in list ---
    const listRes = await request.get(`/api/v1/workspaces/${workspaceId}/agents`);
    expect(listRes.status()).toBe(200);
    const list = await listRes.json();
    expect(list.some((a: any) => a.id === greeter.id)).toBe(true);
    expect(list.some((a: any) => a.id === farewell.id)).toBe(true);

    // --- wait for initial replies ---
    const greeterReply = await waitForTextReply(request, workspaceId, greeter.id);
    expect(greeterReply.text.trim().length).toBeGreaterThan(0);
    console.log(`[Greeter] initial: "${greeterReply.text.trim()}"`);

    const farewellReply = await waitForTextReply(request, workspaceId, farewell.id);
    expect(farewellReply.text.trim().length).toBeGreaterThan(0);
    console.log(`[Farewell] initial: "${farewellReply.text.trim()}"`);

    // --- send follow-up to Greeter only and wait for reply ---
    const msgRes = await request.post(`/api/v1/workspaces/${workspaceId}/agents/${greeter.id}/messages`, {
      data: { prompt: 'Call me operator for now.' },
    });
    expect(msgRes.status()).toBe(202);

    const followUp = await waitForTextReply(request, workspaceId, greeter.id, greeterReply.since);
    expect(followUp.text.trim().length).toBeGreaterThan(0);
    console.log(`[Greeter] follow-up: "${followUp.text.trim()}"`);

    // --- delete agents ---
    expect((await request.delete(`/api/v1/workspaces/${workspaceId}/agents/${greeter.id}`)).status()).toBe(204);
    expect((await request.delete(`/api/v1/workspaces/${workspaceId}/agents/${farewell.id}`)).status()).toBe(204);
    expect((await request.get(`/api/v1/workspaces/${workspaceId}/agents/${greeter.id}`)).status()).toBe(404);

    // --- delete sandboxes ---
    expect((await request.delete(`/api/v1/workspaces/${workspaceId}/sandboxes/${greeter.sandbox_id}`)).status()).toBe(204);
    expect((await request.delete(`/api/v1/workspaces/${workspaceId}/sandboxes/${farewell.sandbox_id}`)).status()).toBe(204);

    // --- teardown ---
    await request.delete(`/api/v1/workspaces/${workspaceId}`);
  });

});
