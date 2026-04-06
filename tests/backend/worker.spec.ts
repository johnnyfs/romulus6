import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';

import { UUID_RE } from './helpers';

const KUBE_NAMESPACE = process.env.ROMULUS_K8S_NAMESPACE ?? 'romulus';

function metadataOf(worker: any): Record<string, unknown> {
  return worker.worker_metadata ?? worker.metadata ?? {};
}

function deleteWorkerByRegistrationKey(registrationKey: string): void {
  execFileSync(
    'kubectl',
    [
      'exec',
      '-n',
      KUBE_NAMESPACE,
      'deployment/romulus-postgres',
      '--',
      'bash',
      '-lc',
      `psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "delete from worker where registration_key = '${registrationKey}';"`,
    ],
    { encoding: 'utf8' },
  );
}

test.describe('Worker API', () => {
  test('register reuses registration identity and heartbeat refreshes worker state', async ({ request }) => {
    const registrationKey = `playwright-${crypto.randomUUID()}`;
    try {
      const registerRes = await request.post('/api/v1/workers/register', {
        data: {
          worker_url: 'http://10.0.0.10:8080',
          pod_name: 'playwright-worker-a',
          pod_ip: '10.0.0.10',
          registration_key: registrationKey,
          metadata: { source: 'playwright', generation: 1 },
        },
      });
      expect(registerRes.status()).toBe(201);
      const worker = await registerRes.json();
      expect(worker.id).toMatch(UUID_RE);
      expect(worker.status).toBe('running');
      expect(worker.worker_url).toBe('http://10.0.0.10:8080');
      expect(worker.registration_key).toBe(registrationKey);
      expect(metadataOf(worker).source).toBe('playwright');

      const refreshRes = await request.post('/api/v1/workers/register', {
        data: {
          worker_url: 'http://10.0.0.11:8080',
          pod_name: 'playwright-worker-b',
          pod_ip: '10.0.0.11',
          registration_key: registrationKey,
          metadata: { source: 'playwright', generation: 2 },
        },
      });
      expect(refreshRes.status()).toBe(201);
      const refreshed = await refreshRes.json();
      expect(refreshed.id).toBe(worker.id);
      expect(refreshed.worker_url).toBe('http://10.0.0.11:8080');
      expect(refreshed.pod_ip).toBe('10.0.0.11');
      expect(metadataOf(refreshed).generation).toBe(2);

      const heartbeatRes = await request.post(`/api/v1/workers/${worker.id}/heartbeat`, {
        data: {
          worker_url: 'http://10.0.0.12:8080',
          pod_ip: '10.0.0.12',
          metadata: { source: 'playwright', generation: 3, heartbeat: true },
        },
      });
      expect(heartbeatRes.status()).toBe(200);
      const heartbeated = await heartbeatRes.json();
      expect(heartbeated.id).toBe(worker.id);
      expect(heartbeated.status).toBe('running');
      expect(heartbeated.worker_url).toBe('http://10.0.0.12:8080');
      expect(heartbeated.pod_ip).toBe('10.0.0.12');
      expect(metadataOf(heartbeated).heartbeat).toBe(true);
      expect(heartbeated.last_heartbeat_at).toBeTruthy();
    } finally {
      deleteWorkerByRegistrationKey(registrationKey);
    }
  });

  test('heartbeat returns 404 for an unknown worker', async ({ request }) => {
    const missingId = crypto.randomUUID();
    const res = await request.post(`/api/v1/workers/${missingId}/heartbeat`, {
      data: { worker_url: 'http://10.0.0.20:8080' },
    });
    expect(res.status()).toBe(404);
  });
});
