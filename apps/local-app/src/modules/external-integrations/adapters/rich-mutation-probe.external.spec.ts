/**
 * Live vendor probe for rich description and owned-comment mutation contracts.
 *
 * Runs only in the opt-in external lane (`pnpm --filter local-app test:external`)
 * and only when RICH_MUTATION_PROBE=1, because it creates, edits, and deletes
 * throwaway content in the configured ClickUp and Jira test environments.
 * Credentials are decrypted in-process from the local encrypted connection
 * store and never reach logs, assertions output, or the evidence file.
 *
 * The evidence file (reports/rich-mutation-probe.json) is sanitized: it holds
 * verified behavior facts and the two capability decisions, never tokens,
 * emails, account IDs, or vendor resource IDs.
 */
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { IntegrationCredentialCipher } from '../../storage/local/integration-credential-cipher';
import type { IntegrationCredentials } from '../../storage/models/domain.models';
import { SafeVendorHttpClient, SafeVendorHttpError } from '../transport/safe-vendor-http-client';
import { isRecord } from './vendor-shared';

const PROBE_ENV_FLAG = 'RICH_MUTATION_PROBE';
const CLICKUP_ORIGIN = 'https://api.clickup.com';
const PROBE_LINK_HREF = 'https://example.com/devchain-probe';
const PROBE_TASK_NAME = 'devchain rich-edit probe (throwaway)';
const CLICKUP_COMMENT_PAGE_REPLAY_BOUND = 3;
const CLICKUP_SPACE_DISCOVERY_BOUND = 10;
const CLICKUP_FOLDER_DISCOVERY_BOUND = 10;
const CAPTURED_PAYLOAD_MAX_LENGTH = 4_000;

const CLICKUP_MARKDOWN_DESCRIPTION = [
  '# DevChain probe heading',
  '',
  'Paragraph with **bold text**, *italic text*, and `inline code`.',
  '',
  '- bullet alpha',
  '- bullet beta',
  '',
  '[probe link](https://example.com/devchain-probe)',
  '',
  '> quoted probe line',
].join('\n');

// The HTML rendering of CLICKUP_MARKDOWN_DESCRIPTION; writing it through the
// HTML description field must read back as the same semantic structure.
const CLICKUP_HTML_DESCRIPTION =
  '<h1>DevChain probe heading</h1>' +
  '<p>Paragraph with <strong>bold text</strong>, <em>italic text</em>, and ' +
  '<code>inline code</code>.</p>' +
  '<ul><li>bullet alpha</li><li>bullet beta</li></ul>' +
  '<p><a href="https://example.com/devchain-probe">probe link</a></p>' +
  '<blockquote>quoted probe line</blockquote>';

type DeltaOp = Record<string, unknown>;

const CLICKUP_DELTA_BOLD: DeltaOp[] = [
  { text: 'probe rich ' },
  { text: 'bold text', attributes: { bold: true } },
  { text: ' plus ' },
  { text: 'inline code', attributes: { code: true } },
];
const CLICKUP_DELTA_BOLD_UPDATED: DeltaOp[] = [
  { text: 'probe rich updated ' },
  { text: 'bold text two', attributes: { bold: true } },
];
const CLICKUP_DELTA_ITALIC: DeltaOp[] = [
  { text: 'probe plain-update target ' },
  { text: 'italic text', attributes: { italic: true } },
];
const CLICKUP_DELTA_LINK: DeltaOp[] = [
  { text: 'probe anchor ' },
  { text: 'probe link', attributes: { link: PROBE_LINK_HREF } },
];
const CLICKUP_PLAIN_UPDATE_TEXT = 'plain replacement text';

type AdfNode = Record<string, unknown>;

function adfText(text: string, marks?: Array<Record<string, unknown>>): AdfNode {
  return marks ? { type: 'text', text, marks } : { type: 'text', text };
}

function adfStrong(text: string): AdfNode {
  return adfText(text, [{ type: 'strong' }]);
}

function adfEm(text: string): AdfNode {
  return adfText(text, [{ type: 'em' }]);
}

function adfCode(text: string): AdfNode {
  return adfText(text, [{ type: 'code' }]);
}

function adfLink(text: string, href: string): AdfNode {
  return adfText(text, [{ type: 'link', attrs: { href } }]);
}

function adfParagraph(content: AdfNode[]): AdfNode {
  return { type: 'paragraph', content };
}

const JIRA_ADF_DESCRIPTION: AdfNode = {
  type: 'doc',
  version: 1,
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [adfText('DevChain probe heading')] },
    adfParagraph([
      adfText('Paragraph with '),
      adfStrong('bold text'),
      adfText(', '),
      adfEm('italic text'),
      adfText(', and '),
      adfCode('inline code'),
    ]),
    {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [adfParagraph([adfText('bullet alpha')])] },
        { type: 'listItem', content: [adfParagraph([adfText('bullet beta')])] },
      ],
    },
    adfParagraph([adfLink('probe link', PROBE_LINK_HREF)]),
    { type: 'blockquote', content: [adfParagraph([adfText('quoted probe line')])] },
  ],
};

const JIRA_ADF_DESCRIPTION_UPDATED: AdfNode = {
  type: 'doc',
  version: 1,
  content: [...JIRA_ADF_DESCRIPTION.content, adfParagraph([adfText('updated probe paragraph')])],
};

const JIRA_ADF_COMMENT: AdfNode = {
  type: 'doc',
  version: 1,
  content: [
    adfParagraph([adfText('probe comment '), adfStrong('rich bold'), { type: 'hardBreak' }]),
    adfParagraph([adfLink('probe link', PROBE_LINK_HREF)]),
  ],
};

const JIRA_ADF_COMMENT_UPDATED: AdfNode = {
  type: 'doc',
  version: 1,
  content: [
    adfParagraph([adfText('probe comment updated '), adfEm('rich italic')]),
    adfParagraph([adfLink('probe link', PROBE_LINK_HREF)]),
  ],
};

interface ResponseShape {
  op: string;
  status: number;
  contentType: string | null;
  contentLength: string | null;
}

interface CallResult<T = unknown> {
  ok: boolean;
  payload?: T;
  reason?: string;
  upstreamStatus?: number;
}

interface ProviderDeletionEvidence {
  commentDeleteStatus: number | null;
  commentDeleteReadBackGone: boolean;
  containerCleanupStatus: number | null;
  containerResidual: 'gone' | 'trash' | 'present' | 'unknown';
}

interface Evidence {
  probe: string;
  executedAt: string;
  probeEnabled: boolean;
  providers: {
    clickup: {
      available: boolean;
      unavailableReason?: string;
      listDiscoveryPath: string | null;
      description: {
        markdownSemanticEquality: boolean;
        rewriteIdempotent: boolean;
        htmlWriteBackAccepted: boolean;
        htmlWriteBackSemanticEquality: boolean;
        readFields: string[];
        markdownAfterCreate: string | null;
        markdownAfterRewrite: string | null;
        htmlAfterCreate: string | null;
        htmlAfterRewrite: string | null;
        htmlAfterWriteBack: string | null;
      };
      comments: {
        createEchoFields: string[];
        readFields: string[];
        createPreservesRich: boolean;
        createReturnedDelta: unknown;
        richUpdateAccepted: boolean;
        richUpdatePreserved: boolean;
        afterRichUpdateDelta: unknown;
        plainUpdateAccepted: boolean;
        plainUpdatePreservesFormatting: boolean;
        afterPlainUpdateDelta: unknown;
        afterPlainUpdateText: string | null;
        exactCommentReadAvailable: boolean;
        exactCommentReadStatus: number | null;
        pageReplayVerified: boolean;
        pageReplayPagesUsed: number;
        ownershipSignal: boolean;
      };
      deletion: ProviderDeletionEvidence;
    };
    jira: {
      available: boolean;
      unavailableReason?: string;
      description: {
        createRoundTripEqual: boolean;
        updateRoundTripEqual: boolean;
        updateStatus: number | null;
      };
      comments: {
        createEchoFields: string[];
        exactReadRoundTripEqual: boolean;
        updateRoundTripEqual: boolean;
        updateStatus: number | null;
        ownershipSignal: boolean;
      };
      deletion: ProviderDeletionEvidence;
    };
  };
  decisions: {
    RICH_EDIT_GO: boolean | null;
    OWNED_DELETE_GO: boolean | null;
  };
  responseShapes: ResponseShape[];
}

function emptyDeletionEvidence(): ProviderDeletionEvidence {
  return {
    commentDeleteStatus: null,
    commentDeleteReadBackGone: false,
    containerCleanupStatus: null,
    containerResidual: 'unknown',
  };
}

function emptyEvidence(): Evidence {
  return {
    probe: 'rich-mutation-contracts',
    executedAt: new Date().toISOString(),
    probeEnabled: process.env[PROBE_ENV_FLAG] === '1',
    providers: {
      clickup: {
        available: false,
        listDiscoveryPath: null,
        description: {
          markdownSemanticEquality: false,
          rewriteIdempotent: false,
          htmlWriteBackAccepted: false,
          htmlWriteBackSemanticEquality: false,
          readFields: [],
          markdownAfterCreate: null,
          markdownAfterRewrite: null,
          htmlAfterCreate: null,
          htmlAfterRewrite: null,
          htmlAfterWriteBack: null,
        },
        comments: {
          createEchoFields: [],
          readFields: [],
          createPreservesRich: false,
          createReturnedDelta: null,
          richUpdateAccepted: false,
          richUpdatePreserved: false,
          afterRichUpdateDelta: null,
          plainUpdateAccepted: false,
          plainUpdatePreservesFormatting: false,
          afterPlainUpdateDelta: null,
          afterPlainUpdateText: null,
          exactCommentReadAvailable: false,
          exactCommentReadStatus: null,
          pageReplayVerified: false,
          pageReplayPagesUsed: 0,
          ownershipSignal: false,
        },
        deletion: emptyDeletionEvidence(),
      },
      jira: {
        available: false,
        description: {
          createRoundTripEqual: false,
          updateRoundTripEqual: false,
          updateStatus: null,
        },
        comments: {
          createEchoFields: [],
          exactReadRoundTripEqual: false,
          updateRoundTripEqual: false,
          updateStatus: null,
          ownershipSignal: false,
        },
        deletion: emptyDeletionEvidence(),
      },
    },
    decisions: { RICH_EDIT_GO: null, OWNED_DELETE_GO: null },
    responseShapes: [],
  };
}

const evidence = emptyEvidence();
const secrets: string[] = [];
const responseShapes: ResponseShape[] = [];
let currentOp = 'setup';

const probeEnabled = process.env[PROBE_ENV_FLAG] === '1';
const recordingFetch: typeof fetch = async (input, init) => {
  const response = await globalThis.fetch(input as Parameters<typeof globalThis.fetch>[0], init);
  responseShapes.push({
    op: currentOp,
    status: response.status,
    contentType: response.headers.get('content-type'),
    contentLength: response.headers.get('content-length'),
  });
  return response;
};

const http = new SafeVendorHttpClient({ fetchImpl: recordingFetch });

function loadStoredCredentials(provider: 'clickup' | 'jira'): IntegrationCredentials | null {
  const dbPath = process.env.RICH_MUTATION_PROBE_DB ?? join(homedir(), '.devchain', 'devchain.db');
  if (!existsSync(dbPath)) {
    return null;
  }
  const db = new Database(dbPath);
  try {
    const row = db
      .prepare('SELECT credential_ciphertext FROM integration_connections WHERE provider = ?')
      .get(provider) as { credential_ciphertext?: string } | undefined;
    if (!row?.credential_ciphertext) {
      return null;
    }
    return new IntegrationCredentialCipher().decrypt(row.credential_ciphertext);
  } finally {
    db.close();
  }
}

async function callJson(request: {
  op: string;
  url: string;
  allowedOrigins: string[];
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: string;
  headers: Record<string, string>;
}): Promise<CallResult> {
  currentOp = request.op;
  try {
    const payload = await http.requestJson({
      url: request.url,
      allowedOrigins: request.allowedOrigins,
      ...(request.method ? { method: request.method } : {}),
      ...(request.body !== undefined ? { body: request.body } : {}),
      headers: request.headers,
    });
    return { ok: true, payload };
  } catch (error) {
    if (error instanceof SafeVendorHttpError) {
      return { ok: false, reason: error.reason, upstreamStatus: error.upstreamStatus };
    }
    return { ok: false, reason: 'unexpected_error' };
  } finally {
    currentOp = 'setup';
  }
}

async function callNoContent(request: {
  op: string;
  url: string;
  allowedOrigins: string[];
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: string;
  headers: Record<string, string>;
}): Promise<CallResult> {
  currentOp = request.op;
  try {
    await http.requestNoContent({
      url: request.url,
      allowedOrigins: request.allowedOrigins,
      ...(request.method ? { method: request.method } : {}),
      ...(request.body !== undefined ? { body: request.body } : {}),
      headers: request.headers,
    });
    return { ok: true };
  } catch (error) {
    if (error instanceof SafeVendorHttpError) {
      return { ok: false, reason: error.reason, upstreamStatus: error.upstreamStatus };
    }
    return { ok: false, reason: 'unexpected_error' };
  } finally {
    currentOp = 'setup';
  }
}

/**
 * Deletes through the safe client even when the vendor's delete response body
 * shape is unknown or non-JSON (for example a 204 that still carries a JSON
 * content type, which the strict JSON reader rejects after the wire request
 * already succeeded). Recorded wire shapes are the authoritative outcome;
 * deletion is idempotent, so a replayed attempt is safe.
 */
async function probeDelete(request: {
  op: string;
  url: string;
  allowedOrigins: string[];
  headers: Record<string, string>;
}): Promise<{ status: number | null; ok: boolean }> {
  const lastShape = (): ResponseShape | undefined => {
    const shapes = responseShapes.filter((shape) => shape.op === request.op);
    return shapes[shapes.length - 1];
  };
  const jsonAttempt = await callJson({ ...request, method: 'DELETE' });
  if (jsonAttempt.ok) {
    return { status: lastShape()?.status ?? 200, ok: true };
  }
  if (jsonAttempt.reason === 'http_error') {
    return { status: jsonAttempt.upstreamStatus ?? null, ok: false };
  }
  const shapeAfterFirst = lastShape();
  if (shapeAfterFirst && shapeAfterFirst.status < 400) {
    return { status: shapeAfterFirst.status, ok: true };
  }
  const noContentAttempt = await callNoContent({ ...request, method: 'DELETE' });
  if (noContentAttempt.ok) {
    return { status: 204, ok: true };
  }
  if (noContentAttempt.reason === 'http_error') {
    return { status: noContentAttempt.upstreamStatus ?? null, ok: false };
  }
  const shapeAfterSecond = lastShape();
  return {
    status: shapeAfterSecond?.status ?? null,
    ok: shapeAfterSecond ? shapeAfterSecond.status < 400 : false,
  };
}

function canonicalMarkdownLine(line: string): string {
  let out = line.replace(/\s+/g, ' ').trim();
  if (!out) {
    return out;
  }
  // Equivalent markdown spellings ClickUp re-emits differently: underscore vs
  // asterisk emphasis, and `-`/`*`/`+` bullet markers with padded spacing.
  out = out.replace(/(?<![\w*])_([^_]+)_(?!\w)/g, '*$1*');
  out = out.replace(/^([-*+])\s+/, '- ');
  return out;
}

function canonicalMarkdownLines(value: unknown): string[] | null {
  if (typeof value !== 'string') {
    return null;
  }
  return value
    .split(/\r?\n/)
    .map(canonicalMarkdownLine)
    .filter((line) => line.length > 0);
}

const CANONICAL_PROBE_MARKDOWN = canonicalMarkdownLines(CLICKUP_MARKDOWN_DESCRIPTION)!;

function markdownEqual(value: unknown): boolean {
  const lines = canonicalMarkdownLines(value);
  return lines !== null && JSON.stringify(lines) === JSON.stringify(CANONICAL_PROBE_MARKDOWN);
}

function canonicalAdf(node: unknown): Record<string, unknown> | null {
  if (!isRecord(node) || typeof node.type !== 'string') {
    return null;
  }
  const out: Record<string, unknown> = { type: node.type };
  if (node.type === 'text') {
    out.text = typeof node.text === 'string' ? node.text : null;
    if (Array.isArray(node.marks)) {
      const marks = node.marks
        .filter(isRecord)
        .map((mark) => {
          const type = typeof mark.type === 'string' ? mark.type : 'unknown';
          const attrs =
            isRecord(mark.attrs) && typeof mark.attrs.href === 'string'
              ? { href: mark.attrs.href }
              : undefined;
          return attrs ? `${type}:${attrs.href}` : type;
        })
        .sort();
      if (marks.length > 0) {
        out.marks = marks;
      }
    }
  }
  if (node.type === 'heading' && isRecord(node.attrs) && typeof node.attrs.level === 'number') {
    out.level = node.attrs.level;
  }
  if (Array.isArray(node.content)) {
    const children = node.content
      .map((child) => canonicalAdf(child))
      .filter((child): child is Record<string, unknown> => child !== null);
    if (children.length > 0) {
      out.content = children;
    }
  }
  return out;
}

function adfEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalAdf(left)) === JSON.stringify(canonicalAdf(right));
}

function canonicalDelta(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return null;
  }
  return value
    .map((op) => {
      if (!isRecord(op)) {
        return { invalid: true };
      }
      const out: Record<string, unknown> = {};
      if (typeof op.text === 'string') {
        // ClickUp normalizes whitespace at op boundaries; formatting, not
        // spacing, is the contract under probe.
        const text = op.text.trim();
        if (!text) {
          return null;
        }
        out.text = text;
      } else if (typeof op.type === 'string') {
        out.type = op.type;
      }
      if (isRecord(op.attributes)) {
        out.attributes = Object.keys(op.attributes)
          .sort()
          .map((key) => [key, JSON.stringify(op.attributes[key])]);
      }
      return out;
    })
    .filter((op) => op !== null);
}

function deltaEqual(left: unknown, right: unknown): boolean {
  const canonicalLeft = canonicalDelta(left);
  const canonicalRight = canonicalDelta(right);
  return (
    canonicalLeft !== null &&
    canonicalRight !== null &&
    JSON.stringify(canonicalLeft) === JSON.stringify(canonicalRight)
  );
}

function clickupHeaders(token: string, withBody: boolean): Record<string, string> {
  return {
    accept: 'application/json',
    authorization: token,
    ...(withBody ? { 'content-type': 'application/json' } : {}),
  };
}

function jiraHeaders(authorization: string, withBody: boolean): Record<string, string> {
  return {
    accept: 'application/json',
    authorization,
    ...(withBody ? { 'content-type': 'application/json' } : {}),
  };
}

function objectKeys(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value).sort() : [];
}

/** Probe payloads are self-authored throwaway content, so recording their
 * vendor round-trip output is safe; the length cap bounds vendor extras. */
function capture(value: unknown): unknown {
  if (typeof value === 'string' && value.length > CAPTURED_PAYLOAD_MAX_LENGTH) {
    return `${value.slice(0, CAPTURED_PAYLOAD_MAX_LENGTH)}…[truncated]`;
  }
  const serialized = JSON.stringify(value);
  if (serialized !== undefined && serialized.length > CAPTURED_PAYLOAD_MAX_LENGTH) {
    return `${serialized.slice(0, CAPTURED_PAYLOAD_MAX_LENGTH)}…[truncated]`;
  }
  return value;
}

interface ClickUpCommentRecord {
  id: string;
  date: number;
  userId: string | null;
  commentText: string | null;
  delta: unknown;
}

function toCommentRecord(value: unknown): ClickUpCommentRecord | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = typeof value.id === 'string' || typeof value.id === 'number' ? String(value.id) : null;
  if (!id) {
    return null;
  }
  return {
    id,
    date: typeof value.date === 'number' ? value.date : Number.NaN,
    userId:
      isRecord(value.user) &&
      (typeof value.user.id === 'string' || typeof value.user.id === 'number')
        ? String(value.user.id)
        : null,
    commentText: typeof value.comment_text === 'string' ? value.comment_text : null,
    delta: value.comment,
  };
}

const describeFn = probeEnabled ? describe : describe.skip;
describeFn('rich mutation contract probe', () => {
  jest.setTimeout(120_000);

  let clickupToken: string | null = null;
  let jiraSite: { origin: string; authorization: string } | null = null;

  beforeAll(() => {
    const clickupCredentials = loadStoredCredentials('clickup');
    if (clickupCredentials?.provider === 'clickup') {
      clickupToken = clickupCredentials.token;
      secrets.push(clickupCredentials.token);
    }
    const jiraCredentials = loadStoredCredentials('jira');
    if (jiraCredentials?.provider === 'jira') {
      const origin = jiraCredentials.siteUrl.replace(/\/$/, '');
      jiraSite = {
        origin,
        authorization: `Basic ${Buffer.from(`${jiraCredentials.email}:${jiraCredentials.token}`).toString('base64')}`,
      };
      secrets.push(jiraCredentials.token, jiraCredentials.email, jiraCredentials.siteUrl);
    }
    if (!clickupToken) {
      evidence.providers.clickup.unavailableReason = 'connection_not_configured';
    }
    if (!jiraSite) {
      evidence.providers.jira.unavailableReason = 'connection_not_configured';
    }
  });

  describe('clickup', () => {
    const pendingCommentIds = new Set<string>();
    let taskId: string | null = null;
    let currentUserId: string | null = null;
    let commentAnchor: ClickUpCommentRecord | null = null;
    let commentRichUpdate: ClickUpCommentRecord | null = null;
    let commentPlainUpdate: ClickUpCommentRecord | null = null;

    async function request(
      op: string,
      path: string,
      init: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: string } = {},
    ): Promise<CallResult> {
      return callJson({
        op: `clickup.${op}`,
        url: `${CLICKUP_ORIGIN}${path}`,
        allowedOrigins: [CLICKUP_ORIGIN],
        headers: clickupHeaders(clickupToken!, init.body !== undefined),
        ...init,
      });
    }

    beforeAll(async () => {
      if (!clickupToken) {
        return;
      }
      evidence.providers.clickup.available = true;

      const user = await request('getUser', '/api/v2/user');
      if (user.ok && isRecord(user.payload) && isRecord(user.payload.user)) {
        currentUserId =
          typeof user.payload.user.id === 'string' || typeof user.payload.user.id === 'number'
            ? String(user.payload.user.id)
            : null;
        if (typeof user.payload.user.username === 'string') {
          secrets.push(user.payload.user.username);
        }
      }

      let listId: string | null = null;
      const teams = await request('getTeams', '/api/v2/team');
      const firstTeamId =
        teams.ok && isRecord(teams.payload) && Array.isArray(teams.payload.teams)
          ? (teams.payload.teams.find(isRecord)?.id as string | undefined)
          : undefined;
      if (firstTeamId) {
        const spaces = await request(
          'getSpaces',
          `/api/v2/team/${encodeURIComponent(firstTeamId)}/space?archived=false`,
        );
        const spaceIds =
          spaces.ok && isRecord(spaces.payload) && Array.isArray(spaces.payload.spaces)
            ? (spaces.payload.spaces as unknown[])
                .filter(isRecord)
                .map((space) => space.id)
                .filter((id): id is string => typeof id === 'string')
            : [];
        // Early spaces can be empty, so keep looking until a list appears.
        for (const spaceId of spaceIds.slice(0, CLICKUP_SPACE_DISCOVERY_BOUND)) {
          const folderless = await request(
            'getFolderlessLists',
            `/api/v2/space/${encodeURIComponent(spaceId)}/list?archived=false`,
          );
          const folderlessList =
            folderless.ok && isRecord(folderless.payload) && Array.isArray(folderless.payload.lists)
              ? ((folderless.payload.lists as unknown[]).find(isRecord)?.id as string | undefined)
              : undefined;
          if (folderlessList) {
            listId = folderlessList;
            evidence.providers.clickup.listDiscoveryPath = 'team>space>folderless-list';
            break;
          }
          const folders = await request(
            'getFolders',
            `/api/v2/space/${encodeURIComponent(spaceId)}/folder?archived=false`,
          );
          const folderIds =
            folders.ok && isRecord(folders.payload) && Array.isArray(folders.payload.folders)
              ? (folders.payload.folders as unknown[])
                  .filter(isRecord)
                  .map((folder) => folder.id)
                  .filter((id): id is string => typeof id === 'string')
              : [];
          let foundInFolder = false;
          for (const folderId of folderIds.slice(0, CLICKUP_FOLDER_DISCOVERY_BOUND)) {
            const lists = await request(
              'getFolderLists',
              `/api/v2/folder/${encodeURIComponent(folderId)}/list?archived=false`,
            );
            const folderList =
              lists.ok && isRecord(lists.payload) && Array.isArray(lists.payload.lists)
                ? ((lists.payload.lists as unknown[]).find(isRecord)?.id as string | undefined)
                : undefined;
            if (folderList) {
              listId = folderList;
              evidence.providers.clickup.listDiscoveryPath = 'team>space>folder>list';
              foundInFolder = true;
              break;
            }
          }
          if (foundInFolder) {
            break;
          }
        }
      }

      if (!listId) {
        evidence.providers.clickup.unavailableReason = 'no_accessible_list';
        return;
      }

      const created = await request(
        'createTask',
        `/api/v2/list/${encodeURIComponent(listId)}/task`,
        {
          method: 'POST',
          body: JSON.stringify({
            name: PROBE_TASK_NAME,
            markdown_description: CLICKUP_MARKDOWN_DESCRIPTION,
          }),
        },
      );
      const createdId =
        created.ok && isRecord(created.payload) && typeof created.payload.id === 'string'
          ? created.payload.id
          : null;
      if (!createdId) {
        evidence.providers.clickup.unavailableReason = 'task_create_failed';
        return;
      }
      taskId = createdId;

      // Oldest first so page replay has a strictly older comment to find.
      const anchor = await request(
        'createCommentAnchor',
        `/api/v2/task/${encodeURIComponent(taskId)}/comment`,
        {
          method: 'POST',
          body: JSON.stringify({ comment: CLICKUP_DELTA_LINK, notify_all: false }),
        },
      );
      const rich = await request(
        'createCommentRichUpdate',
        `/api/v2/task/${encodeURIComponent(taskId)}/comment`,
        {
          method: 'POST',
          body: JSON.stringify({ comment: CLICKUP_DELTA_BOLD, notify_all: false }),
        },
      );
      const plain = await request(
        'createCommentPlainUpdate',
        `/api/v2/task/${encodeURIComponent(taskId)}/comment`,
        {
          method: 'POST',
          body: JSON.stringify({ comment: CLICKUP_DELTA_ITALIC, notify_all: false }),
        },
      );
      if (anchor.ok && isRecord(anchor.payload)) {
        commentAnchor = toCommentRecord(anchor.payload);
        evidence.providers.clickup.comments.createEchoFields = objectKeys(anchor.payload);
      }
      if (rich.ok && isRecord(rich.payload)) {
        commentRichUpdate = toCommentRecord(rich.payload);
      }
      if (plain.ok && isRecord(plain.payload)) {
        commentPlainUpdate = toCommentRecord(plain.payload);
      }
      for (const record of [commentAnchor, commentRichUpdate, commentPlainUpdate]) {
        if (record) {
          pendingCommentIds.add(record.id);
        }
      }
    });

    it('round-trips a markdown description through canonical semantic equality and idempotency', async () => {
      if (!taskId) {
        throw new Error('ClickUp probe task was not created');
      }
      const taskPath = () =>
        `/api/v2/task/${encodeURIComponent(taskId)}?include_markdown_description=true`;
      const read = await request('getTaskAfterCreate', taskPath());
      expect(read.ok).toBe(true);
      const payload = read.payload as Record<string, unknown> | undefined;
      evidence.providers.clickup.description.readFields = [
        'description',
        'text_content',
        'markdown_description',
      ].filter((key) => typeof payload?.[key] === 'string' && payload[key]);

      const markdownAfterCreate =
        typeof payload?.markdown_description === 'string' ? payload.markdown_description : null;
      evidence.providers.clickup.description.markdownAfterCreate = capture(markdownAfterCreate);
      evidence.providers.clickup.description.htmlAfterCreate = capture({
        description: typeof payload?.description === 'string' ? payload.description : null,
        text_content: typeof payload?.text_content === 'string' ? payload.text_content : null,
      });
      evidence.providers.clickup.description.markdownSemanticEquality =
        markdownEqual(markdownAfterCreate);

      const rewrite = await request(
        'rewriteTaskMarkdown',
        `/api/v2/task/${encodeURIComponent(taskId)}`,
        {
          method: 'PUT',
          body: JSON.stringify({ markdown_description: CLICKUP_MARKDOWN_DESCRIPTION }),
        },
      );
      expect(rewrite.ok).toBe(true);
      const readTwo = await request('getTaskAfterRewrite', taskPath());
      const payloadTwo = readTwo.payload as Record<string, unknown> | undefined;
      const markdownAfterRewrite =
        typeof payloadTwo?.markdown_description === 'string'
          ? payloadTwo.markdown_description
          : null;
      evidence.providers.clickup.description.markdownAfterRewrite = capture(markdownAfterRewrite);
      evidence.providers.clickup.description.htmlAfterRewrite = capture({
        description: typeof payloadTwo?.description === 'string' ? payloadTwo.description : null,
        text_content: typeof payloadTwo?.text_content === 'string' ? payloadTwo.text_content : null,
      });
      evidence.providers.clickup.description.rewriteIdempotent =
        markdownAfterCreate !== null &&
        markdownAfterRewrite !== null &&
        markdownEqual(markdownAfterRewrite);

      const writeBack = await request(
        'writeBackTaskHtml',
        `/api/v2/task/${encodeURIComponent(taskId)}`,
        {
          method: 'PUT',
          body: JSON.stringify({ description: CLICKUP_HTML_DESCRIPTION }),
        },
      );
      evidence.providers.clickup.description.htmlWriteBackAccepted = writeBack.ok;
      if (writeBack.ok) {
        const readThree = await request('getTaskAfterWriteBack', taskPath());
        const payloadThree = readThree.payload as Record<string, unknown> | undefined;
        const writtenBackHtml =
          typeof payloadThree?.description === 'string' ? payloadThree.description : null;
        evidence.providers.clickup.description.htmlAfterWriteBack = capture({
          description: writtenBackHtml,
          text_content:
            typeof payloadThree?.text_content === 'string' ? payloadThree.text_content : null,
          markdown_description:
            typeof payloadThree?.markdown_description === 'string'
              ? payloadThree.markdown_description
              : null,
        });
        // An HTML description write reads back the same HTML verbatim; the
        // markdown_description field echoes the raw HTML instead of converting.
        evidence.providers.clickup.description.htmlWriteBackSemanticEquality =
          writtenBackHtml === CLICKUP_HTML_DESCRIPTION;
      }
    });

    it('preserves rich comment formatting on create, read, update, and bounded page replay', async () => {
      if (!taskId || !commentAnchor || !commentRichUpdate || !commentPlainUpdate) {
        throw new Error('ClickUp probe comments were not created');
      }
      const page = await request(
        'getTaskComments',
        `/api/v2/task/${encodeURIComponent(taskId)}/comment`,
      );
      expect(page.ok).toBe(true);
      const comments = (page.payload as Record<string, unknown> | undefined)?.comments ?? [];
      expect(Array.isArray(comments)).toBe(true);
      const records = (comments as unknown[])
        .map(toCommentRecord)
        .filter((record): record is ClickUpCommentRecord => record !== null);
      evidence.providers.clickup.comments.readFields = records.length
        ? objectKeys((comments as unknown[])[0])
        : [];

      const richRead = records.find((record) => record.id === commentRichUpdate.id) ?? null;
      evidence.providers.clickup.comments.createReturnedDelta = capture(richRead?.delta ?? null);
      evidence.providers.clickup.comments.createPreservesRich =
        richRead !== null && deltaEqual(CLICKUP_DELTA_BOLD, richRead.delta);

      const anchorRead = records.find((record) => record.id === commentAnchor.id) ?? null;
      evidence.providers.clickup.comments.ownershipSignal =
        anchorRead?.userId !== null &&
        anchorRead?.userId === currentUserId &&
        richRead?.userId === currentUserId;

      const richUpdate = await request(
        'updateCommentRich',
        `/api/v2/comment/${encodeURIComponent(commentRichUpdate.id)}`,
        {
          method: 'PUT',
          body: JSON.stringify({ comment: CLICKUP_DELTA_BOLD_UPDATED }),
        },
      );
      evidence.providers.clickup.comments.richUpdateAccepted = richUpdate.ok;
      if (richUpdate.ok) {
        const pageTwo = await request(
          'getTaskCommentsAfterRichUpdate',
          `/api/v2/task/${encodeURIComponent(taskId)}/comment`,
        );
        const updatedRecords = (
          ((pageTwo.payload as Record<string, unknown> | undefined)?.comments ?? []) as unknown[]
        )
          .map(toCommentRecord)
          .filter((record): record is ClickUpCommentRecord => record !== null);
        const updated = updatedRecords.find((record) => record.id === commentRichUpdate.id) ?? null;
        evidence.providers.clickup.comments.afterRichUpdateDelta = capture(updated?.delta ?? null);
        evidence.providers.clickup.comments.richUpdatePreserved =
          updated !== null && deltaEqual(CLICKUP_DELTA_BOLD_UPDATED, updated.delta);
      }

      const plainUpdate = await request(
        'updateCommentPlain',
        `/api/v2/comment/${encodeURIComponent(commentPlainUpdate.id)}`,
        {
          method: 'PUT',
          body: JSON.stringify({ comment_text: CLICKUP_PLAIN_UPDATE_TEXT }),
        },
      );
      evidence.providers.clickup.comments.plainUpdateAccepted = plainUpdate.ok;
      if (plainUpdate.ok) {
        const pageThree = await request(
          'getTaskCommentsAfterPlainUpdate',
          `/api/v2/task/${encodeURIComponent(taskId)}/comment`,
        );
        const updatedRecords = (
          ((pageThree.payload as Record<string, unknown> | undefined)?.comments ?? []) as unknown[]
        )
          .map(toCommentRecord)
          .filter((record): record is ClickUpCommentRecord => record !== null);
        const updated =
          updatedRecords.find((record) => record.id === commentPlainUpdate.id) ?? null;
        evidence.providers.clickup.comments.afterPlainUpdateDelta = capture(updated?.delta ?? null);
        evidence.providers.clickup.comments.afterPlainUpdateText = updated?.commentText ?? null;
        const formattingSurvived =
          updated !== null &&
          (deltaEqual(CLICKUP_DELTA_ITALIC, updated.delta) ||
            (Array.isArray(updated.delta) &&
              (updated.delta as DeltaOp[]).length > 0 &&
              JSON.stringify(canonicalDelta(updated.delta)).includes('"italic"')));
        evidence.providers.clickup.comments.plainUpdatePreservesFormatting = formattingSurvived;
      }

      const exactRead = await request(
        'getCommentById',
        `/api/v2/comment/${encodeURIComponent(commentRichUpdate.id)}`,
      );
      evidence.providers.clickup.comments.exactCommentReadStatus = exactRead.ok
        ? 200
        : (exactRead.upstreamStatus ??
          responseShapes.filter((shape) => shape.op === 'clickup.getCommentById').pop()?.status ??
          null);
      evidence.providers.clickup.comments.exactCommentReadAvailable = exactRead.ok;

      if (commentRichUpdate.date === commentAnchor.date) {
        // Same-millisecond creation would make the replay cursor ambiguous.
        await new Promise((resolve) => setTimeout(resolve, 1_100));
      }
      let replayVerified = false;
      let pagesUsed = 0;
      for (
        let attempt = 0;
        attempt < CLICKUP_COMMENT_PAGE_REPLAY_BOUND && !replayVerified;
        attempt += 1
      ) {
        pagesUsed = attempt + 1;
        const replay = await request(
          'replayCommentPage',
          `/api/v2/task/${encodeURIComponent(taskId)}/comment?start=${encodeURIComponent(
            String(commentRichUpdate.date),
          )}&start_id=${encodeURIComponent(commentRichUpdate.id)}`,
        );
        if (!replay.ok) {
          break;
        }
        const replayRecords = (
          ((replay.payload as Record<string, unknown> | undefined)?.comments ?? []) as unknown[]
        )
          .map(toCommentRecord)
          .filter((record): record is ClickUpCommentRecord => record !== null);
        const replayIds = new Set(replayRecords.map((record) => record.id));
        // Creation-time dates keep the ordering expectation independent of
        // any date changes the update probes may have caused.
        const olderIds = new Set(
          [commentAnchor, commentPlainUpdate]
            .filter((record) => record.date < commentRichUpdate.date)
            .map((record) => record.id),
        );
        replayVerified =
          olderIds.size > 0 &&
          [...olderIds].every((id) => replayIds.has(id)) &&
          !replayIds.has(commentRichUpdate.id);
        if (replayIds.size === 0) {
          break;
        }
      }
      evidence.providers.clickup.comments.pageReplayVerified = replayVerified;
      evidence.providers.clickup.comments.pageReplayPagesUsed = pagesUsed;
    });

    afterAll(async () => {
      if (!taskId) {
        return;
      }
      for (const commentId of pendingCommentIds) {
        const deletion = await probeDelete({
          op: 'clickup.deleteComment',
          url: `${CLICKUP_ORIGIN}/api/v2/comment/${encodeURIComponent(commentId)}`,
          allowedOrigins: [CLICKUP_ORIGIN],
          headers: clickupHeaders(clickupToken!, false),
        });
        if (evidence.providers.clickup.deletion.commentDeleteStatus === null && deletion.ok) {
          evidence.providers.clickup.deletion.commentDeleteStatus = deletion.status;
        }
      }
      const commentsAfter = await request(
        'getTaskCommentsAfterDelete',
        `/api/v2/task/${encodeURIComponent(taskId)}/comment`,
      );
      if (commentsAfter.ok) {
        const remaining = new Set(
          (
            ((commentsAfter.payload as Record<string, unknown> | undefined)?.comments ??
              []) as unknown[]
          )
            .map(toCommentRecord)
            .filter((record): record is ClickUpCommentRecord => record !== null)
            .map((record) => record.id),
        );
        evidence.providers.clickup.deletion.commentDeleteReadBackGone = [
          ...pendingCommentIds,
        ].every((id) => !remaining.has(id));
      }

      const taskDelete = await probeDelete({
        op: 'clickup.deleteTask',
        url: `${CLICKUP_ORIGIN}/api/v2/task/${encodeURIComponent(taskId)}`,
        allowedOrigins: [CLICKUP_ORIGIN],
        headers: clickupHeaders(clickupToken!, false),
      });
      evidence.providers.clickup.deletion.containerCleanupStatus = taskDelete.status;
      const taskAfter = await request(
        'getTaskAfterDelete',
        `/api/v2/task/${encodeURIComponent(taskId)}`,
      );
      if (!taskAfter.ok && taskAfter.upstreamStatus === 404) {
        evidence.providers.clickup.deletion.containerResidual = 'gone';
      } else if (taskAfter.ok && isRecord(taskAfter.payload)) {
        evidence.providers.clickup.deletion.containerResidual =
          taskAfter.payload.deleted === true || taskAfter.payload.archived === true
            ? 'trash'
            : 'present';
      }
    });
  });

  describe('jira', () => {
    let issueKey: string | null = null;
    let commentId: string | null = null;
    let accountId: string | null = null;

    async function request(
      op: string,
      path: string,
      init: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: string } = {},
    ): Promise<CallResult> {
      return callJson({
        op: `jira.${op}`,
        url: `${jiraSite!.origin}${path}`,
        allowedOrigins: [jiraSite!.origin],
        headers: jiraHeaders(jiraSite!.authorization, init.body !== undefined),
        ...init,
      });
    }

    beforeAll(async () => {
      if (!jiraSite) {
        return;
      }
      evidence.providers.jira.available = true;

      const myself = await request('getMyself', '/rest/api/3/myself');
      if (myself.ok && isRecord(myself.payload) && typeof myself.payload.accountId === 'string') {
        accountId = myself.payload.accountId;
        secrets.push(accountId);
        if (typeof myself.payload.displayName === 'string') {
          secrets.push(myself.payload.displayName);
        }
      }

      const projects = await request('searchProjects', '/rest/api/3/project/search?maxResults=5');
      const firstProject =
        projects.ok && isRecord(projects.payload) && Array.isArray(projects.payload.values)
          ? (projects.payload.values.find(isRecord)?.key as string | undefined)
          : undefined;
      if (!firstProject) {
        evidence.providers.jira.unavailableReason = 'no_accessible_project';
        return;
      }

      const created = await request('createIssue', '/rest/api/3/issue', {
        method: 'POST',
        body: JSON.stringify({
          fields: {
            project: { key: firstProject },
            summary: PROBE_TASK_NAME,
            issuetype: { name: 'Task' },
            description: JIRA_ADF_DESCRIPTION,
          },
        }),
      });
      const key =
        created.ok && isRecord(created.payload) && typeof created.payload.key === 'string'
          ? created.payload.key
          : null;
      if (!key) {
        evidence.providers.jira.unavailableReason = created.ok
          ? 'issue_create_failed'
          : `issue_create_rejected_${created.upstreamStatus ?? 'transport'}`;
        return;
      }
      issueKey = key;

      const comment = await request(
        'createComment',
        `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`,
        {
          method: 'POST',
          body: JSON.stringify({ body: JIRA_ADF_COMMENT }),
        },
      );
      if (comment.ok && isRecord(comment.payload)) {
        evidence.providers.jira.comments.createEchoFields = objectKeys(comment.payload);
        commentId = typeof comment.payload.id === 'string' ? comment.payload.id : null;
      }
    });

    it('round-trips an ADF description through create and update', async () => {
      if (!issueKey) {
        throw new Error('Jira probe issue was not created');
      }
      const read = await request(
        'getIssueDescription',
        `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=description`,
      );
      expect(read.ok).toBe(true);
      const fields = (read.payload as Record<string, unknown> | undefined)?.fields;
      const description = isRecord(fields) ? fields.description : undefined;
      evidence.providers.jira.description.createRoundTripEqual = adfEqual(
        JIRA_ADF_DESCRIPTION,
        description,
      );

      const update = await callNoContent({
        op: 'jira.updateIssueDescription',
        url: `${jiraSite!.origin}/rest/api/3/issue/${encodeURIComponent(issueKey)}`,
        allowedOrigins: [jiraSite!.origin],
        method: 'PUT',
        body: JSON.stringify({ fields: { description: JIRA_ADF_DESCRIPTION_UPDATED } }),
        headers: jiraHeaders(jiraSite!.authorization, true),
      });
      evidence.providers.jira.description.updateStatus = update.ok
        ? 204
        : (update.upstreamStatus ?? null);

      const readUpdated = await request(
        'getIssueDescriptionAfterUpdate',
        `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=description`,
      );
      const fieldsUpdated = (readUpdated.payload as Record<string, unknown> | undefined)?.fields;
      const descriptionUpdated = isRecord(fieldsUpdated) ? fieldsUpdated.description : undefined;
      evidence.providers.jira.description.updateRoundTripEqual = adfEqual(
        JIRA_ADF_DESCRIPTION_UPDATED,
        descriptionUpdated,
      );
    });

    it('round-trips an owned ADF comment through exact read and update', async () => {
      if (!issueKey || !commentId) {
        throw new Error('Jira probe comment was not created');
      }
      const exact = await request(
        'getComment',
        `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(commentId)}`,
      );
      expect(exact.ok).toBe(true);
      const commentPayload = exact.payload as Record<string, unknown> | undefined;
      evidence.providers.jira.comments.exactReadRoundTripEqual =
        commentPayload !== undefined && adfEqual(JIRA_ADF_COMMENT, commentPayload.body);
      const author = isRecord(commentPayload?.author) ? commentPayload?.author : null;
      evidence.providers.jira.comments.ownershipSignal =
        accountId !== null &&
        typeof author?.accountId === 'string' &&
        author.accountId === accountId;

      const update = await request(
        'updateComment',
        `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(commentId)}`,
        {
          method: 'PUT',
          body: JSON.stringify({ body: JIRA_ADF_COMMENT_UPDATED }),
        },
      );
      evidence.providers.jira.comments.updateStatus = update.ok
        ? 200
        : (update.upstreamStatus ?? null);
      if (update.ok && isRecord(update.payload)) {
        evidence.providers.jira.comments.updateRoundTripEqual = adfEqual(
          JIRA_ADF_COMMENT_UPDATED,
          update.payload.body,
        );
      }
    });

    afterAll(async () => {
      if (!jiraSite || !issueKey) {
        return;
      }
      if (commentId) {
        const deletion = await probeDelete({
          op: 'jira.deleteComment',
          url: `${jiraSite.origin}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(commentId)}`,
          allowedOrigins: [jiraSite.origin],
          headers: jiraHeaders(jiraSite.authorization, false),
        });
        evidence.providers.jira.deletion.commentDeleteStatus = deletion.status;
        const commentAfter = await request(
          'getCommentAfterDelete',
          `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(commentId)}`,
        );
        evidence.providers.jira.deletion.commentDeleteReadBackGone =
          !commentAfter.ok && commentAfter.upstreamStatus === 404;
      }

      const issueDelete = await probeDelete({
        op: 'jira.deleteIssue',
        url: `${jiraSite!.origin}/rest/api/3/issue/${encodeURIComponent(issueKey)}`,
        allowedOrigins: [jiraSite!.origin],
        headers: jiraHeaders(jiraSite!.authorization, false),
      });
      evidence.providers.jira.deletion.containerCleanupStatus = issueDelete.status;
      const issueAfter = await request(
        'getIssueAfterDelete',
        `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=summary`,
      );
      evidence.providers.jira.deletion.containerResidual =
        !issueAfter.ok && issueAfter.upstreamStatus === 404 ? 'gone' : 'present';
    });
  });

  it('computes capability decisions and writes sanitized evidence', () => {
    const clickup = evidence.providers.clickup;
    const jira = evidence.providers.jira;
    const bothProbed =
      clickup.available && jira.available && !clickup.unavailableReason && !jira.unavailableReason;

    if (bothProbed) {
      evidence.decisions.RICH_EDIT_GO =
        clickup.description.markdownSemanticEquality &&
        clickup.description.rewriteIdempotent &&
        clickup.comments.createPreservesRich &&
        clickup.comments.richUpdateAccepted &&
        clickup.comments.richUpdatePreserved &&
        jira.description.createRoundTripEqual &&
        jira.description.updateRoundTripEqual &&
        jira.comments.exactReadRoundTripEqual &&
        jira.comments.updateRoundTripEqual;
      evidence.decisions.OWNED_DELETE_GO =
        clickup.comments.ownershipSignal &&
        clickup.deletion.commentDeleteStatus !== null &&
        clickup.deletion.commentDeleteStatus < 400 &&
        clickup.deletion.commentDeleteReadBackGone &&
        jira.comments.ownershipSignal &&
        jira.deletion.commentDeleteStatus !== null &&
        jira.deletion.commentDeleteStatus < 400 &&
        jira.deletion.commentDeleteReadBackGone;
    }

    evidence.responseShapes = responseShapes;
    const reportsDirectory = join(process.cwd(), 'reports');
    mkdirSync(reportsDirectory, { recursive: true });
    const evidencePath = join(reportsDirectory, 'rich-mutation-probe.json');
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

    if (bothProbed) {
      expect(typeof evidence.decisions.RICH_EDIT_GO).toBe('boolean');
      expect(typeof evidence.decisions.OWNED_DELETE_GO).toBe('boolean');
    } else {
      expect(evidence.decisions.RICH_EDIT_GO).toBeNull();
      expect(evidence.decisions.OWNED_DELETE_GO).toBeNull();
    }
  });

  it('leaks no credentials or sensitive vendor payloads into evidence', () => {
    const serialized = JSON.stringify(evidence);
    for (const secret of secrets) {
      if (secret.length >= 8) {
        expect(serialized.includes(secret)).toBe(false);
      }
    }
    expect(responseShapes.every((shape) => typeof shape.status === 'number')).toBe(true);
  });

  afterAll(() => {
    // eslint-disable-next-line no-console -- the probe's single sanitized summary output
    console.log(
      `[rich-mutation-probe] RICH_EDIT_GO=${String(evidence.decisions.RICH_EDIT_GO)} ` +
        `OWNED_DELETE_GO=${String(evidence.decisions.OWNED_DELETE_GO)} ` +
        `clickup.available=${evidence.providers.clickup.available} jira.available=${evidence.providers.jira.available}`,
    );
  });
});
