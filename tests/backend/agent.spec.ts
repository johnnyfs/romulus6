import { test, expect } from '@playwright/test';

import {
  UUID_RE,
  createWorkspace,
  deleteWorkspaceWithChildren,
  listWorkspaceEvents,
  waitForWorkspaceEvents,
} from './helpers';
import { resolveBackendBaseUrl } from './base-url';

const BASE_URL = resolveBackendBaseUrl();

async function readFirstSseEvent(
  workspaceId: string,
  since = 0,
): Promise<any> {
  const controller = new AbortController();
  const response = await fetch(`${BASE_URL}/api/v1/workspaces/${workspaceId}/events/stream?since=${since}`, {
    signal: controller.signal,
  });
  expect(response.ok).toBeTruthy();
  expect(response.body).toBeTruthy();

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() ?? '';

      for (const chunk of chunks) {
        const dataLine = chunk
          .split('\n')
          .find((line) => line.startsWith('data: '));
        if (!dataLine) {
          continue;
        }
        return JSON.parse(dataLine.slice('data: '.length));
      }
    }
  } finally {
    controller.abort();
    await reader.cancel().catch(() => undefined);
  }

  throw new Error(`No SSE event received for workspace ${workspaceId}`);
}

test.describe('Agent API', () => {
  test.setTimeout(300_000);

  test('agent type requests enforce model allowlists and required schema fields', async ({ request }) => {
    const workspaceId = await createWorkspace(request, 'Agent Validation WS');

    try {
      const badOpenCode = await request.post(`/api/v1/workspaces/${workspaceId}/agents`, {
        data: {
          agent_type: 'opencode',
          model: 'google/gemini-2.5-pro',
          name: 'bad-opencode',
          prompt: 'hello',
        },
      });
      expect(badOpenCode.status()).toBe(422);

      const missingSchema = await request.post(`/api/v1/workspaces/${workspaceId}/agents`, {
        data: {
          agent_type: 'pydantic',
          model: 'google/gemini-2.5-pro',
          name: 'missing-schema',
          prompt: 'hello',
        },
      });
      expect(missingSchema.status()).toBe(422);

      const badPydanticModel = await request.post(`/api/v1/workspaces/${workspaceId}/agents`, {
        data: {
          agent_type: 'pydantic',
          model: 'openai/gpt-5.3-codex',
          name: 'bad-pydantic',
          prompt: 'hello',
          schema_id: 'structured_response_v1',
        },
      });
      expect(badPydanticModel.status()).toBe(422);
    } finally {
      await deleteWorkspaceWithChildren(request, workspaceId);
    }
  });

  test('agent lifecycle is observable through workspace events, not agent-local polling', async ({ request }) => {
    const workspaceId = await createWorkspace(request, 'Agent Test WS');

    try {
      const createRes = await request.post(`/api/v1/workspaces/${workspaceId}/agents`, {
        data: {
          agent_type: 'opencode',
          model: 'anthropic/claude-haiku-4-5',
          name: 'Greeter',
          prompt: 'Say hello in one short sentence.',
        },
        timeout: 120_000,
      });
      expect(createRes.status()).toBe(201);
      const agent = await createRes.json();
      expect(agent.id).toMatch(UUID_RE);
      expect(agent.sandbox_id).toMatch(UUID_RE);
      expect(agent.session_id).toBeTruthy();

      const initialEvents = await waitForWorkspaceEvents(
        request,
        workspaceId,
        (event) =>
          event.agent_id === agent.id &&
          (event.type === 'session.idle' || event.type === 'session.completed'),
      );

      expect(initialEvents.event.workspace_id).toBe(workspaceId);
      expect(initialEvents.event.source_type).toBe('agent');
      expect(initialEvents.event.sandbox_id).toBe(agent.sandbox_id);
      expect(initialEvents.event.worker_id).toMatch(UUID_RE);
      expect(new Date(initialEvents.event.received_at).toString()).not.toBe('Invalid Date');

      const firstPage = await listWorkspaceEvents(request, workspaceId, 0, 2);
      const secondPage = await listWorkspaceEvents(request, workspaceId, 2, 2);
      expect(firstPage.length).toBeLessThanOrEqual(2);
      if (firstPage.length > 0 && secondPage.length > 0) {
        expect(
          new Date(firstPage[firstPage.length - 1].received_at).getTime(),
        ).toBeLessThanOrEqual(new Date(secondPage[0].received_at).getTime());
      }

      const sseEvent = await readFirstSseEvent(workspaceId, 0);
      expect(sseEvent.workspace_id).toBe(workspaceId);
      expect(sseEvent.agent_id).toBe(agent.id);
      expect(sseEvent.sandbox_id).toBe(agent.sandbox_id);
      expect(sseEvent.worker_id).toMatch(UUID_RE);

      const messageRes = await request.post(`/api/v1/workspaces/${workspaceId}/agents/${agent.id}/messages`, {
        data: { prompt: 'Now greet the operator in one short sentence.' },
      });
      expect(messageRes.status()).toBe(202);

      const followUp = await waitForWorkspaceEvents(
        request,
        workspaceId,
        (event) =>
          event.agent_id === agent.id &&
          (event.type === 'session.idle' || event.type === 'session.completed'),
        initialEvents.cursor,
      );
      expect(followUp.cursor).toBeGreaterThan(initialEvents.cursor);

      const followUpSlice = await listWorkspaceEvents(
        request,
        workspaceId,
        initialEvents.cursor,
        followUp.cursor - initialEvents.cursor,
      );
      expect(followUpSlice.length).toBeGreaterThan(0);
      expect(followUpSlice.every((event) => new Date(event.received_at).toString() !== 'Invalid Date')).toBe(true);

      const directDeleteRes = await request.delete(`/api/v1/workspaces/${workspaceId}/agents/${agent.id}`);
      expect(directDeleteRes.status()).toBe(409);

      const dismissRes = await request.post(`/api/v1/workspaces/${workspaceId}/agents/${agent.id}/dismiss`, {
        data: { dismissed: true },
      });
      expect(dismissRes.status()).toBe(200);
      const dismissedAgent = await dismissRes.json();
      expect(dismissedAgent.dismissed).toBe(true);
      expect(dismissedAgent.sandbox_id).toBe(null);
      expect(dismissedAgent.session_id).toBe(null);
      expect(dismissedAgent.status).toBe('interrupted');

      expect((await request.delete(`/api/v1/workspaces/${workspaceId}/agents/${agent.id}`)).status()).toBe(204);
      expect((await request.get(`/api/v1/workspaces/${workspaceId}/agents/${agent.id}`)).status()).toBe(404);
    } finally {
      await deleteWorkspaceWithChildren(request, workspaceId);
    }
  });
});
