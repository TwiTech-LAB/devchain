import { randomUUID } from 'crypto';
import { chmod, mkdir, rename, unlink, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { getDbConfig } from '../storage/db/db.config';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export const RUNTIME_CONTEXT_ENDPOINT_FILE_NAME = 'endpoint.json';

export function getRuntimeContextCaptureRoot(dbPath = getDbConfig().dbPath): string {
  return join(dirname(dbPath), 'runtime-context');
}

export function getRuntimeContextEndpointPath(rootPath = getRuntimeContextCaptureRoot()): string {
  return join(rootPath, RUNTIME_CONTEXT_ENDPOINT_FILE_NAME);
}

export async function writeRuntimeContextEndpointDiscovery(
  apiUrl: string,
  rootPath = getRuntimeContextCaptureRoot(),
): Promise<string> {
  await mkdir(rootPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await chmod(rootPath, PRIVATE_DIRECTORY_MODE);

  const endpointPath = getRuntimeContextEndpointPath(rootPath);
  const tempPath = `${endpointPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tempPath, JSON.stringify({ apiUrl }), {
      encoding: 'utf8',
      mode: PRIVATE_FILE_MODE,
      flag: 'wx',
    });
    await rename(tempPath, endpointPath);
    await chmod(endpointPath, PRIVATE_FILE_MODE);
    return endpointPath;
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}
