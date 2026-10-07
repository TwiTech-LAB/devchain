import { Server, utils, type AuthContext, type Connection, type ServerChannel } from 'ssh2';

export interface FakeSshServer {
  port: number;
  files: Map<string, Buffer>;
  modes: Map<string, number | undefined>;
  close(): Promise<void>;
}

export function hostKey(): string {
  // ssh2's generator can strip a leading NUL from an ed25519 public key.
  // Only parseable fixtures may reach the server's constructor.
  for (let attempt = 0; attempt < 10; attempt++) {
    const key = utils.generateKeyPairSync('ed25519').private;
    if (!(utils.parseKey(key) instanceof Error)) return key;
  }
  throw new Error('ssh2 did not generate a valid ed25519 fixture');
}

export async function startFakeSsh(
  key: string,
  port = 0,
  execOutput: string | string[] = '',
  authenticate: (context: AuthContext) => void = (context) => context.accept(),
  handleExec?: (command: string, stream: ServerChannel) => boolean,
): Promise<FakeSshServer> {
  const clients = new Set<Connection>();
  const files = new Map<string, Buffer>();
  const modes = new Map<string, number | undefined>();
  const handles = new Map<string, string>();
  let nextHandle = 1;
  const server = new Server({ hostKeys: [key] }, (client) => {
    clients.add(client);
    client.on('error', () => undefined);
    client.on('authentication', authenticate);
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec();
          if (handleExec?.(info.command, stream)) return;
          const output = info.command.startsWith('mktemp ')
            ? ['/tmp/devchain-host-install.fake123\n']
            : Array.isArray(execOutput)
              ? execOutput
              : [execOutput];
          if (output.length === 1 && output[0] === '__DEVCHAIN_HANG__') return;
          for (const chunk of output) {
            stream.write(chunk);
            if (!info.command.startsWith('mktemp ')) stream.stderr.write(chunk);
          }
          stream.exit(0);
          stream.end();
        });
        session.on('sftp', (acceptSftp) => {
          const sftp = acceptSftp();
          sftp.on('OPEN', (requestId, filename, _flags, attributes) => {
            const handle = Buffer.from(String(nextHandle++));
            handles.set(handle.toString('hex'), filename);
            files.set(filename, Buffer.alloc(0));
            modes.set(filename, attributes.mode);
            sftp.handle(requestId, handle);
          });
          sftp.on('WRITE', (requestId, handle, offset, data) => {
            const filename = handles.get(handle.toString('hex'));
            if (!filename) return sftp.status(requestId, 2);
            const current = files.get(filename) ?? Buffer.alloc(0);
            const next = Buffer.alloc(Math.max(current.length, offset + data.length));
            current.copy(next);
            data.copy(next, offset);
            files.set(filename, next);
            sftp.status(requestId, 0);
          });
          sftp.on('CLOSE', (requestId, handle) => {
            handles.delete(handle.toString('hex'));
            sftp.status(requestId, 0);
          });
        });
      });
    });
    client.on('close', () => clients.delete(client));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fake SSH server has no TCP port');
  return {
    port: address.port,
    files,
    modes,
    close: async () => {
      for (const client of clients) client.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
