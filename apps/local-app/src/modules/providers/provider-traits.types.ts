export interface ProviderTraits {
  /**
   * Which evidence drives busy and idle:
   * - `hook-and-transcript`: `UserPromptSubmit` / `Stop` hooks and transcript turn evidence.
   *   Output never starts busy once any evidence arrived.
   * - `transcript`: transcript turn evidence (open / complete), plus output.
   * - `stop-hook`: output, and the `Stop` hook ends the turn.
   * - `output`: output only; idle is inferred from silence.
   */
  readonly activity: 'hook-and-transcript' | 'transcript' | 'stop-hook' | 'output';
  readonly transcriptTurns: boolean;
  readonly draftClearKeys: readonly string[];
}
