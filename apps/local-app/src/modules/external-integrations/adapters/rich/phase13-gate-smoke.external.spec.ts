/**
 * Phase-13 gate cross-provider live smoke. Exercises the real production
 * stack — provider adapters, SafeVendorHttpClient, canonical converters,
 * ExternalEditSessionService, the shared operation gate — against the
 * configured ClickUp and Jira test environments with throwaway content:
 *
 * - description edit sessions: baseline read → session write → verify.
 * - owned comment deletion: bounded lookup → owner validation → gated delete.
 *
 * Opt-in (external lane + RICH_MUTATION_PROBE=1). All throwaway data is
 * removed and verified gone via read-backs; the sanitized evidence file holds
 * only outcome facts, never credentials, emails, account ids, or raw vendor
 * bodies.
 */
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { StorageService } from '../../../storage/interfaces/storage.interface';
import type {
  IntegrationConnection,
  IntegrationCredentials,
  IntegrationProvider,
} from '../../../storage/models/domain.models';
import { ClickUpExternalTaskProvider } from '../clickup-external-task.provider';
import { JiraExternalTaskProvider } from '../jira-external-task.provider';
import { ExternalTaskProviderRegistry } from '../../external-task-provider.registry';
import { SafeVendorHttpClient } from '../../transport/safe-vendor-http-client';
import { ExternalEditSessionService } from '../../my-work/external-edit-session.service';
import { ExternalEditSessionStore } from '../../sessions/external-edit-session.store';
import { ProviderOperationGate } from '../../sessions/provider-operation-gate';
import { adfToRichDocument } from './jira-adf-converter';
import type { ExternalRichDocumentV1 } from '../../models/external-rich-document';
import { IntegrationCredentialCipher } from '../../../storage/local/integration-credential-cipher';

const PROBE_ENV_FLAG = 'RICH_MUTATION_PROBE';
const CLICKUP_ORIGIN = 'https://api.clickup.com';
const PROBE_TASK_NAME = 'devchain gate smoke (throwaway)';

interface ProviderSmokeResult {
  provider: IntegrationProvider;
  available: boolean;
  descriptionSession: {
    created: boolean;
    baselineSupported: boolean;
    writeOutcome: string | null;
    writeReason: string | null;
    verifiedRemoteState: string | null;
    revisionAfterVerify: number | null;
    finalState: string | null;
  };
  commentDelete: {
    sessionCreated: boolean;
    notOwnedRejected: boolean | null;
    deleteOutcome: string | null;
    deleteReason: string | null;
    verifiedGone: boolean | null;
  };
  cleanup: { commentGone: boolean | null; taskGone: boolean | null };
}

interface GateEvidence {
  probe: string;
  executedAt: string;
  providers: ProviderSmokeResult[];
  decisions: {
    RICH_EDIT_GO: boolean | null;
    OWNED_DELETE_GO: boolean | null;
  };
}

function loadCredentials(provider: 'clickup' | 'jira'): IntegrationCredentials | null {
  const dbPath = join(homedir(), '.devchain', 'devchain.db');
  if (!existsSync(dbPath)) {
    return null;
  }
  const db = new Database(dbPath);
  try {
    const row = db
      .prepare(
        'SELECT credential_ciphertext, id, generation FROM integration_connections WHERE provider = ?',
      )
      .get(provider) as
      | { credential_ciphertext?: string; id?: string; generation?: number }
      | undefined;
    if (!row?.credential_ciphertext || !row.id || typeof row.generation !== 'number') {
      return null;
    }
    const credentials = new IntegrationCredentialCipher().decrypt(row.credential_ciphertext);
    return credentials.provider === provider ? credentials : null;
  } finally {
    db.close();
  }
}

class ConnectionReadingStorage {
  constructor(private readonly provider: IntegrationProvider) {}

  async getIntegrationConnection(provider: string): Promise<IntegrationConnection | null> {
    if (provider !== this.provider) {
      return null;
    }
    const dbPath = join(homedir(), '.devchain', 'devchain.db');
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db
        .prepare('SELECT id, provider, generation FROM integration_connections WHERE provider = ?')
        .get(provider) as { id: string; provider: string; generation: number } | undefined;
      return row
        ? {
            id: row.id,
            provider: row.provider as IntegrationProvider,
            generation: row.generation,
            createdAt: '',
            updatedAt: '',
          }
        : null;
    } finally {
      db.close();
    }
  }

  async getIntegrationConnectionCredentials(
    provider: string,
  ): Promise<IntegrationCredentials | null> {
    return provider === this.provider ? loadCredentials(this.provider as 'clickup' | 'jira') : null;
  }
}

function emptyResult(provider: IntegrationProvider): ProviderSmokeResult {
  return {
    provider,
    available: false,
    descriptionSession: {
      created: false,
      baselineSupported: false,
      writeOutcome: null,
      writeReason: null,
      verifiedRemoteState: null,
      revisionAfterVerify: null,
      finalState: null,
    },
    commentDelete: {
      sessionCreated: false,
      notOwnedRejected: null,
      deleteOutcome: null,
      deleteReason: null,
      verifiedGone: null,
    },
    cleanup: { commentGone: null, taskGone: null },
  };
}

async function clickupListId(http: SafeVendorHttpClient, token: string): Promise<string | null> {
  const json = async (url: string) =>
    (await http.requestJson({
      url,
      allowedOrigins: [CLICKUP_ORIGIN],
      headers: { accept: 'application/json', authorization: token },
    })) as Record<string, unknown>;

  const teams = (await json(`${CLICKUP_ORIGIN}/api/v2/team`)) as { teams?: unknown[] };
  const team = (teams?.teams ?? []).find(
    (value): value is Record<string, unknown> => typeof value === 'object' && value !== null,
  );
  if (!team || typeof team.id !== 'string') {
    return null;
  }
  const spaces = (await json(
    `${CLICKUP_ORIGIN}/api/v2/team/${encodeURIComponent(team.id)}/space?archived=false`,
  )) as { spaces?: unknown[] };
  for (const spaceRaw of (spaces?.spaces ?? []).slice(0, 10)) {
    if (typeof spaceRaw !== 'object' || spaceRaw === null) {
      continue;
    }
    const spaceId = (spaceRaw as Record<string, unknown>).id;
    if (typeof spaceId !== 'string') {
      continue;
    }
    const lists = (await json(
      `${CLICKUP_ORIGIN}/api/v2/space/${encodeURIComponent(spaceId)}/list?archived=false`,
    )) as { lists?: unknown[] };
    const list = (lists?.lists ?? []).find(
      (value): value is Record<string, unknown> => typeof value === 'object' && value !== null,
    );
    if (list && typeof list.id === 'string') {
      return list.id;
    }
  }
  return null;
}

async function jiraProjectKey(
  http: SafeVendorHttpClient,
  origin: string,
  authorization: string,
): Promise<string | null> {
  const payload = (await http.requestJson({
    url: `${origin}/rest/api/3/project/search?maxResults=5`,
    allowedOrigins: [origin],
    headers: { accept: 'application/json', authorization },
  })) as { values?: Array<{ key?: string }> };
  const first = payload?.values?.find((value) => typeof value.key === 'string');
  return first?.key ?? null;
}

const describeFn = process.env[PROBE_ENV_FLAG] === '1' ? describe : describe.skip;

describeFn('Phase 13 gate: cross-provider live smoke', () => {
  jest.setTimeout(180_000);

  const http = new SafeVendorHttpClient();
  const evidence: GateEvidence = {
    probe: 'phase13-gate-smoke',
    executedAt: new Date().toISOString(),
    providers: [],
    decisions: { RICH_EDIT_GO: null, OWNED_DELETE_GO: null },
  };

  it('runs the full description-edit and owned-delete matrix on both providers', async () => {
    const clickupCredentials = loadCredentials('clickup');
    const jiraCredentials = loadCredentials('jira');

    // ---------- ClickUp ----------
    const clickup = emptyResult('clickup');
    if (clickupCredentials?.provider === 'clickup') {
      clickup.available = true;
      const token = clickupCredentials.token;
      const listId = await clickupListId(http, token);
      expect(listId).not.toBeNull();

      // Throwaway task with a supported markdown baseline.
      const created = (await http.requestJson({
        url: `${CLICKUP_ORIGIN}/api/v2/list/${encodeURIComponent(listId!)}/task`,
        allowedOrigins: [CLICKUP_ORIGIN],
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: token,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: PROBE_TASK_NAME,
          markdown_description: '# Baseline heading\n\nBaseline paragraph.',
        }),
      })) as { id?: string };
      expect(created?.id).toBeTruthy();
      const taskId = created.id!;

      // Throwaway owned comment (verified rich-write contract).
      const comment = (await http.requestJson({
        url: `${CLICKUP_ORIGIN}/api/v2/task/${encodeURIComponent(taskId)}/comment`,
        allowedOrigins: [CLICKUP_ORIGIN],
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: token,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          comment: [{ text: 'gate smoke comment' }],
          notify_all: false,
        }),
      })) as { id?: string };
      expect(comment?.id).toBeTruthy();
      const commentId = String(comment.id);

      const clickupAdapter = new ClickUpExternalTaskProvider(http);
      const registry = new ExternalTaskProviderRegistry([
        clickupAdapter,
        new JiraExternalTaskProvider(http),
      ]);
      const service = new ExternalEditSessionService(
        new ConnectionReadingStorage('clickup') as unknown as StorageService,
        registry,
        new ProviderOperationGate(),
        new ExternalEditSessionStore(),
      );

      // Description edit through the real session service.
      const session = await service.createDescriptionSession('clickup', taskId);
      clickup.descriptionSession.created = true;
      clickup.descriptionSession.baselineSupported = session.baselineFingerprint !== null;

      const updated: ExternalRichDocumentV1 = {
        version: 1,
        blocks: [
          {
            type: 'heading',
            level: 2,
            content: [{ type: 'text', text: 'Gate heading', marks: [] }],
          },
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Edited through ', marks: [] },
              { type: 'text', text: 'the session service', marks: [{ type: 'bold' }] },
            ],
          },
        ],
      };
      const write = await service.saveSession(session.sessionId, updated, 0);
      clickup.descriptionSession.writeOutcome = write.outcome;
      if (write.outcome === 'pre_dispatch_rejected') {
        clickup.descriptionSession.writeReason = write.reason;
      }
      const verify = await service.verifySession(session.sessionId);
      clickup.descriptionSession.verifiedRemoteState = verify.remoteState;
      clickup.descriptionSession.revisionAfterVerify = verify.session?.revision ?? null;
      clickup.descriptionSession.finalState = verify.session?.state ?? null;

      // Owned delete through the real bounded lookup + gate.
      const deleteSession = await service.createCommentDeleteSession(
        'clickup',
        taskId,
        commentId,
        null,
      );
      clickup.commentDelete.sessionCreated = true;
      const deleteOutcome = await service.executeCommentDelete(deleteSession.sessionId);
      clickup.commentDelete.deleteOutcome = deleteOutcome.outcome;
      if (deleteOutcome.outcome === 'rejected') {
        clickup.commentDelete.deleteReason = deleteOutcome.reason;
      }
      const commentsAfter = (await http.requestJson({
        url: `${CLICKUP_ORIGIN}/api/v2/task/${encodeURIComponent(taskId)}/comment`,
        allowedOrigins: [CLICKUP_ORIGIN],
        headers: { accept: 'application/json', authorization: token },
      })) as { comments?: Array<{ id?: unknown }> };
      clickup.cleanup.commentGone = !(commentsAfter?.comments ?? []).some(
        (item) => String(item.id) === commentId,
      );
      clickup.commentDelete.verifiedGone = clickup.cleanup.commentGone;

      // Cleanup: throwaway task, verified gone.
      await http
        .requestJson({
          url: `${CLICKUP_ORIGIN}/api/v2/task/${encodeURIComponent(taskId)}`,
          allowedOrigins: [CLICKUP_ORIGIN],
          method: 'DELETE',
          headers: { accept: 'application/json', authorization: token },
        })
        .catch(() => undefined);
      const taskAfter = await http
        .requestJson({
          url: `${CLICKUP_ORIGIN}/api/v2/task/${encodeURIComponent(taskId)}`,
          allowedOrigins: [CLICKUP_ORIGIN],
          headers: { accept: 'application/json', authorization: token },
        })
        .then(() => 'present')
        .catch(() => 'gone');
      clickup.cleanup.taskGone = taskAfter === 'gone';
    }

    // ---------- Jira ----------
    const jira = emptyResult('jira');
    if (jiraCredentials?.provider === 'jira') {
      jira.available = true;
      const origin = jiraCredentials.siteUrl.replace(/\/$/, '');
      const authorization = `Basic ${Buffer.from(
        `${jiraCredentials.email}:${jiraCredentials.token}`,
      ).toString('base64')}`;
      const projectKey = await jiraProjectKey(http, origin, authorization);
      expect(projectKey).not.toBeNull();

      const issue = (await http.requestJson({
        url: `${origin}/rest/api/3/issue`,
        allowedOrigins: [origin],
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          fields: {
            project: { key: projectKey },
            summary: PROBE_TASK_NAME,
            issuetype: { name: 'Task' },
            description: {
              type: 'doc',
              version: 1,
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'Baseline paragraph.' }] },
              ],
            },
          },
        }),
      })) as { key?: string };
      expect(issue?.key).toBeTruthy();
      const issueKey = issue.key!;

      const comment = (await http.requestJson({
        url: `${origin}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`,
        allowedOrigins: [origin],
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          body: {
            type: 'doc',
            version: 1,
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'gate smoke comment' }] },
            ],
          },
        }),
      })) as { id?: string };
      expect(comment?.id).toBeTruthy();
      const commentId = String(comment.id);

      const jiraAdapter = new JiraExternalTaskProvider(http);
      const registry = new ExternalTaskProviderRegistry([
        new ClickUpExternalTaskProvider(http),
        jiraAdapter,
      ]);
      const service = new ExternalEditSessionService(
        new ConnectionReadingStorage('jira') as unknown as StorageService,
        registry,
        new ProviderOperationGate(),
        new ExternalEditSessionStore(),
      );

      const session = await service.createDescriptionSession('jira', issueKey);
      jira.descriptionSession.created = true;
      jira.descriptionSession.baselineSupported = session.baselineFingerprint !== null;

      const baselineDoc = adfToRichDocument({
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Baseline paragraph.' }] }],
      });
      expect(baselineDoc.supported).toBe(true);
      const updated: ExternalRichDocumentV1 = {
        version: 1,
        blocks: [
          {
            type: 'heading',
            level: 3,
            content: [{ type: 'text', text: 'Gate heading', marks: [] }],
          },
          ...(baselineDoc.supported ? baselineDoc.document.blocks : []),
        ],
      };
      const write = await service.saveSession(session.sessionId, updated, 0);
      jira.descriptionSession.writeOutcome = write.outcome;
      if (write.outcome === 'pre_dispatch_rejected') {
        jira.descriptionSession.writeReason = write.reason;
      }
      const verify = await service.verifySession(session.sessionId);
      jira.descriptionSession.verifiedRemoteState = verify.remoteState;
      jira.descriptionSession.revisionAfterVerify = verify.session?.revision ?? null;
      jira.descriptionSession.finalState = verify.session?.state ?? null;

      const deleteSession = await service.createCommentDeleteSession(
        'jira',
        issueKey,
        commentId,
        null,
      );
      jira.commentDelete.sessionCreated = true;
      const deleteOutcome = await service.executeCommentDelete(deleteSession.sessionId);
      jira.commentDelete.deleteOutcome = deleteOutcome.outcome;
      if (deleteOutcome.outcome === 'rejected') {
        jira.commentDelete.deleteReason = deleteOutcome.reason;
      }
      const commentAfter = await http
        .requestJson({
          url: `${origin}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(commentId)}`,
          allowedOrigins: [origin],
          headers: { accept: 'application/json', authorization },
        })
        .then(() => 'present')
        .catch(() => 'gone');
      jira.cleanup.commentGone = commentAfter === 'gone';
      jira.commentDelete.verifiedGone = commentAfter === 'gone';

      await http
        .requestNoContent({
          url: `${origin}/rest/api/3/issue/${encodeURIComponent(issueKey)}`,
          allowedOrigins: [origin],
          method: 'DELETE',
          headers: { accept: 'application/json', authorization },
        })
        .catch(() => undefined);
      const issueAfter = await http
        .requestJson({
          url: `${origin}/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=summary`,
          allowedOrigins: [origin],
          headers: { accept: 'application/json', authorization },
        })
        .then(() => 'present')
        .catch(() => 'gone');
      jira.cleanup.taskGone = issueAfter === 'gone';
    }

    evidence.providers = [clickup, jira];

    // ---------- Decisions ----------
    const bothAvailable = clickup.available && jira.available;
    if (bothAvailable) {
      // A Save now verifies internally: outcome saved means the post-write
      // read confirmed the payload and committed revision 1. The explicit
      // verify call afterwards must see the new content as its baseline.
      evidence.decisions.RICH_EDIT_GO = [clickup, jira].every(
        (result) =>
          result.descriptionSession.created &&
          result.descriptionSession.baselineSupported &&
          result.descriptionSession.writeOutcome === 'saved' &&
          result.descriptionSession.verifiedRemoteState === 'old_baseline' &&
          result.descriptionSession.revisionAfterVerify === 1 &&
          result.descriptionSession.finalState === 'editable',
      );
      evidence.decisions.OWNED_DELETE_GO = [clickup, jira].every(
        (result) =>
          result.commentDelete.sessionCreated &&
          (result.commentDelete.deleteOutcome === 'deleted' ||
            result.commentDelete.deleteOutcome === 'already_deleted') &&
          result.commentDelete.verifiedGone === true,
      );
    }

    const reportsDirectory = join(process.cwd(), 'reports');
    mkdirSync(reportsDirectory, { recursive: true });
    const serialized = JSON.stringify(evidence, null, 2);
    // Sanitization guard: evidence holds outcomes only.
    for (const credentials of [clickupCredentials, jiraCredentials]) {
      if (!credentials) {
        continue;
      }
      if (credentials.token.length >= 8) {
        expect(serialized.includes(credentials.token)).toBe(false);
      }
      if ('email' in credentials && credentials.email.length >= 8) {
        expect(serialized.includes(credentials.email)).toBe(false);
      }
      if ('siteUrl' in credentials) {
        expect(serialized.includes(credentials.siteUrl)).toBe(false);
      }
    }
    writeFileSync(join(reportsDirectory, 'phase13-gate-evidence.json'), `${serialized}\n`);

    // eslint-disable-next-line no-console -- single sanitized summary line
    console.log(
      `[phase13-gate] RICH_EDIT_GO=${String(evidence.decisions.RICH_EDIT_GO)} ` +
        `OWNED_DELETE_GO=${String(evidence.decisions.OWNED_DELETE_GO)} ` +
        `cleanup=${JSON.stringify([clickup.cleanup, jira.cleanup])}`,
    );

    expect(evidence.decisions.RICH_EDIT_GO).toBe(true);
    expect(evidence.decisions.OWNED_DELETE_GO).toBe(true);
    expect(clickup.cleanup.taskGone).toBe(true);
    expect(jira.cleanup.taskGone).toBe(true);
  });
});
