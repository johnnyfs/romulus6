import { test, expect } from '@playwright/test';

import {
  createWorkspace,
  deleteWorkspaceWithChildren,
  listWorkspaceEvents,
  waitForWorkspaceEvents,
} from './helpers';

test.describe('Agent feedback API', () => {
  test.setTimeout(180_000);

  test('feedback request events transition the agent to waiting and feedback responses are persisted', async ({ request }) => {
    const workspaceId = await createWorkspace(request, 'Feedback Test WS');

    try {
      const createRes = await request.post(`/api/v1/workspaces/${workspaceId}/agents`, {
        data: {
          agent_type: 'opencode',
          model: 'anthropic/claude-haiku-4-5',
          name: 'feedback-agent',
          prompt: 'Say hello once and then stop.',
        },
        timeout: 120_000,
      });
      expect(createRes.status()).toBe(201);
      const agent = await createRes.json();

      const initialTerminal = await waitForWorkspaceEvents(
        request,
        workspaceId,
        (event) =>
          event.agent_id === agent.id &&
          (event.type === 'session.idle' || event.type === 'session.completed'),
      );
      expect(initialTerminal.event.worker_id).toBeTruthy();

      const feedbackRequestId = `feedback-${crypto.randomUUID()}`;
      const ingestRes = await request.post(
        `/api/v1/workers/${initialTerminal.event.worker_id}/events`,
        {
          data: {
            event: {
              id: `evt-${crypto.randomUUID()}`,
              type: 'feedback.request',
              session_id: agent.session_id,
              timestamp: new Date().toISOString(),
              data: {
                feedback_id: feedbackRequestId,
                feedback_type: 'input',
                title: 'Need a module name',
                context: { question: 'What should we call it?' },
              },
            },
          },
        },
      );
      expect(ingestRes.status()).toBe(202);

      const feedbackRequest = await waitForWorkspaceEvents(
        request,
        workspaceId,
        (event) => event.type === 'feedback.request' && event.agent_id === agent.id,
        initialTerminal.cursor,
      );
      expect(feedbackRequest.event.data.feedback_id).toBe(feedbackRequestId);

      const agentWhileWaitingRes = await request.get(`/api/v1/workspaces/${workspaceId}/agents/${agent.id}`);
      expect(agentWhileWaitingRes.status()).toBe(200);
      expect((await agentWhileWaitingRes.json()).status).toBe('waiting');

      const feedbackRes = await request.post(`/api/v1/workspaces/${workspaceId}/agents/${agent.id}/feedback`, {
        data: {
          feedback_id: feedbackRequestId,
          feedback_type: 'input',
          response: 'romulus_feedback_module',
        },
      });
      expect(feedbackRes.status()).toBe(202);

      const responseEvents = await listWorkspaceEvents(request, workspaceId, feedbackRequest.cursor, 50);
      const persistedResponse = responseEvents.find(
        (event) => event.type === 'feedback.response' && event.agent_id === agent.id,
      );
      expect(persistedResponse).toBeTruthy();
      expect(persistedResponse.data.feedback_id).toBe(feedbackRequestId);
      expect(persistedResponse.data.response).toBe('romulus_feedback_module');

      const agentAfterSubmitRes = await request.get(`/api/v1/workspaces/${workspaceId}/agents/${agent.id}`);
      expect(agentAfterSubmitRes.status()).toBe(200);
      expect((await agentAfterSubmitRes.json()).status).toBe('busy');
    } finally {
      await deleteWorkspaceWithChildren(request, workspaceId);
    }
  });
});
