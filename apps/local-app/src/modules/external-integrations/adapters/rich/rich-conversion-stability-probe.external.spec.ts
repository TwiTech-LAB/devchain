/**
 * Live ClickUp stability probe for the rich conversion model: proves that the
 * markdown emitter's output survives a provider round trip, that the
 * provider's own markdown output re-converts to the same canonical
 * fingerprint, and that a second write makes the provider output stable. Also
 * proves the comment delta emitter round-trips through the verified rich-write
 * contract. Opt-in like the base probe: external lane + RICH_MUTATION_PROBE=1,
 * throwaway task/comments only, credentials never logged.
 */
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { IntegrationCredentialCipher } from '../../../storage/local/integration-credential-cipher';
import type { IntegrationCredentials } from '../../../storage/models/domain.models';
import { SafeVendorHttpClient, SafeVendorHttpError } from '../../transport/safe-vendor-http-client';
import { isRecord } from '../vendor-shared';
import { markdownToRichDocument, richDocumentToMarkdown } from './clickup-markdown-converter';
import {
  clickupCommentDeltaToRichDocument,
  richDocumentToClickUpCommentDelta,
} from './clickup-comment-converter';
import {
  richDocumentFingerprint,
  type ExternalRichDocumentV1,
} from '../../models/external-rich-document';

const PROBE_ENV_FLAG = 'RICH_MUTATION_PROBE';
const CLICKUP_ORIGIN = 'https://api.clickup.com';
const PROBE_TASK_NAME = 'devchain rich-conversion stability probe (throwaway)';
const SPACE_BOUND = 10;
const FOLDER_BOUND = 10;

// Covers the required edge cases: escaping, backticks, list-like text, URLs,
// and intra-word underscores. Indentation fail-closed behavior is owned by the
// unit suite; the provider fixture only carries provider-representable text.
const STABILITY_FIXTURE: ExternalRichDocumentV1 = {
  version: 1,
  blocks: [
    { type: 'heading', level: 2, content: [{ type: 'text', text: 'Stability probe', marks: [] }] },
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'Escapes: * star, _ under, [bracket], <angle>, # hash, - dash',
          marks: [],
        },
      ],
    },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Backticks: ', marks: [] },
        { type: 'text', text: 'inline code stays code', marks: [{ type: 'code' }] },
        {
          type: 'text',
          text: ', plain tick \\` in text, and snake_case_name stays plain',
          marks: [],
        },
      ],
    },
    {
      type: 'paragraph',
      content: [{ type: 'text', text: 'List-like text: 1. not a list, - not a bullet', marks: [] }],
    },
    {
      type: 'bulletList',
      items: [
        [
          { type: 'text', text: 'bullet with ', marks: [] },
          { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
        ],
        [{ type: 'text', text: 'bullet two', marks: [] }],
      ],
    },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'URL: ', marks: [] },
        {
          type: 'text',
          text: 'probe link',
          marks: [{ type: 'link', href: 'https://example.com/devchain-probe?a=1' }],
        },
      ],
    },
    { type: 'blockquote', paragraphs: [[{ type: 'text', text: 'quoted probe line', marks: [] }]] },
  ],
};

const COMMENT_FIXTURE: ExternalRichDocumentV1 = {
  version: 1,
  blocks: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'stability ', marks: [] },
        { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
        { type: 'text', text: ' and ', marks: [] },
        { type: 'text', text: 'code', marks: [{ type: 'code' }] },
        { type: 'text', text: ' with ', marks: [] },
        {
          type: 'text',
          text: 'link',
          marks: [{ type: 'link', href: 'https://example.com/devchain-probe' }],
        },
        { type: 'text', text: ' plus * literal _ chars', marks: [] },
      ],
    },
  ],
};

interface StabilityEvidence {
  probe: string;
  executedAt: string;
  markdownEmittedOk: boolean;
  writeOneAccepted: boolean;
  readOneParsed: boolean;
  readOneMatchesFixture: boolean;
  writeTwoAccepted: boolean;
  readTwoParsed: boolean;
  readTwoMatchesReadOne: boolean;
  providerMarkdownStable: boolean;
  commentEmittedOk: boolean;
  commentWriteAccepted: boolean;
  commentReadParsed: boolean;
  commentMatchesFixture: boolean;
  cleanup: {
    commentDeleted: boolean;
    taskDeleted: boolean;
    taskReadBackGone: boolean;
  };
  // Probe-authored fixture content only — safe to record for adjudication.
  emittedMarkdown: string | null;
  providerMarkdownOne: string | null;
  providerMarkdownTwo: string | null;
}

const describeFn = process.env[PROBE_ENV_FLAG] === '1' ? describe : describe.skip;

describeFn('rich conversion stability probe (ClickUp)', () => {
  jest.setTimeout(120_000);

  let credentials: IntegrationCredentials | null = null;
  const http = new SafeVendorHttpClient();

  beforeAll(() => {
    const dbPath = join(homedir(), '.devchain', 'devchain.db');
    if (!existsSync(dbPath)) {
      return;
    }
    const db = new Database(dbPath);
    try {
      const row = db
        .prepare('SELECT credential_ciphertext FROM integration_connections WHERE provider = ?')
        .get('clickup') as { credential_ciphertext?: string } | undefined;
      credentials = row?.credential_ciphertext
        ? new IntegrationCredentialCipher().decrypt(row.credential_ciphertext)
        : null;
    } finally {
      db.close();
    }
  });

  async function request(
    op: string,
    path: string,
    init: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: string } = {},
  ): Promise<{ ok: boolean; payload?: unknown; upstreamStatus?: number }> {
    try {
      const payload = await http.requestJson({
        url: `${CLICKUP_ORIGIN}${path}`,
        allowedOrigins: [CLICKUP_ORIGIN],
        ...(init.method ? { method: init.method } : {}),
        ...(init.body !== undefined ? { body: init.body } : {}),
        headers: {
          accept: 'application/json',
          authorization: credentials!.token,
          ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
      });
      return { ok: true, payload };
    } catch (error) {
      return {
        ok: false,
        upstreamStatus: error instanceof SafeVendorHttpError ? error.upstreamStatus : undefined,
      };
    }
  }

  it('stabilizes provider markdown and round-trips comment rich semantics', async () => {
    expect(credentials?.provider).toBe('clickup');
    const evidence: StabilityEvidence = {
      probe: 'rich-conversion-stability',
      executedAt: new Date().toISOString(),
      markdownEmittedOk: false,
      writeOneAccepted: false,
      readOneParsed: false,
      readOneMatchesFixture: false,
      writeTwoAccepted: false,
      readTwoParsed: false,
      readTwoMatchesReadOne: false,
      providerMarkdownStable: false,
      commentEmittedOk: false,
      commentWriteAccepted: false,
      commentReadParsed: false,
      commentMatchesFixture: false,
      cleanup: { commentDeleted: false, taskDeleted: false, taskReadBackGone: false },
      emittedMarkdown: null,
      providerMarkdownOne: null,
      providerMarkdownTwo: null,
    };
    const fixtureFingerprint = richDocumentFingerprint(STABILITY_FIXTURE);
    const commentFingerprint = richDocumentFingerprint(COMMENT_FIXTURE);
    expect(fixtureFingerprint).not.toBeNull();
    expect(commentFingerprint).not.toBeNull();

    const emitted = richDocumentToMarkdown(STABILITY_FIXTURE);
    evidence.markdownEmittedOk = emitted.ok;
    evidence.emittedMarkdown = emitted.ok ? emitted.markdown : null;
    expect(emitted.ok).toBe(true);
    if (!emitted.ok) {
      throw new Error('fixture must be markdown-representable');
    }

    // Bounded list discovery (same as the base probe).
    const teams = await request('getTeams', '/api/v2/team');
    const teamId =
      teams.ok && isRecord(teams.payload) && Array.isArray(teams.payload.teams)
        ? String((teams.payload.teams.find(isRecord) as Record<string, unknown>)?.id ?? '')
        : '';
    expect(teamId).not.toBe('');
    const spaces = await request(
      'getSpaces',
      `/api/v2/team/${encodeURIComponent(teamId)}/space?archived=false`,
    );
    const spaceIds =
      spaces.ok && isRecord(spaces.payload) && Array.isArray(spaces.payload.spaces)
        ? (spaces.payload.spaces as unknown[])
            .filter(isRecord)
            .map((space) => String(space.id))
            .filter(Boolean)
        : [];
    let listId: string | null = null;
    for (const spaceId of spaceIds.slice(0, SPACE_BOUND)) {
      const folderless = await request(
        'getFolderlessLists',
        `/api/v2/space/${encodeURIComponent(spaceId)}/list?archived=false`,
      );
      const folderlessList =
        folderless.ok && isRecord(folderless.payload) && Array.isArray(folderless.payload.lists)
          ? String((folderless.payload.lists.find(isRecord) as Record<string, unknown>)?.id ?? '')
          : '';
      if (folderlessList) {
        listId = folderlessList;
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
              .map((folder) => String(folder.id))
              .filter(Boolean)
          : [];
      for (const folderId of folderIds.slice(0, FOLDER_BOUND)) {
        const lists = await request(
          'getFolderLists',
          `/api/v2/folder/${encodeURIComponent(folderId)}/list?archived=false`,
        );
        const folderList =
          lists.ok && isRecord(lists.payload) && Array.isArray(lists.payload.lists)
            ? String((lists.payload.lists.find(isRecord) as Record<string, unknown>)?.id ?? '')
            : '';
        if (folderList) {
          listId = folderList;
          break;
        }
      }
      if (listId) {
        break;
      }
    }
    expect(listId).not.toBeNull();

    const created = await request(
      'createTask',
      `/api/v2/list/${encodeURIComponent(listId!)}/task`,
      {
        method: 'POST',
        body: JSON.stringify({ name: PROBE_TASK_NAME, markdown_description: emitted.markdown }),
      },
    );
    const taskId =
      created.ok && isRecord(created.payload) && typeof created.payload.id === 'string'
        ? created.payload.id
        : null;
    expect(taskId).not.toBeNull();
    evidence.writeOneAccepted = created.ok;

    const taskPath = () =>
      `/api/v2/task/${encodeURIComponent(taskId!)}?include_markdown_description=true`;
    const readOne = await request('getTaskMarkdownOne', taskPath());
    const readOneMarkdown =
      readOne.ok &&
      isRecord(readOne.payload) &&
      typeof readOne.payload.markdown_description === 'string'
        ? readOne.payload.markdown_description
        : null;
    const parsedOne = readOneMarkdown === null ? null : markdownToRichDocument(readOneMarkdown);
    evidence.providerMarkdownOne = readOneMarkdown;
    evidence.readOneParsed = parsedOne?.supported === true;
    const fingerprintOne =
      parsedOne && parsedOne.supported ? richDocumentFingerprint(parsedOne.document) : null;
    evidence.readOneMatchesFixture = fingerprintOne === fixtureFingerprint;

    const emittedTwo =
      parsedOne && parsedOne.supported ? richDocumentToMarkdown(parsedOne.document) : null;
    if (emittedTwo?.ok) {
      const writeTwo = await request(
        'writeTaskMarkdownTwo',
        `/api/v2/task/${encodeURIComponent(taskId!)}`,
        {
          method: 'PUT',
          body: JSON.stringify({ markdown_description: emittedTwo.markdown }),
        },
      );
      evidence.writeTwoAccepted = writeTwo.ok;
      const readTwo = await request('getTaskMarkdownTwo', taskPath());
      const readTwoMarkdown =
        readTwo.ok &&
        isRecord(readTwo.payload) &&
        typeof readTwo.payload.markdown_description === 'string'
          ? readTwo.payload.markdown_description
          : null;
      const parsedTwo = readTwoMarkdown === null ? null : markdownToRichDocument(readTwoMarkdown);
      evidence.providerMarkdownTwo = readTwoMarkdown;
      evidence.readTwoParsed = parsedTwo?.supported === true;
      const fingerprintTwo =
        parsedTwo && parsedTwo.supported ? richDocumentFingerprint(parsedTwo.document) : null;
      evidence.readTwoMatchesReadOne = fingerprintTwo === fingerprintOne;
      evidence.providerMarkdownStable =
        readTwoMarkdown !== null && readTwoMarkdown === readOneMarkdown;
    }

    const commentDelta = richDocumentToClickUpCommentDelta(COMMENT_FIXTURE);
    evidence.commentEmittedOk = commentDelta.ok;
    let commentId: string | null = null;
    if (commentDelta.ok) {
      const commentWrite = await request(
        'createComment',
        `/api/v2/task/${encodeURIComponent(taskId!)}/comment`,
        {
          method: 'POST',
          body: JSON.stringify({ comment: commentDelta.delta, notify_all: false }),
        },
      );
      evidence.commentWriteAccepted = commentWrite.ok;
      const comments = await request(
        'getComments',
        `/api/v2/task/${encodeURIComponent(taskId!)}/comment`,
      );
      const list =
        comments.ok && isRecord(comments.payload) && Array.isArray(comments.payload.comments)
          ? (comments.payload.comments as unknown[]).filter(isRecord)
          : [];
      const own = list.find((item) => item.comment !== undefined) ?? null;
      if (own && typeof own.id === 'string') {
        commentId = own.id;
        const parsedComment = clickupCommentDeltaToRichDocument(own.comment);
        evidence.commentReadParsed = parsedComment.supported === true;
        evidence.commentMatchesFixture =
          parsedComment.supported === true
            ? richDocumentFingerprint(parsedComment.document) === commentFingerprint
            : false;
      }
    }

    if (commentId) {
      const commentDelete = await request(
        'deleteComment',
        `/api/v2/comment/${encodeURIComponent(commentId)}`,
        {
          method: 'DELETE',
        },
      );
      evidence.cleanup.commentDeleted = commentDelete.ok;
    }
    const taskDelete = await request('deleteTask', `/api/v2/task/${encodeURIComponent(taskId!)}`, {
      method: 'DELETE',
    });
    const taskAfter = await request(
      'getTaskAfterDelete',
      `/api/v2/task/${encodeURIComponent(taskId!)}`,
    );
    // ClickUp deletes answer 204 with a JSON content type, which the strict
    // JSON reader reports as failure after the wire request already ran; the
    // read-back is the authoritative outcome.
    evidence.cleanup.taskDeleted = taskDelete.ok || taskAfter.upstreamStatus === 404;
    evidence.cleanup.taskReadBackGone = !taskAfter.ok && taskAfter.upstreamStatus === 404;

    // eslint-disable-next-line no-console -- the probe's single sanitized summary output
    console.log('[rich-conversion-stability]', JSON.stringify(evidence));

    expect(evidence.readOneMatchesFixture).toBe(true);
    expect(evidence.readTwoMatchesReadOne).toBe(true);
    expect(evidence.commentMatchesFixture).toBe(true);
    expect(evidence.cleanup.taskReadBackGone).toBe(true);
  });
});
