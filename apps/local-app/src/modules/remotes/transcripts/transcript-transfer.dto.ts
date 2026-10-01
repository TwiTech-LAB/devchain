import { z } from 'zod';

const uuid = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const claudeRef = `[A-Za-z0-9-]+/${uuid}`;
const codexFile = '\\d{4}/\\d{2}/\\d{2}/rollout-[A-Za-z0-9_-]+\\.jsonl';
/** File-name pattern for each folder that sits next to a Claude session transcript. */
const claudeCompanions = {
  subagents: 'agent-[A-Za-z0-9_-]+\\.jsonl',
  'tool-results': '[A-Za-z0-9_-][A-Za-z0-9_.-]*',
};
export const CLAUDE_COMPANION_FOLDERS = Object.keys(claudeCompanions);
const claudeFile = Object.entries(claudeCompanions)
  .map(([folder, name]) => `/${folder}/${name}`)
  .concat('\\.jsonl')
  .join('|');

// JavaScript `$` without the `m` flag matches only at the end of the input.
const codexSchema = z
  .object({ provider: z.literal('codex'), path: z.string().regex(new RegExp(`^${codexFile}$`)) })
  .strict();

export const TranscriptRefSchema = z.discriminatedUnion('provider', [
  z
    .object({ provider: z.literal('claude'), path: z.string().regex(new RegExp(`^${claudeRef}$`)) })
    .strict(),
  codexSchema,
]);
export const TranscriptFileSchema = z.discriminatedUnion('provider', [
  z
    .object({
      provider: z.literal('claude'),
      path: z.string().regex(new RegExp(`^${claudeRef}(${claudeFile})$`)),
    })
    .strict(),
  codexSchema,
]);
export const TranscriptListRequestSchema = z
  .object({ refs: z.array(TranscriptRefSchema).max(10000) })
  .strict();
export const TranscriptListingSchema = z.object({
  files: z.array(z.object({ file: TranscriptFileSchema, size: z.number().int().nonnegative() })),
  missing: z.number().int().nonnegative(),
});
export type TranscriptRef = z.infer<typeof TranscriptRefSchema>;
export type TranscriptFile = z.infer<typeof TranscriptFileSchema>;
export type TranscriptListing = z.infer<typeof TranscriptListingSchema>;
export interface TranscriptTransferDetails {
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  /** Recorded transcripts absent on the side the files are copied from. */
  missing: number;
  /** Session records whose transcript path cannot be copied (see `projectRefs`). */
  skipped: number;
}
export const TRANSCRIPT_MAX_BYTES = 1024 ** 3;
export const TRANSCRIPT_TIMEOUT_MS = 5 * 60_000;
