import { Test, type TestingModule } from '@nestjs/testing';
import { HumanPromptStateService, sanitizeTmuxSessionName } from './human-prompt-state.service';

describe('HumanPromptStateService', () => {
  let service: HumanPromptStateService;
  let moduleRef: TestingModule;

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      providers: [HumanPromptStateService],
    }).compile();
    service = moduleRef.get(HumanPromptStateService);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await moduleRef.close();
  });

  it('starts inactive and increments generation for prompt text and an accepted clear', () => {
    expect(service.getState('tmux:session')).toEqual({
      phase: 'inactive',
      generation: 0,
      executedInputEpoch: 0,
      meaningfulOutputEpoch: 0,
    });

    const draft = service.recordPromptText('tmux:session');
    const cleared = service.transitionToAwaiting('tmuxsession', draft.generation);

    expect(draft).toEqual(expect.objectContaining({ phase: 'draft_active', generation: 1 }));
    expect(cleared).toEqual({
      accepted: true,
      state: expect.objectContaining({ phase: 'awaiting_stable_idle', generation: 2 }),
    });
  });

  it('rejects a stale clear without changing the current generation', () => {
    const first = service.recordPromptText('pane');
    const second = service.recordPromptText('pane');

    expect(service.transitionToAwaiting('pane', first.generation)).toEqual({
      accepted: false,
      state: second,
    });
    expect(service.getState('pane')).toBe(second);
  });

  it('tracks executed input and meaningful output on independent monotonic clocks', () => {
    service.recordExecutedInput('pane');
    service.recordExecutedInput('pane');
    service.recordMeaningfulOutput('pane');

    expect(service.getState('pane')).toEqual({
      phase: 'inactive',
      generation: 0,
      executedInputEpoch: 2,
      meaningfulOutputEpoch: 1,
    });
  });

  it('releases only an awaiting state whose generation and both epochs match', () => {
    const draft = service.recordPromptText('pane');
    service.transitionToAwaiting('pane', draft.generation);
    const snapshot = service.getQuietSnapshot('pane');
    expect(snapshot).not.toBeNull();

    service.recordMeaningfulOutput('pane');
    expect(service.releaseIfQuiet('pane', snapshot!)).toBe(false);
    expect(service.getState('pane').phase).toBe('awaiting_stable_idle');

    const current = service.getQuietSnapshot('pane');
    expect(service.releaseIfQuiet('pane', current!)).toBe(true);
    expect(service.getState('pane')).toEqual(
      expect.objectContaining({ phase: 'inactive', generation: 2 }),
    );
  });

  it.each([
    ['generation', (state: HumanPromptStateService) => state.recordPromptText('pane')],
    ['executed input', (state: HumanPromptStateService) => state.recordExecutedInput('pane')],
    ['meaningful output', (state: HumanPromptStateService) => state.recordMeaningfulOutput('pane')],
  ])('rejects a snapshot with a changed %s epoch', (_label, mutate) => {
    const draft = service.recordPromptText('pane');
    service.transitionToAwaiting('pane', draft.generation);
    const snapshot = service.getQuietSnapshot('pane');

    mutate(service);

    expect(service.releaseIfQuiet('pane', snapshot!)).toBe(false);
  });

  it('uses the same sanitizer for every operation', () => {
    expect(sanitizeTmuxSessionName('tmux: pane/$1')).toBe('tmuxpane1');
    service.recordPromptText('tmux: pane/$1');
    expect(service.getState('tmuxpane1').phase).toBe('draft_active');
  });

  it('clears an exactly tracked plain-text draft after matching Backspaces', () => {
    let state = service.recordPromptText('pane', 3);

    const first = service.recordControlInput('pane', state.generation, 'BSpace');
    expect(first).toEqual({
      accepted: true,
      cleared: false,
      state: expect.objectContaining({ phase: 'draft_active', generation: 2 }),
    });
    if (!first.accepted) throw new Error('Expected accepted Backspace');
    state = first.state as typeof state;

    const second = service.recordControlInput('pane', state.generation, 'BSpace');
    if (!second.accepted) throw new Error('Expected accepted Backspace');
    expect(second.cleared).toBe(false);

    const third = service.recordControlInput('pane', second.state.generation, 'BSpace');
    expect(third).toEqual({
      accepted: true,
      cleared: true,
      state: expect.objectContaining({ phase: 'awaiting_stable_idle', generation: 4 }),
    });
  });

  it('keeps an ambiguously tracked draft active after Backspace', () => {
    const draft = service.recordPromptText('pane');

    expect(service.recordControlInput('pane', draft.generation, 'BSpace')).toEqual({
      accepted: true,
      cleared: false,
      state: expect.objectContaining({ phase: 'draft_active', generation: 2 }),
    });
  });

  it('does not clear while the text write it would erase is still pending', () => {
    const draft = service.recordPromptText('pane', 1, true);

    expect(service.transitionToAwaiting('pane', draft.generation)).toEqual({
      accepted: false,
      state: draft,
    });
    const backspace = service.recordControlInput('pane', draft.generation, 'BSpace');
    expect(backspace).toEqual(
      expect.objectContaining({
        accepted: true,
        cleared: false,
        state: expect.objectContaining({ phase: 'draft_active' }),
      }),
    );
    service.confirmPromptTextWritten('pane', draft.generation);
    expect(service.getState('pane').phase).toBe('draft_active');
  });

  it('clears on a generation-contiguous double Escape for every provider', () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const draft = service.recordPromptText('pane', 4);
    const first = service.recordControlInput('pane', draft.generation, 'Escape');
    if (!first.accepted) throw new Error('Expected accepted Escape');
    expect(first.cleared).toBe(false);

    now.mockReturnValue(1_500);
    expect(service.recordControlInput('pane', first.state.generation, 'Escape')).toEqual({
      accepted: true,
      cleared: true,
      state: expect.objectContaining({ phase: 'awaiting_stable_idle' }),
    });
  });

  it('does not pair Escape presses across the timeout or intervening input', () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const draft = service.recordPromptText('pane', 4);
    const first = service.recordControlInput('pane', draft.generation, 'Escape');
    if (!first.accepted) throw new Error('Expected accepted Escape');

    now.mockReturnValue(2_100);
    const expired = service.recordControlInput('pane', first.state.generation, 'Escape');
    if (!expired.accepted) throw new Error('Expected accepted Escape');
    expect(expired.cleared).toBe(false);

    const text = service.recordPromptText('pane', 1);
    now.mockReturnValue(2_200);
    const afterText = service.recordControlInput('pane', text.generation, 'Escape');
    expect(afterText).toEqual(expect.objectContaining({ accepted: true, cleared: false }));
  });

  it('treats Ctrl+C as clear only for Codex', () => {
    const codexDraft = service.recordPromptText('codex-pane', 3);
    expect(service.recordControlInput('codex-pane', codexDraft.generation, 'C-c', 'codex')).toEqual(
      expect.objectContaining({
        accepted: true,
        cleared: true,
        state: expect.objectContaining({ phase: 'awaiting_stable_idle' }),
      }),
    );

    const claudeDraft = service.recordPromptText('claude-pane', 3);
    expect(
      service.recordControlInput('claude-pane', claudeDraft.generation, 'C-c', 'claude'),
    ).toEqual(
      expect.objectContaining({
        accepted: true,
        cleared: false,
        state: expect.objectContaining({ phase: 'draft_active' }),
      }),
    );
  });

  it('exposes manual release only after 30 seconds without newer human input', () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(10_000);
    const draft = service.recordPromptText('pane', 2);
    expect(service.getManualReleaseEligibleAt('pane')).toBe(40_000);

    now.mockReturnValue(25_000);
    const activity = service.recordControlInput('pane', draft.generation, 'Left');
    expect(activity).toEqual(expect.objectContaining({ accepted: true, cleared: false }));
    expect(service.getManualReleaseEligibleAt('pane')).toBe(55_000);
  });
});
