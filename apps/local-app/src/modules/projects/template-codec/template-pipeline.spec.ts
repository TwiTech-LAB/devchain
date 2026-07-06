import { ImportContext, ImportContextError } from './import-context';
import type { ImportContextKey, StorageStateFlag } from './import-context';
import { TemplatePipeline, TemplateTopologyError } from './template-pipeline';
import type {
  CodecApplyResult,
  CodecApplyRuntime,
  ParsedTemplatePayload,
  PipelineMode,
  TemplateSectionCodec,
} from './template-section-codec';

/** Build a synthetic codec with a spy-able apply, for topology + execution tests. */
function fakeCodec(
  section: string,
  opts: {
    reads?: ImportContextKey[];
    writes?: ImportContextKey[];
    requiresState?: StorageStateFlag[];
    producesState?: StorageStateFlag[];
    modes?: PipelineMode[];
    apply?: (ctx: ImportContext, rt: CodecApplyRuntime) => void | Promise<void>;
  } = {},
): TemplateSectionCodec {
  return {
    declaration: {
      section,
      reads: opts.reads ?? [],
      writes: opts.writes ?? [],
      requiresState: opts.requiresState,
      producesState: opts.producesState,
      modes: opts.modes ?? ['replace'],
    },
    pick: (payload: ParsedTemplatePayload) => payload,
    build: () => undefined,
    apply: async (_section, ctx, _mode, rt): Promise<CodecApplyResult> => {
      await opts.apply?.(ctx, rt);
      return { section };
    },
  };
}

const EMPTY_PAYLOAD = {} as ParsedTemplatePayload;
const RT: CodecApplyRuntime = { projectId: 'p1', storage: {} as never };

describe('TemplatePipeline topology validation', () => {
  it('accepts the real registered codec set (constructor validates at init)', () => {
    expect(() => new TemplatePipeline()).not.toThrow();
  });

  it('rejects duplicate section ids', () => {
    expect(() =>
      TemplatePipeline.assertValidTopology([fakeCodec('dup'), fakeCodec('dup')]),
    ).toThrow(TemplateTopologyError);
  });

  it('rejects a dependency CYCLE', () => {
    const a = fakeCodec('a', { reads: ['statusIdMap'], writes: ['promptIdMap'] });
    const b = fakeCodec('b', { reads: ['promptIdMap'], writes: ['statusIdMap'] });
    expect(() => TemplatePipeline.assertValidTopology([a, b])).toThrow(/cycle/i);
  });

  it('rejects an UNDECLARED read (no producer, not seeded)', () => {
    const a = fakeCodec('a', { reads: ['agentIdMap'] });
    expect(() => TemplatePipeline.assertValidTopology([a])).toThrow(/undeclared read/i);
  });

  it('rejects a LATER-STAGE read (satisfied only by a later codec)', () => {
    const reader = fakeCodec('reader', { reads: ['statusIdMap'] });
    const writer = fakeCodec('writer', { writes: ['statusIdMap'] });
    expect(() => TemplatePipeline.assertValidTopology([reader, writer])).toThrow(
      /later-stage read/i,
    );
  });

  it('accepts a read satisfied by an EARLIER codec', () => {
    const writer = fakeCodec('writer', { writes: ['statusIdMap'] });
    const reader = fakeCodec('reader', { reads: ['statusIdMap'] });
    expect(() => TemplatePipeline.assertValidTopology([writer, reader])).not.toThrow();
  });

  it('accepts a read satisfied by a SEEDED key', () => {
    const reader = fakeCodec('reader', { reads: ['agentIdMap'] });
    expect(() =>
      TemplatePipeline.assertValidTopology([reader], { seededKeys: ['agentIdMap'] }),
    ).not.toThrow();
  });

  it('rejects a required storage-state with no producer and no seed', () => {
    const a = fakeCodec('a', { requiresState: ['agentsPersisted'] });
    expect(() => TemplatePipeline.assertValidTopology([a])).toThrow(/undeclared required state/i);
  });

  it('accepts a required storage-state satisfied by an earlier producer', () => {
    const producer = fakeCodec('producer', { producesState: ['agentsPersisted'] });
    const consumer = fakeCodec('consumer', { requiresState: ['agentsPersisted'] });
    expect(() => TemplatePipeline.assertValidTopology([producer, consumer])).not.toThrow();
  });
});

describe('TemplatePipeline execution', () => {
  it('runs only requested, mode-matching codecs in registered order and records products', async () => {
    const order: string[] = [];
    const a = fakeCodec('a', {
      writes: ['statusIdMap'],
      apply: (ctx) => {
        order.push('a');
        ctx.set('statusIdMap', { s: '1' });
      },
    });
    const b = fakeCodec('b', {
      reads: ['statusIdMap'],
      writes: ['promptIdMap'],
      apply: (ctx) => {
        order.push('b');
        ctx.set('promptIdMap', { p: '2' });
      },
    });
    const createOnly = fakeCodec('c', { modes: ['create'], apply: () => order.push('c') });
    const pipeline = new TemplatePipeline([a, b, createOnly]);

    const ctx = new ImportContext();
    const results = await pipeline.applySections(
      ['a', 'b', 'c'],
      EMPTY_PAYLOAD,
      ctx,
      'replace',
      RT,
    );

    expect(order).toEqual(['a', 'b']); // 'c' is create-only, skipped in replace
    expect(results.map((r) => r.section)).toEqual(['a', 'b']);
    expect(ctx.get('statusIdMap')).toEqual({ s: '1' });
    expect(ctx.get('promptIdMap')).toEqual({ p: '2' });
  });

  it('skips codecs not in the requested set', async () => {
    const order: string[] = [];
    const a = fakeCodec('a', { apply: () => order.push('a') });
    const b = fakeCodec('b', { apply: () => order.push('b') });
    const pipeline = new TemplatePipeline([a, b]);

    await pipeline.applySections(['b'], EMPTY_PAYLOAD, new ImportContext(), 'replace', RT);
    expect(order).toEqual(['b']);
  });

  it('enforces required storage-state at run time (throws if unmet)', async () => {
    const needsState = fakeCodec('needsState', { requiresState: ['existingDataCleared'] });
    const pipeline = new TemplatePipeline([needsState]);
    await expect(
      pipeline.applySections(['needsState'], EMPTY_PAYLOAD, new ImportContext(), 'replace', RT),
    ).rejects.toThrow(ImportContextError);
  });

  it('surfaces the runtime read-before-write guard from a codec that reads too early', async () => {
    // A codec declaring no reads but illegally reading an unset product at run time.
    const rogue = fakeCodec('rogue', {
      apply: (ctx) => {
        ctx.get('promptIdMap');
      },
    });
    const pipeline = new TemplatePipeline([rogue]);
    await expect(
      pipeline.applySections(['rogue'], EMPTY_PAYLOAD, new ImportContext(), 'replace', RT),
    ).rejects.toThrow(ImportContextError);
  });
});
