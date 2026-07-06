/**
 * Registry of template section codecs, in pipeline order. The array order IS the
 * execution order the pipeline validates topologically at module init: each codec's
 * declared reads must be satisfiable by a codec earlier in this list (or seeded by the
 * orchestrator). Add a codec = add a file + one entry here.
 *
 * This task migrates the four low-risk sections (statuses, prompts, providerModels,
 * providerEfforts) under REPLACE mode only; later tasks append profiles/agents/teams/etc.
 */
import { statusesCodec } from './codecs/statuses.codec';
import { promptsCodec } from './codecs/prompts.codec';
import { profilesCodec } from './codecs/profiles.codec';
import { agentsCodec } from './codecs/agents.codec';
import { watchersCodec } from './codecs/watchers.codec';
import { subscribersCodec } from './codecs/subscribers.codec';
import { teamsCodec } from './codecs/teams.codec';
import { scheduledEpicsCodec } from './codecs/scheduled-epics.codec';
import { projectSettingsCodec } from './codecs/project-settings.codec';
import { presetsCodec } from './codecs/presets.codec';
import { providerSettingsCodec } from './codecs/provider-settings.codec';
import { providerModelsCodec } from './codecs/provider-models.codec';
import { providerEffortsCodec } from './codecs/provider-efforts.codec';
import type { TemplateSectionCodec } from './template-section-codec';

/**
 * Codecs participating in the replace-into-existing flow, in execution order. The order
 * is the validated topological order: profiles (writes profileIdMap + profileNameToId +
 * configLookupMap) MUST precede agents (reads profileIdMap + configLookupMap) and watchers
 * (reads agentNameToId + profileNameToId); teams reads all of profiles'/agents' maps and
 * requiresState `agentsPersisted`; scheduledEpics reads agentNameToId + the statuses map and
 * requiresState `epicsLoaded`; projectSettings reads createdPrompts/promptIdMap (prompts) and
 * templateLabelToStatusId (statuses); providerSettings reads nothing (resolved against live
 * provider storage). Stage numbers track docs/template-roundtrip-compatibility-matrix.md.
 */
export const REPLACE_MODE_CODECS: readonly TemplateSectionCodec[] = [
  statusesCodec,
  promptsCodec,
  profilesCodec,
  agentsCodec,
  watchersCodec,
  subscribersCodec,
  teamsCodec,
  scheduledEpicsCodec,
  projectSettingsCodec,
  presetsCodec,
  providerSettingsCodec,
  providerModelsCodec,
  providerEffortsCodec,
];

/** Section ids that currently flow through the pipeline (replace mode). */
export const MIGRATED_REPLACE_SECTIONS = REPLACE_MODE_CODECS.map((c) => c.declaration.section);
