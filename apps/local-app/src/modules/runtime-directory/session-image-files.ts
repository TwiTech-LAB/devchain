import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { SESSION_FILES_DIRECTORY } from './runtime-directory';

const ATTACHMENTS_DIRECTORY = 'attachments';
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
const imageName = new RegExp(`^${uuid}\\.(png|jpg)$`);
const partialName = new RegExp(`^\\.${uuid}\\.part$`);

export const isImageName = (name: string): boolean => imageName.test(name);
export const isImagePartial = (name: string): boolean => partialName.test(name);

async function directoryExists(path: string): Promise<boolean> {
  return lstat(path).then(
    (stat) => stat.isDirectory(),
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );
}

export async function prepareImageDirectory(
  root: string,
  sessionDirectory: string,
): Promise<string> {
  const directory = join(sessionDirectory, ATTACHMENTS_DIRECTORY);
  for (const path of [root, dirname(sessionDirectory), sessionDirectory, directory]) {
    await mkdir(path, { recursive: path === root, mode: 0o700 }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      },
    );
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await handle.stat();
      if (process.getuid && stat.uid !== process.getuid())
        throw new Error('Session image directory has a different owner');
      if ((stat.mode & 0o777) !== 0o700) await handle.chmod(0o700);
    } finally {
      await handle.close();
    }
  }
  return directory;
}

export async function* existingImageDirectories(roots: string[], onlySession?: string) {
  for (const root of roots) {
    const sessions = join(root, SESSION_FILES_DIRECTORY);
    if (!(await directoryExists(root)) || !(await directoryExists(sessions))) continue;
    for (const session of await readdir(sessions, { withFileTypes: true })) {
      if (!session.isDirectory() || (onlySession !== undefined && session.name !== onlySession))
        continue;
      const directory = join(sessions, session.name, ATTACHMENTS_DIRECTORY);
      if (await directoryExists(directory)) yield { directory, sessionId: session.name };
    }
  }
}
