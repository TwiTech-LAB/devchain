import { Injectable } from '@nestjs/common';

interface HumanPromptStateBase {
  readonly generation: number;
  readonly executedInputEpoch: number;
  readonly meaningfulOutputEpoch: number;
}

export interface InactiveHumanPromptState extends HumanPromptStateBase {
  readonly phase: 'inactive';
}

export interface DraftActiveHumanPromptState extends HumanPromptStateBase {
  readonly phase: 'draft_active';
}

export interface AwaitingStableIdleHumanPromptState extends HumanPromptStateBase {
  readonly phase: 'awaiting_stable_idle';
}

export type HumanPromptState =
  | InactiveHumanPromptState
  | DraftActiveHumanPromptState
  | AwaitingStableIdleHumanPromptState;

export interface HumanPromptQuietSnapshot {
  readonly expectedGeneration: number;
  readonly executedInputEpoch: number;
  readonly meaningfulOutputEpoch: number;
}

export interface ForcePromptSnapshot {
  readonly phase: 'awaiting_stable_idle' | 'inactive';
  readonly generation: number;
  readonly executedInputEpoch: number;
}

export type PromptAwaitingTransitionResult =
  | { readonly accepted: true; readonly state: AwaitingStableIdleHumanPromptState }
  | { readonly accepted: false; readonly state: HumanPromptState };

export type PromptControlInputResult =
  | {
      readonly accepted: true;
      readonly cleared: boolean;
      readonly state: DraftActiveHumanPromptState | AwaitingStableIdleHumanPromptState;
    }
  | { readonly accepted: false; readonly state: HumanPromptState };

interface DraftTrackingState {
  readonly exactCharacterCount: number | null;
  readonly inputWritePending: boolean;
  readonly lastHumanInputAt: number;
  readonly lastEscapeAt: number | null;
  readonly lastEscapeGeneration: number | null;
}

export const HUMAN_DRAFT_MANUAL_RELEASE_DELAY_MS = 30_000;
export const DOUBLE_ESCAPE_CLEAR_WINDOW_MS = 1_000;

const INITIAL_STATE: InactiveHumanPromptState = Object.freeze({
  phase: 'inactive',
  generation: 0,
  executedInputEpoch: 0,
  meaningfulOutputEpoch: 0,
});

export function sanitizeTmuxSessionName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, '');
}

@Injectable()
export class HumanPromptStateService {
  private readonly states = new Map<string, HumanPromptState>();
  private readonly draftTracking = new Map<string, DraftTrackingState>();

  getState(tmuxSessionName: string): HumanPromptState {
    return this.states.get(this.keyFor(tmuxSessionName)) ?? INITIAL_STATE;
  }

  recordPromptText(
    tmuxSessionName: string,
    plainTextCharacterCount?: number,
    inputWritePending = false,
  ): DraftActiveHumanPromptState {
    const key = this.keyFor(tmuxSessionName);
    const current = this.getState(tmuxSessionName);
    const currentTracking = this.draftTracking.get(key);
    const exactCharacterCount = nextExactCharacterCount(
      current,
      currentTracking,
      plainTextCharacterCount,
    );
    const next: DraftActiveHumanPromptState = {
      ...current,
      phase: 'draft_active',
      generation: nextEpoch(current.generation),
    };
    this.states.set(key, next);
    this.draftTracking.set(key, {
      exactCharacterCount,
      inputWritePending,
      lastHumanInputAt: Date.now(),
      lastEscapeAt: null,
      lastEscapeGeneration: null,
    });
    return next;
  }

  recordControlInput(
    tmuxSessionName: string,
    expectedGeneration: number,
    tmuxKey: string,
    providerName?: string | null,
  ): PromptControlInputResult {
    const key = this.keyFor(tmuxSessionName);
    const current = this.states.get(key) ?? INITIAL_STATE;
    if (current.phase !== 'draft_active' || current.generation !== expectedGeneration) {
      return { accepted: false, state: current };
    }

    const now = Date.now();
    const tracking = this.draftTracking.get(key) ?? {
      exactCharacterCount: null,
      inputWritePending: false,
      lastHumanInputAt: now,
      lastEscapeAt: null,
      lastEscapeGeneration: null,
    };
    const isDoubleEscape =
      tmuxKey === 'Escape' &&
      tracking.lastEscapeGeneration === current.generation &&
      tracking.lastEscapeAt !== null &&
      now - tracking.lastEscapeAt <= DOUBLE_ESCAPE_CLEAR_WINDOW_MS;
    const isCodexClear = tmuxKey === 'C-c' && providerName?.toLowerCase() === 'codex';

    if (
      !tracking.inputWritePending &&
      (isDoubleEscape ||
        isCodexClear ||
        (tmuxKey === 'BSpace' && tracking.exactCharacterCount === 1))
    ) {
      const next = this.moveToAwaiting(key, current);
      return { accepted: true, cleared: true, state: next };
    }

    const next: DraftActiveHumanPromptState = {
      ...current,
      generation: nextEpoch(current.generation),
    };
    this.states.set(key, next);
    this.draftTracking.set(key, {
      exactCharacterCount:
        tmuxKey === 'BSpace' && tracking.exactCharacterCount !== null
          ? Math.max(0, tracking.exactCharacterCount - 1)
          : null,
      inputWritePending: tracking.inputWritePending,
      lastHumanInputAt: now,
      lastEscapeAt: tmuxKey === 'Escape' ? now : null,
      lastEscapeGeneration: tmuxKey === 'Escape' ? next.generation : null,
    });
    return { accepted: true, cleared: false, state: next };
  }

  transitionToAwaiting(
    tmuxSessionName: string,
    expectedGeneration: number,
    allowPendingWrite = false,
  ): PromptAwaitingTransitionResult {
    const key = this.keyFor(tmuxSessionName);
    const current = this.states.get(key) ?? INITIAL_STATE;
    const tracking = this.draftTracking.get(key);
    if (
      current.phase !== 'draft_active' ||
      current.generation !== expectedGeneration ||
      (!allowPendingWrite && tracking?.inputWritePending === true)
    ) {
      return { accepted: false, state: current };
    }

    const next = this.moveToAwaiting(key, current);
    return { accepted: true, state: next };
  }

  confirmPromptTextWritten(tmuxSessionName: string, expectedGeneration: number): HumanPromptState {
    const key = this.keyFor(tmuxSessionName);
    const current = this.states.get(key) ?? INITIAL_STATE;
    const tracking = this.draftTracking.get(key);
    if (
      current.phase !== 'draft_active' ||
      current.generation !== expectedGeneration ||
      !tracking
    ) {
      return current;
    }
    this.draftTracking.set(key, { ...tracking, inputWritePending: false });
    return current;
  }

  getManualReleaseEligibleAt(
    tmuxSessionName: string,
    delayMs = HUMAN_DRAFT_MANUAL_RELEASE_DELAY_MS,
  ): number | null {
    const key = this.keyFor(tmuxSessionName);
    const current = this.states.get(key) ?? INITIAL_STATE;
    const tracking = this.draftTracking.get(key);
    if (current.phase !== 'draft_active' || !tracking) return null;
    return tracking.lastHumanInputAt + delayMs;
  }

  recordExecutedInput(tmuxSessionName: string): HumanPromptState {
    return this.updateEpoch(tmuxSessionName, 'executedInputEpoch');
  }

  recordMeaningfulOutput(tmuxSessionName: string): HumanPromptState {
    return this.updateEpoch(tmuxSessionName, 'meaningfulOutputEpoch');
  }

  getQuietSnapshot(tmuxSessionName: string): HumanPromptQuietSnapshot | null {
    const current = this.getState(tmuxSessionName);
    if (current.phase !== 'awaiting_stable_idle') return null;
    return {
      expectedGeneration: current.generation,
      executedInputEpoch: current.executedInputEpoch,
      meaningfulOutputEpoch: current.meaningfulOutputEpoch,
    };
  }

  releaseIfQuiet(tmuxSessionName: string, snapshot: HumanPromptQuietSnapshot): boolean {
    const key = this.keyFor(tmuxSessionName);
    const current = this.states.get(key) ?? INITIAL_STATE;
    if (
      current.phase !== 'awaiting_stable_idle' ||
      current.generation !== snapshot.expectedGeneration ||
      current.executedInputEpoch !== snapshot.executedInputEpoch ||
      current.meaningfulOutputEpoch !== snapshot.meaningfulOutputEpoch
    ) {
      return false;
    }

    const next: InactiveHumanPromptState = { ...current, phase: 'inactive' };
    this.states.set(key, next);
    this.draftTracking.delete(key);
    return true;
  }

  getForceSnapshot(tmuxSessionName: string): ForcePromptSnapshot | null {
    const current = this.getState(tmuxSessionName);
    if (current.phase === 'draft_active') return null;
    return {
      phase: current.phase,
      generation: current.generation,
      executedInputEpoch: current.executedInputEpoch,
    };
  }

  applyForceDelivery(tmuxSessionName: string, snapshot: ForcePromptSnapshot): boolean {
    const key = this.keyFor(tmuxSessionName);
    const current = this.states.get(key) ?? INITIAL_STATE;
    if (
      current.phase === 'draft_active' ||
      current.phase !== snapshot.phase ||
      current.generation !== snapshot.generation ||
      current.executedInputEpoch !== snapshot.executedInputEpoch
    ) {
      return false;
    }

    if (current.phase === 'awaiting_stable_idle') {
      const next: InactiveHumanPromptState = { ...current, phase: 'inactive' };
      this.states.set(key, next);
      this.draftTracking.delete(key);
    }
    return true;
  }

  clearSession(tmuxSessionName: string): void {
    const key = this.keyFor(tmuxSessionName);
    this.states.delete(key);
    this.draftTracking.delete(key);
  }

  clear(): void {
    this.states.clear();
    this.draftTracking.clear();
  }

  private updateEpoch(
    tmuxSessionName: string,
    epoch: 'executedInputEpoch' | 'meaningfulOutputEpoch',
  ): HumanPromptState {
    const key = this.keyFor(tmuxSessionName);
    const current = this.states.get(key) ?? INITIAL_STATE;
    const next = { ...current, [epoch]: nextEpoch(current[epoch]) } satisfies HumanPromptState;
    this.states.set(key, next);
    return next;
  }

  private moveToAwaiting(
    key: string,
    current: DraftActiveHumanPromptState,
  ): AwaitingStableIdleHumanPromptState {
    const next: AwaitingStableIdleHumanPromptState = {
      ...current,
      phase: 'awaiting_stable_idle',
      generation: nextEpoch(current.generation),
    };
    this.states.set(key, next);
    this.draftTracking.delete(key);
    return next;
  }

  private keyFor(tmuxSessionName: string): string {
    const key = sanitizeTmuxSessionName(tmuxSessionName);
    if (!key) throw new Error('Tmux session name must contain at least one safe character');
    return key;
  }
}

function nextEpoch(current: number): number {
  if (!Number.isSafeInteger(current) || current === Number.MAX_SAFE_INTEGER) {
    throw new Error('Human prompt epoch exhausted');
  }
  return current + 1;
}

function nextExactCharacterCount(
  current: HumanPromptState,
  tracking: DraftTrackingState | undefined,
  addedCharacters: number | undefined,
): number | null {
  if (addedCharacters === undefined) return null;
  if (current.phase !== 'draft_active') return addedCharacters;
  if (tracking?.exactCharacterCount === null || tracking?.exactCharacterCount === undefined) {
    return null;
  }
  return tracking.exactCharacterCount + addedCharacters;
}
