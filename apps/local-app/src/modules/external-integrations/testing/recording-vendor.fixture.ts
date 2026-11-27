import type { TestingModuleBuilder } from '@nestjs/testing';
import { ClickUpExternalTaskProvider } from '../adapters/clickup-external-task.provider';
import { JiraExternalTaskProvider } from '../adapters/jira-external-task.provider';
import { ExternalProviderError } from '../errors/external-provider.errors';
import type {
  ExternalSubtaskSnapshot,
  ExternalSubtaskSyncCapability,
} from '../models/external-provider.models';
import {
  EXTERNAL_TASK_PROVIDERS,
  type ExternalTaskProvider,
} from '../ports/external-task-provider';
import {
  SafeVendorHttpClient,
  type SafeVendorJsonRequest,
} from '../transport/safe-vendor-http-client';

export type VendorCaller = 'home' | 'host';

/**
 * One vendor call: an HTTP request (`GET /rest/api/3/issue/ENG-1`) or a managed-subtask
 * capability call (`subtask:create`), with the instance that made it.
 */
export interface VendorCall {
  instance: VendorCaller;
  op: string;
  /** `email:token` of a Jira request; empty for subtask calls. */
  token: string;
}

/**
 * A Jira site that two booted apps share: task reads go through the real Jira adapter
 * to `requestJson`, managed subtasks through an in-memory `subtaskSync`. Every call is
 * recorded with the instance that made it, so a test can prove which instance called
 * the vendor and how often.
 */
export interface RecordingVendor {
  readonly calls: VendorCall[];
  /** Managed subtasks on the site, by remote id. */
  readonly subtasks: Map<string, ExternalSubtaskSnapshot>;
  /** Issue keys the site answers; any other key is a 404. */
  readonly issues: Set<string>;
  /**
   * Holds the next `subtask:<op>` call before it reaches the site: `reached` resolves
   * when the call arrives, and the call is recorded and applied after `release`.
   */
  hold(op: SubtaskOp): { reached: Promise<void>; release(): void };
  /** Calls recorded after the first `from` calls that match `filter`. */
  callsAfter(from: number, filter?: VendorCallFilter): VendorCall[];
  /** Routes one instance's vendor boundary to this site. */
  configure(builder: TestingModuleBuilder, instance: VendorCaller): TestingModuleBuilder;
}

export interface VendorCallFilter {
  instance?: VendorCaller;
  op?: string;
  opPrefix?: string;
}

export type SubtaskOp = 'create' | 'readExact' | 'update' | 'delete' | 'listOwned' | 'assertOwned';

export const JIRA_SITE = 'https://acme.atlassian.net';
/** The Jira project every issue on the site belongs to: a linked task's work area. */
const WORK_AREA = 'p1';

class VendorNotFound extends Error {
  readonly status = 404;
}

export function recordingVendor(): RecordingVendor {
  const calls: VendorCall[] = [];
  const subtasks = new Map<string, ExternalSubtaskSnapshot>();
  const issues = new Set<string>();
  const holds = new Map<SubtaskOp, { arrive: () => void; released: Promise<void> }>();
  let sequence = 0;

  function hold(op: SubtaskOp): { reached: Promise<void>; release(): void } {
    let arrive!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => (arrive = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    holds.set(op, { arrive, released });
    return { reached, release };
  }

  async function requestJson(
    instance: VendorCaller,
    request: SafeVendorJsonRequest,
  ): Promise<unknown> {
    const url = new URL(request.url);
    const auth = new Headers(request.headers).get('authorization') ?? '';
    const token = Buffer.from(auth.replace(/^Basic /, ''), 'base64').toString('utf8');
    calls.push({ instance, op: `${request.method ?? 'GET'} ${url.pathname}`, token });
    const issue = /^\/rest\/api\/3\/issue\/([^/]+)$/.exec(url.pathname)?.[1];
    if (issue && issues.has(issue)) {
      return {
        id: `id-${issue}`,
        key: issue,
        fields: {
          summary: `Remote ${issue}`,
          description: null,
          status: { id: 's1', name: 'In Progress', statusCategory: { key: 'indeterminate' } },
          duedate: null,
          priority: null,
          project: { id: WORK_AREA, key: 'ENG', name: 'Engineering' },
          subtasks: [],
          timetracking: {},
        },
      };
    }
    if (/^\/rest\/api\/3\/issue\/[^/]+\/transitions$/.test(url.pathname)) {
      return { transitions: [] };
    }
    if (url.pathname === '/rest/api/3/configuration') return { timeTrackingEnabled: false };
    throw new VendorNotFound(`unexpected Jira request: ${request.method ?? 'GET'} ${url.pathname}`);
  }

  function subtaskSync(instance: VendorCaller): ExternalSubtaskSyncCapability {
    const record = async (op: SubtaskOp) => {
      const held = holds.get(op);
      if (held) {
        holds.delete(op);
        held.arrive();
        await held.released;
      }
      calls.push({ instance, op: `subtask:${op}`, token: '' });
    };
    const owned = (remoteTaskId: string, ownershipToken: string): ExternalSubtaskSnapshot => {
      const current = subtasks.get(remoteTaskId);
      if (!current || current.ownershipToken !== ownershipToken) {
        throw new ExternalProviderError('jira', 'ownership_mismatch');
      }
      return current;
    };
    return {
      create: async (_credentials, _context, input) => {
        await record('create');
        const remoteTaskId = `SUB-${++sequence}`;
        const snapshot: ExternalSubtaskSnapshot = {
          remoteTaskId,
          remoteKey: remoteTaskId,
          parentRemoteTaskId: input.parentRemoteTaskId,
          workAreaRemoteId: WORK_AREA,
          ownershipToken: input.ownershipToken,
          title: input.title,
          description: input.description,
        };
        subtasks.set(remoteTaskId, snapshot);
        return { ...snapshot };
      },
      readExact: async (_credentials, _context, remoteTaskId) => {
        await record('readExact');
        const snapshot = subtasks.get(remoteTaskId);
        return snapshot ? { ...snapshot } : null;
      },
      update: async (_credentials, _context, input) => {
        await record('update');
        const current = owned(input.remoteTaskId, input.ownershipToken);
        subtasks.set(input.remoteTaskId, {
          ...current,
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
        });
      },
      delete: async (_credentials, _context, proof) => {
        await record('delete');
        if (!subtasks.has(proof.remoteTaskId)) return { outcome: 'already_absent' as const };
        owned(proof.remoteTaskId, proof.ownershipToken);
        subtasks.delete(proof.remoteTaskId);
        return { outcome: 'deleted' as const };
      },
      listOwnedDirectChildren: async (_credentials, _context, parentId, ownershipToken) => {
        await record('listOwned');
        return {
          items: [...subtasks.values()].filter(
            (item) =>
              item.parentRemoteTaskId === parentId && item.ownershipToken === ownershipToken,
          ),
          complete: true,
        };
      },
      assertOwned: async (_credentials, _context, proof) => {
        await record('assertOwned');
        return { ...owned(proof.remoteTaskId, proof.ownershipToken) };
      },
    };
  }

  return {
    calls,
    subtasks,
    issues,
    hold,
    callsAfter: (from, { instance, op, opPrefix } = {}) =>
      calls
        .slice(from)
        .filter(
          (call) =>
            (instance === undefined || call.instance === instance) &&
            (op === undefined || call.op === op) &&
            (opPrefix === undefined || call.op.startsWith(opPrefix)),
        ),
    configure: (builder, instance) =>
      builder
        .overrideProvider(SafeVendorHttpClient)
        .useValue({
          requestJson: (request: SafeVendorJsonRequest) => requestJson(instance, request),
          requestNoContent: async (request: SafeVendorJsonRequest) => {
            await requestJson(instance, request);
          },
        })
        .overrideProvider(EXTERNAL_TASK_PROVIDERS)
        .useFactory({
          inject: [ClickUpExternalTaskProvider, JiraExternalTaskProvider],
          factory: (
            clickup: ClickUpExternalTaskProvider,
            jira: JiraExternalTaskProvider,
          ): ExternalTaskProvider[] => {
            const sync = subtaskSync(instance);
            // Task reads stay the real adapter's; only managed subtasks are in memory.
            const withSync = new Proxy(jira, {
              get: (target, key) =>
                key === 'subtaskSync' ? sync : Reflect.get(target, key, target),
            });
            return [clickup, withSync];
          },
        }),
  };
}
