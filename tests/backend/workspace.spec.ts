import { test, expect } from '@playwright/test';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test.describe('Workspace API', () => {

  test('POST /workspaces creates a workspace and returns 201', async ({ request }) => {
    const response = await request.post('/api/v1/workspaces', {
      data: { name: 'Test Workspace' },
    });
    const body = await response.json();
    try {
      expect(response.status()).toBe(201);
      expect(body).toMatchObject({ name: 'Test Workspace' });
      expect(typeof body.id).toBe('string');
      expect(body.id).toMatch(UUID_RE);
    } finally {
      await request.delete(`/api/v1/workspaces/${body.id}`);
    }
  });

  test('DELETE /workspaces/{id} deletes an existing workspace and returns 204', async ({ request }) => {
    const createResponse = await request.post('/api/v1/workspaces', {
      data: { name: 'To Be Deleted' },
    });
    expect(createResponse.status()).toBe(201);
    const { id } = await createResponse.json();

    const deleteResponse = await request.delete(`/api/v1/workspaces/${id}`);
    expect(deleteResponse.status()).toBe(204);
  });

  test('DELETE /workspaces/{id} returns 404 for a non-existent workspace', async ({ request }) => {
    const nonExistentId = '00000000-0000-4000-8000-000000000000';
    const response = await request.delete(`/api/v1/workspaces/${nonExistentId}`);

    expect(response.status()).toBe(404);
    const body = await response.json();
    expect(body).toMatchObject({ detail: 'Workspace not found' });
  });

});
