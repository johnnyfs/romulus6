import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PLAYWRIGHT_BASE_URL = 'http://localhost:8000';
const FRONTEND_TARGET_FILE = '.frontend-backend-target';

function readFrontendTargetFile(): string | null {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(currentDir, '..', '..');
  const targetPath = path.join(repoRoot, FRONTEND_TARGET_FILE);

  try {
    const value = fs.readFileSync(targetPath, 'utf8').trim();
    return value || null;
  } catch {
    return null;
  }
}

export function resolveBackendBaseUrl(): string {
  return (
    process.env.PLAYWRIGHT_BASE_URL?.trim() ||
    process.env.BACKEND_TARGET?.trim() ||
    process.env.FRONTEND_BACKEND_TARGET?.trim() ||
    readFrontendTargetFile() ||
    DEFAULT_PLAYWRIGHT_BASE_URL
  );
}
