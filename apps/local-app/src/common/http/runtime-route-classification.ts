interface FrameworkError {
  code?: string;
}

interface FrameworkRequest {
  raw: { url?: string };
}

interface FrameworkReply {
  code(statusCode: number): FrameworkReply;
  send(payload?: unknown): unknown;
}

export function normalizeFastifyFrameworkError(
  error: FrameworkError,
  request: FrameworkRequest,
  reply: FrameworkReply,
): void {
  if (error.code === 'FST_ERR_BAD_URL' && isUiAssetNamespace(request.raw.url ?? '')) {
    reply.code(404).send();
    return;
  }

  reply.send(error);
}

export function selectUiAsset(pathname: string): string | null | undefined {
  if (pathname === '/favicon.svg') {
    return 'favicon.svg';
  }

  if (isFaviconNamespace(pathname)) {
    return null;
  }

  if (!isUiAssetNamespace(pathname)) {
    return undefined;
  }

  const match = /^\/assets\/([^/]*)$/.exec(pathname);
  if (!match) {
    return null;
  }

  try {
    const filename = decodeURIComponent(match[1]);
    if (
      !filename ||
      filename === '.' ||
      filename === '..' ||
      filename.startsWith('.') ||
      filename.includes('/') ||
      filename.includes('\\') ||
      filename.includes('\0')
    ) {
      return null;
    }
  } catch {
    return null;
  }

  return `assets/${match[1]}`;
}

function isUiAssetNamespace(rawUrl: string): boolean {
  const pathname = rawUrl.split('?')[0];
  return (
    pathname === '/assets' ||
    pathname.startsWith('/assets/') ||
    pathname.startsWith('/assets%') ||
    pathname.startsWith('/assets\\') ||
    isFaviconNamespace(pathname)
  );
}

function isFaviconNamespace(pathname: string): boolean {
  return (
    pathname.startsWith('/favicon.svg/') ||
    pathname.startsWith('/favicon.svg%') ||
    pathname.startsWith('/favicon.svg\\')
  );
}
