/**
 * TemplatePipeline — composes the section codecs and runs them in a validated order.
 *
 * Concrete service, NOT a port (ADR-004 §5: no new ports without ≥2 adapters). It is
 * registered as a NestJS provider so its constructor — which runs `assertValidTopology`
 * over the registered codec set — executes at module init: a codec whose declared
 * `reads` can only be satisfied by a LATER codec, or that forms a dependency cycle, or
 * that reads a product no codec writes, fails the app at boot rather than mid-import.
 *
 * There is no per-request validation overhead: topology is checked once at construction;
 * `applySections` just walks the pre-validated order.
 */
import { Injectable, Optional } from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import { ImportContext } from './import-context';
import type { ImportContextKey, StorageStateFlag } from './import-context';
import { REPLACE_MODE_CODECS } from './codec-registry';
import type {
  CodecApplyResult,
  CodecApplyRuntime,
  ParsedTemplatePayload,
  PipelineMode,
  TemplateSectionCodec,
} from './template-section-codec';

const logger = createLogger('TemplatePipeline');

export class TemplateTopologyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateTopologyError';
  }
}

export interface TopologySeed {
  /** Context keys the surrounding orchestrator provides before the codecs run. */
  readonly seededKeys?: readonly ImportContextKey[];
  /** Storage-state flags already satisfied before the codecs run. */
  readonly seededStates?: readonly StorageStateFlag[];
}

@Injectable()
export class TemplatePipeline {
  private readonly codecs: readonly TemplateSectionCodec[];

  constructor(@Optional() codecs: readonly TemplateSectionCodec[] = REPLACE_MODE_CODECS) {
    this.codecs = codecs;
    // Externally-seeded inputs the orchestrator provides before any codec runs:
    //  - `existingDataCleared` (replace path: clearExistingProjectData already ran),
    //  - `selectedProfilesByFamily` (family/provider resolution — a pre-pipeline concern),
    //  - `epicsLoaded` (the project's epics are queryable — preserved on replace, created
    //    in the create-core transaction — so scheduledEpics may resolve parent epic titles).
    TemplatePipeline.assertValidTopology(codecs, {
      seededKeys: ['selectedProfilesByFamily'],
      seededStates: ['existingDataCleared', 'epicsLoaded'],
    });
  }

  /**
   * Validate a codec array as a fixed pipeline ORDER. Rejects, with distinct errors:
   *  - duplicate section ids
   *  - dependency CYCLES (order-independent),
   *  - UNDECLARED reads (a read/required-state no codec produces and nothing seeds),
   *  - LATER-STAGE reads (a read satisfiable only by a codec that runs after it).
   *
   * Pure and static so unit tests can exercise it with synthetic codecs.
   */
  static assertValidTopology(
    codecs: readonly TemplateSectionCodec[],
    seed: TopologySeed = {},
  ): void {
    const seededKeys = new Set<string>(seed.seededKeys ?? []);
    const seededStates = new Set<string>(seed.seededStates ?? []);

    // --- duplicate section ids -------------------------------------------------
    const seenSections = new Set<string>();
    for (const codec of codecs) {
      const id = codec.declaration.section;
      if (seenSections.has(id)) {
        throw new TemplateTopologyError(`Duplicate codec section id: "${id}"`);
      }
      seenSections.add(id);
    }

    // --- producer indices for every key / state --------------------------------
    const keyWriters = new Map<string, number[]>();
    const stateProducers = new Map<string, number[]>();
    codecs.forEach((codec, i) => {
      for (const key of codec.declaration.writes) {
        keyWriters.set(key, [...(keyWriters.get(key) ?? []), i]);
      }
      for (const state of codec.declaration.producesState ?? []) {
        stateProducers.set(state, [...(stateProducers.get(state) ?? []), i]);
      }
    });

    // --- cycle detection (order-independent) -----------------------------------
    // Edge producer -> consumer for every satisfied read/required-state.
    const adjacency = new Map<number, Set<number>>();
    codecs.forEach((_, i) => adjacency.set(i, new Set()));
    const addEdges = (consumer: number, producers: number[] | undefined) => {
      for (const p of producers ?? []) {
        if (p !== consumer) adjacency.get(p)!.add(consumer);
      }
    };
    codecs.forEach((codec, i) => {
      for (const key of codec.declaration.reads) addEdges(i, keyWriters.get(key));
      for (const state of codec.declaration.requiresState ?? []) {
        addEdges(i, stateProducers.get(state));
      }
    });
    TemplatePipeline.assertAcyclic(codecs, adjacency);

    // --- undeclared + later-stage reads (against the given ORDER) --------------
    codecs.forEach((codec, i) => {
      const check = (
        dep: string,
        producers: number[] | undefined,
        seededSet: Set<string>,
        kind: 'read' | 'required state',
      ) => {
        if (seededSet.has(dep)) return;
        if (!producers || producers.length === 0) {
          throw new TemplateTopologyError(
            `Undeclared ${kind} "${dep}" for codec "${codec.declaration.section}": ` +
              `no codec produces it and it is not seeded`,
          );
        }
        if (!producers.some((p) => p < i)) {
          throw new TemplateTopologyError(
            `Later-stage ${kind} "${dep}" for codec "${codec.declaration.section}": ` +
              `only produced by a codec that runs after it`,
          );
        }
      };
      for (const key of codec.declaration.reads) {
        check(key, keyWriters.get(key), seededKeys, 'read');
      }
      for (const state of codec.declaration.requiresState ?? []) {
        check(state, stateProducers.get(state), seededStates, 'required state');
      }
    });
  }

  private static assertAcyclic(
    codecs: readonly TemplateSectionCodec[],
    adjacency: Map<number, Set<number>>,
  ): void {
    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;
    const color = new Array<number>(codecs.length).fill(WHITE);

    const visit = (node: number, stack: number[]): void => {
      color[node] = GRAY;
      stack.push(node);
      for (const next of adjacency.get(node) ?? []) {
        if (color[next] === GRAY) {
          const cycleStart = stack.indexOf(next);
          const path = [...stack.slice(cycleStart), next]
            .map((n) => codecs[n].declaration.section)
            .join(' -> ');
          throw new TemplateTopologyError(`Codec dependency cycle: ${path}`);
        }
        if (color[next] === WHITE) visit(next, stack);
      }
      stack.pop();
      color[node] = BLACK;
    };

    for (let i = 0; i < codecs.length; i++) {
      if (color[i] === WHITE) visit(i, []);
    }
  }

  /**
   * Apply the named sections, in registered (validated) order, into `ctx`. Codecs whose
   * section id is not requested, or that do not participate in `mode`, are skipped. Each
   * codec's runtime preconditions are re-checked defensively before it runs.
   */
  async applySections(
    sectionIds: readonly string[],
    payload: ParsedTemplatePayload,
    ctx: ImportContext,
    mode: PipelineMode,
    rt: CodecApplyRuntime,
  ): Promise<CodecApplyResult[]> {
    const requested = new Set(sectionIds);
    const results: CodecApplyResult[] = [];

    for (const codec of this.codecs) {
      const { declaration } = codec;
      if (!requested.has(declaration.section)) continue;
      if (!declaration.modes.includes(mode)) continue;

      for (const state of declaration.requiresState ?? []) ctx.requireState(state);
      // Data-product reads are additionally guarded at read time by ImportContext.get.

      const section = codec.pick(payload);
      const fatality = declaration.onFailure?.[mode] ?? 'fatal';
      let result: CodecApplyResult;
      try {
        result = await codec.apply(section, ctx, mode, rt);
      } catch (error) {
        // Declared non-fatal (e.g. create-mode teams, matrix row 13): log and continue so
        // a single section's failure does not abort the whole import. producesState is NOT
        // marked — the section did not complete. Fatal codecs propagate unchanged.
        if (fatality === 'swallow') {
          logger.warn(
            { section: declaration.section, mode, error },
            'Codec apply failed (declared non-fatal); continuing',
          );
          results.push({ section: declaration.section, log: { failedNonFatal: true } });
          continue;
        }
        throw error;
      }
      for (const state of declaration.producesState ?? []) ctx.markState(state);
      results.push(result);
    }

    return results;
  }
}
