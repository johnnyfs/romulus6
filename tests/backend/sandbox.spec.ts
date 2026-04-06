import { execFileSync } from 'node:child_process';

import { test, expect } from '@playwright/test';

import { UUID_RE, createWorkspace, deleteWorkspaceWithChildren } from './helpers';

const KUBE_NAMESPACE = process.env.ROMULUS_K8S_NAMESPACE ?? 'romulus';

function kubectlJson(pathExpression: string): any {
  return JSON.parse(
    execFileSync(
      'kubectl',
      ['get', 'deployments,services', '-n', KUBE_NAMESPACE, '-o', pathExpression],
      { encoding: 'utf8' },
    ),
  );
}

function countWorkerResources(): number {
  const resources = kubectlJson('json');
  return resources.items.filter((item: any) => {
    const labels = item.metadata?.labels ?? {};
    return labels.app === 'worker' || labels.app === 'worker-pool';
  }).length;
}

test.describe('Sandbox leasing', () => {
  test.describe.configure({ mode: 'serial' });

  test('sandbox creation leases a live pooled worker and does not create per-sandbox k8s resources', async ({ request }) => {
    const workspaceId = await createWorkspace(request, 'Sandbox Test WS');

    try {
      const resourceCountBefore = countWorkerResources();
      const createdSandboxes: string[] = [];
      const leasedWorkerIds = new Set<string>();

      const firstRes = await request.post(`/api/v1/workspaces/${workspaceId}/sandboxes`, {
        data: { name: 'primary-sandbox' },
      });
      expect(firstRes.status()).toBe(201);
      const first = await firstRes.json();

      expect(first.sandbox.id).toMatch(UUID_RE);
      expect(first.sandbox.worker_id).toBe(first.worker.id);
      expect(first.sandbox.current_lease_id).toMatch(UUID_RE);
      expect(first.worker.id).toMatch(UUID_RE);
      expect(first.worker.status).toBe('running');
      expect(first.worker.worker_url).toBeTruthy();
      createdSandboxes.push(first.sandbox.id);
      leasedWorkerIds.add(first.worker.id);

      const resourceCountAfterCreate = countWorkerResources();
      expect(resourceCountAfterCreate).toBe(resourceCountBefore);

      const secondRes = await request.post(`/api/v1/workspaces/${workspaceId}/sandboxes`, {
        data: { name: 'secondary-sandbox' },
      });
      expect([201, 503]).toContain(secondRes.status());
      if (secondRes.status() === 201) {
        const second = await secondRes.json();
        expect(second.sandbox.current_lease_id).toMatch(UUID_RE);
        expect(second.worker.id).toMatch(UUID_RE);
        expect(leasedWorkerIds.has(second.worker.id)).toBe(false);
        createdSandboxes.push(second.sandbox.id);
        leasedWorkerIds.add(second.worker.id);
      } else {
        expect((await secondRes.json()).detail).toContain('No healthy idle workers available');
      }

      const getFirstRes = await request.get(`/api/v1/workspaces/${workspaceId}/sandboxes/${first.sandbox.id}`);
      expect(getFirstRes.status()).toBe(200);
      const fetched = await getFirstRes.json();
      expect(fetched.worker.id).toBe(first.worker.id);
      expect(fetched.sandbox.current_lease_id).toBe(first.sandbox.current_lease_id);

      expect((await request.delete(`/api/v1/workspaces/${workspaceId}/sandboxes/${first.sandbox.id}`)).status()).toBe(204);

      const thirdRes = await request.post(`/api/v1/workspaces/${workspaceId}/sandboxes`, {
        data: { name: 'replacement-sandbox' },
      });
      expect(thirdRes.status()).toBe(201);
      const replacement = await thirdRes.json();
      expect(replacement.worker.id).toMatch(UUID_RE);
      expect(replacement.sandbox.current_lease_id).toMatch(UUID_RE);

      const resourceCountAfterRecycle = countWorkerResources();
      expect(resourceCountAfterRecycle).toBe(resourceCountBefore);
    } finally {
      await deleteWorkspaceWithChildren(request, workspaceId);
    }
  });
});
