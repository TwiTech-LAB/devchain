import { act, fireEvent, render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import {
  EpicRelationBadges,
  RELATION_PREVIEW_CLOSE_DELAY_MS,
  RELATION_PREVIEW_OPEN_DELAY_MS,
} from '@/ui/components/board/EpicRelationBadges';
import type { EpicRelationCounts } from '@/ui/hooks/useEpicRelationCountsBatch';
import type { EpicRelation } from '@/ui/lib/epic-relations';

// Layer: component unit. The data hook, worktree runtime, and project
// selection are stubbed because this spec owns resting-badge presentation, the
// hover/keyboard/touch mode machine, the card drag fence, the preview's
// rendering states over the first detail page, and the title navigation and
// focus contract.
const useEpicRelationsMock = jest.fn();
jest.mock('@/ui/hooks/useEpicRelations', () => ({
  useEpicRelations: (...args: unknown[]) => useEpicRelationsMock(...args),
}));

const mockProjectSelection = {
  selectedWorkspace: { id: 'workspace-1', name: 'Workspace One' },
  activateProject: jest.fn(),
};

jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => mockProjectSelection,
}));

const worktreeRuntime = {
  activeWorktree: null,
  setActiveWorktree: () => undefined,
  apiBase: '',
  worktrees: [],
  worktreesLoading: false,
  runtimeResolved: true,
};

jest.mock('@/ui/hooks/useWorktreeTab', () => ({
  useOptionalWorktreeTab: () => worktreeRuntime,
}));

function relationTarget(id: string, title: string, projectName = 'Current Project') {
  return {
    id,
    shortId: id.slice(0, 8),
    title,
    status: { id: 'status-1', label: 'In Progress', color: '#2563eb' },
    project: { id: 'project-1', name: projectName },
  };
}

function crossProjectRelationTarget(id: string, title: string, projectName: string) {
  return {
    ...relationTarget(id, title, projectName),
    project: { id: 'project-2', name: projectName },
  };
}

function relationRow(
  relationId: string,
  type: EpicRelation['type'],
  sourceEpicId: string | null,
  targetEpicId: string | null,
  id: string,
  title: string,
): EpicRelation {
  return {
    relationId,
    type,
    sourceEpicId,
    targetEpicId,
    relatedEpic: relationTarget(id, title),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const FOCAL_ID = 'epic-focal';
// Directed row whose counterpart (Design API) is the stored source.
const sourceRow = relationRow(
  'rel-1',
  'related',
  'epic-design',
  FOCAL_ID,
  'epic-design',
  'Design API',
);
// Directed row whose counterpart (Ship CLI) is the stored target.
const targetRow = relationRow('rel-2', 'related', FOCAL_ID, 'epic-ship', 'epic-ship', 'Ship CLI');
const neutralRow = relationRow('rel-3', 'related', null, null, 'epic-docs', 'Write docs');
const blocksRow = relationRow('rel-4', 'blocks', FOCAL_ID, 'epic-qa', 'epic-qa', 'QA suite');
const blockedByRow = relationRow('rel-5', 'blocked_by', 'epic-ops', FOCAL_ID, 'epic-ops', 'Ops');
// Related counterpart that lives in another project of the same workspace.
const crossProjectRow: EpicRelation = {
  relationId: 'rel-cross',
  type: 'related',
  sourceEpicId: FOCAL_ID,
  targetEpicId: 'epic-remote',
  relatedEpic: crossProjectRelationTarget('epic-remote', 'Remote Epic', 'Other Project'),
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function mockQuery(overrides: Record<string, unknown> = {}) {
  useEpicRelationsMock.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    ...overrides,
  });
}

function countsFixture(overrides: Partial<EpicRelationCounts> = {}): EpicRelationCounts {
  return { related: 0, blocks: 0, blockedBy: 0, total: 0, ...overrides };
}

interface RenderOptions {
  counts?: EpicRelationCounts;
  epicId?: string;
  epicTitle?: string;
  focalProjectId?: string;
  dragFenceRef?: { current: boolean };
  isDragging?: boolean;
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="current-location">{`${location.pathname}${location.search}`}</div>;
}

function badgesTree({
  counts,
  epicId,
  epicTitle,
  focalProjectId = 'project-1',
  dragFenceRef,
  isDragging,
}: Required<Pick<RenderOptions, 'epicId' | 'epicTitle'>> & RenderOptions) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={['/board']}>
        <main>
          <Routes>
            <Route
              path="/board"
              element={
                <EpicRelationBadges
                  counts={counts ?? countsFixture()}
                  epicId={epicId}
                  epicTitle={epicTitle}
                  focalProjectId={focalProjectId}
                  dragFenceRef={dragFenceRef}
                  isDragging={isDragging}
                />
              }
            />
            <Route path="/epics/:id" element={<div data-testid="epic-route" />} />
          </Routes>
          <LocationProbe />
        </main>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function renderBadges({
  counts = countsFixture(),
  epicId = FOCAL_ID,
  epicTitle = 'Focal Epic',
  focalProjectId = 'project-1',
  dragFenceRef,
  isDragging,
}: RenderOptions = {}) {
  return render(
    badgesTree({ counts, epicId, epicTitle, focalProjectId, dragFenceRef, isDragging }),
  );
}

function currentLocation(): string {
  return screen.getByTestId('current-location').textContent ?? '';
}

function trigger(): HTMLElement {
  return screen.getByTestId('epic-relation-badges');
}

type PointerType = 'mouse' | 'touch' | 'pen';

// jsdom has no PointerEvent constructor, so fireEvent's pointer aliases drop
// pointerType and button from the init. A MouseEvent carrying the pointer
// fields as own properties reaches React handlers with the real shape.
function firePointer(
  element: HTMLElement,
  type: 'pointerover' | 'pointerout' | 'pointerdown' | 'pointerup' | 'pointercancel',
  init: {
    pointerType: PointerType;
    button?: number;
    pointerId?: number;
    relatedTarget?: EventTarget | null;
  },
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: init.button ?? 0,
    relatedTarget: init.relatedTarget ?? null,
  });
  Object.assign(event, {
    pointerType: init.pointerType,
    pointerId: init.pointerId ?? 1,
  });
  fireEvent(element, event);
}

function previewHeading(): HTMLElement {
  return screen.getByRole('heading', { name: 'Relations for Focal Epic' });
}

function hoverOpen() {
  firePointer(trigger(), 'pointerover', { pointerType: 'mouse', relatedTarget: document.body });
  act(() => {
    jest.advanceTimersByTime(RELATION_PREVIEW_OPEN_DELAY_MS);
  });
}

function touchActivate() {
  firePointer(trigger(), 'pointerdown', { pointerType: 'touch', button: 0, pointerId: 5 });
  fireEvent.focus(trigger());
  fireEvent.click(trigger());
}

function firstPage(items: EpicRelation[], total = items.length) {
  return { data: { pages: [{ items, total, limit: 20, offset: 0 }], pageParams: [0] } };
}

function relatedCounts(related: number, extra: Partial<EpicRelationCounts> = {}) {
  return countsFixture({ related, total: related, relatedSources: related, ...extra });
}

function openKeyboardPreview() {
  trigger().focus();
  fireEvent.focus(trigger());
}

function enterPreview() {
  fireEvent.keyDown(trigger(), { key: 'Enter' });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery();
  worktreeRuntime.runtimeResolved = true;
  worktreeRuntime.apiBase = '';
  mockProjectSelection.selectedWorkspace = { id: 'workspace-1', name: 'Workspace One' };
});

describe('EpicRelationBadges resting badge', () => {
  it('renders the source piece with a hidden arrow and an explicit accessible label', () => {
    renderBadges({
      counts: countsFixture({
        related: 1,
        total: 1,
        relatedSources: 1,
        relatedTargets: 0,
        relatedNeutral: 0,
      }),
    });

    const piece = screen.getByTitle(/Related sources: 1\./);
    expect(piece).toHaveTextContent('1');
    expect(piece.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(trigger()).toHaveAccessibleName('Related: 1 source.');
  });

  it('renders the target piece and both roles together', () => {
    renderBadges({
      counts: countsFixture({
        related: 3,
        total: 3,
        relatedSources: 2,
        relatedTargets: 1,
        relatedNeutral: 0,
      }),
    });

    expect(screen.getByTitle(/Related sources: 2\./)).toBeInTheDocument();
    expect(screen.getByTitle(/Related targets: 1\./)).toBeInTheDocument();
    expect(trigger()).toHaveAccessibleName('Related: 2 sources, 1 target.');
  });

  it('renders the neutral piece with the exact mandated title', () => {
    renderBadges({
      counts: countsFixture({
        related: 1,
        total: 1,
        relatedSources: 0,
        relatedTargets: 0,
        relatedNeutral: 1,
      }),
    });

    expect(screen.getByTitle('Related without direction: 1')).toBeInTheDocument();
    expect(trigger()).toHaveAccessibleName('Related: 1 without direction.');
  });

  it('never renders zero directional pieces and keeps separate blocks counts', () => {
    renderBadges({
      counts: countsFixture({
        related: 2,
        blocks: 1,
        blockedBy: 3,
        total: 6,
        relatedSources: 2,
        relatedTargets: 0,
        relatedNeutral: 0,
      }),
    });

    expect(screen.queryByTitle(/Related targets:/)).not.toBeInTheDocument();
    expect(screen.queryByTitle('Related without direction: 0')).not.toBeInTheDocument();
    expect(screen.getByText('Blocks 1')).toBeInTheDocument();
    expect(screen.getByText('Blocked by 3')).toBeInTheDocument();
    expect(trigger()).toHaveAccessibleName('Related: 2 sources. Blocks: 1. Blocked by: 3.');
  });

  it('falls back to the plain aggregate when directional fields are unavailable', () => {
    renderBadges({ counts: countsFixture({ related: 2, blockedBy: 1, total: 3 }) });

    expect(screen.getByText('Related 2')).toBeInTheDocument();
    expect(screen.queryByTitle(/Related sources/)).not.toBeInTheDocument();
    expect(trigger()).toHaveAccessibleName('Related: 2. Blocked by: 1.');
  });

  it('renders no Related piece or label when only legacy Blocks and Blocked by are nonzero', () => {
    renderBadges({ counts: countsFixture({ related: 0, blocks: 1, blockedBy: 2, total: 3 }) });

    expect(screen.queryByText(/Related/)).not.toBeInTheDocument();
    expect(screen.getByText('Blocks 1')).toBeInTheDocument();
    expect(screen.getByText('Blocked by 2')).toBeInTheDocument();
    expect(trigger()).toHaveAccessibleName('Blocks: 1. Blocked by: 2.');
  });

  it('renders no Related label for an all-zero directional group with only Blocks nonzero', () => {
    renderBadges({
      counts: countsFixture({
        related: 0,
        blocks: 1,
        total: 1,
        relatedSources: 0,
        relatedTargets: 0,
        relatedNeutral: 0,
      }),
    });

    expect(screen.queryByText(/Related/)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/Related sources/)).not.toBeInTheDocument();
    expect(screen.getByText('Blocks 1')).toBeInTheDocument();
    expect(trigger()).toHaveAccessibleName('Blocks: 1.');
  });

  it('keeps the outside-board hint on the trigger and renders nothing for all-zero counts', () => {
    const { rerender } = renderBadges({ counts: countsFixture({ total: 0 }) });
    expect(screen.queryByTestId('epic-relation-badges')).not.toBeInTheDocument();

    rerender(
      badgesTree({
        counts: countsFixture({
          related: 2,
          total: 2,
          relatedSources: 1,
          relatedTargets: 1,
          relatedNeutral: 0,
        }),
        epicId: FOCAL_ID,
        epicTitle: 'Focal Epic',
      }),
    );
    expect(trigger()).toHaveAttribute(
      'title',
      expect.stringContaining('outside the current board'),
    );
  });

  it('passes composed accessibility checks while closed', async () => {
    const { container } = renderBadges({
      counts: countsFixture({ related: 2, blocks: 1, total: 3 }),
    });
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('EpicRelationBadges interaction modes', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('opens on mouse hover only after the named delay and never moves focus', () => {
    renderBadges({
      counts: countsFixture({
        related: 1,
        total: 1,
        relatedSources: 0,
        relatedTargets: 1,
        relatedNeutral: 0,
      }),
    });
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');

    firePointer(trigger(), 'pointerover', { pointerType: 'mouse', relatedTarget: document.body });
    act(() => {
      jest.advanceTimersByTime(RELATION_PREVIEW_OPEN_DELAY_MS - 1);
    });
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    expect(previewHeading()).toBeInTheDocument();
    expect(document.activeElement).toBe(document.body);
  });

  it('closes after the pointer leaves trigger and content for the close delay', () => {
    renderBadges({
      counts: countsFixture({
        related: 1,
        total: 1,
        relatedSources: 1,
        relatedTargets: 0,
        relatedNeutral: 0,
      }),
    });
    hoverOpen();

    firePointer(trigger(), 'pointerout', {
      pointerType: 'mouse',
      relatedTarget: screen.getByRole('dialog'),
    });
    act(() => {
      jest.advanceTimersByTime(RELATION_PREVIEW_CLOSE_DELAY_MS - 1);
    });
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps the preview open while the pointer transfers between trigger and content', () => {
    renderBadges({
      counts: countsFixture({
        related: 1,
        total: 1,
        relatedSources: 1,
        relatedTargets: 0,
        relatedNeutral: 0,
      }),
    });
    hoverOpen();
    const content = screen.getByRole('dialog');

    firePointer(trigger(), 'pointerout', { pointerType: 'mouse', relatedTarget: content });
    act(() => {
      jest.advanceTimersByTime(RELATION_PREVIEW_CLOSE_DELAY_MS - 1);
    });
    firePointer(content, 'pointerover', { pointerType: 'mouse', relatedTarget: trigger() });
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');

    // Leaving the content restarts the close countdown; the trigger clears it.
    firePointer(content, 'pointerout', { pointerType: 'mouse', relatedTarget: document.body });
    act(() => {
      jest.advanceTimersByTime(100);
    });
    firePointer(trigger(), 'pointerover', { pointerType: 'mouse', relatedTarget: document.body });
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
  });

  it('never closes or pins a hover-open preview on mouse click', () => {
    renderBadges({
      counts: countsFixture({
        related: 1,
        total: 1,
        relatedSources: 1,
        relatedTargets: 0,
        relatedNeutral: 0,
      }),
    });
    hoverOpen();

    firePointer(trigger(), 'pointerdown', { pointerType: 'mouse', button: 0, pointerId: 2 });
    fireEvent.click(trigger());
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
  });

  it('opens once on keyboard focus; Enter and Space keep it open and Escape closes with focus retained', () => {
    renderBadges({
      counts: countsFixture({
        related: 1,
        total: 1,
        relatedSources: 1,
        relatedTargets: 0,
        relatedNeutral: 0,
      }),
    });
    trigger().focus();
    fireEvent.focus(trigger());
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    // Focus events without a pointer-down never re-trigger the transition.
    fireEvent.focus(trigger());
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');

    fireEvent.keyDown(trigger(), { key: 'Enter' });
    fireEvent.keyDown(trigger(), { key: ' ' });
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');

    fireEvent.keyDown(trigger(), { key: 'Escape' });
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(trigger()).toHaveFocus();
  });

  it('opens touch mode on the first full activation and closes on the second', () => {
    renderBadges({
      counts: countsFixture({
        related: 1,
        total: 1,
        relatedSources: 1,
        relatedTargets: 0,
        relatedNeutral: 0,
      }),
    });

    // Pointer-induced focus must not open keyboard mode before the click.
    firePointer(trigger(), 'pointerdown', { pointerType: 'touch', button: 0, pointerId: 5 });
    fireEvent.focus(trigger());
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(trigger());
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    expect(previewHeading()).toBeInTheDocument();

    touchActivate();
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes and suppresses the preview while the card drag is armed', () => {
    const { rerender } = renderBadges({
      counts: countsFixture({
        related: 1,
        total: 1,
        relatedSources: 1,
        relatedTargets: 0,
        relatedNeutral: 0,
      }),
    });
    trigger().focus();
    fireEvent.focus(trigger());
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');

    rerender(
      badgesTree({
        counts: countsFixture({
          related: 1,
          total: 1,
          relatedSources: 1,
          relatedTargets: 0,
          relatedNeutral: 0,
        }),
        epicId: FOCAL_ID,
        epicTitle: 'Focal Epic',
        isDragging: true,
      }),
    );
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');

    // A hover attempt while dragging stays closed.
    firePointer(trigger(), 'pointerover', { pointerType: 'mouse', relatedTarget: document.body });
    act(() => {
      jest.advanceTimersByTime(RELATION_PREVIEW_OPEN_DELAY_MS);
    });
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps one pointer-open preview during card-to-card movement', () => {
    const counts = countsFixture({
      related: 1,
      total: 1,
      relatedSources: 1,
      relatedTargets: 0,
      relatedNeutral: 0,
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <EpicRelationBadges
            counts={counts}
            epicId="epic-a"
            epicTitle="Epic A"
            focalProjectId="project-1"
          />
          <EpicRelationBadges
            counts={counts}
            epicId="epic-b"
            epicTitle="Epic B"
            focalProjectId="project-1"
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const [first, second] = screen.getAllByTestId('epic-relation-badges');

    firePointer(first, 'pointerover', { pointerType: 'mouse', relatedTarget: document.body });
    act(() => {
      jest.advanceTimersByTime(RELATION_PREVIEW_OPEN_DELAY_MS);
    });
    expect(first).toHaveAttribute('aria-expanded', 'true');

    firePointer(first, 'pointerout', { pointerType: 'mouse', relatedTarget: second });
    firePointer(second, 'pointerover', { pointerType: 'mouse', relatedTarget: first });
    act(() => {
      jest.advanceTimersByTime(RELATION_PREVIEW_CLOSE_DELAY_MS);
    });
    expect(first).toHaveAttribute('aria-expanded', 'false');
    expect(second).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('heading', { name: 'Relations for Epic B' })).toBeInTheDocument();
  });

  it('clears pending timers on unmount', () => {
    const { unmount } = renderBadges({
      counts: countsFixture({
        related: 1,
        total: 1,
        relatedSources: 1,
        relatedTargets: 0,
        relatedNeutral: 0,
      }),
    });
    firePointer(trigger(), 'pointerover', { pointerType: 'mouse', relatedTarget: document.body });
    unmount();
    expect(() =>
      act(() => {
        jest.advanceTimersByTime(RELATION_PREVIEW_OPEN_DELAY_MS * 2);
      }),
    ).not.toThrow();
  });
});

describe('EpicRelationBadges card drag fence', () => {
  it('arms the fence on primary pointer-down and clears it on release', () => {
    const fence = { current: false };
    renderBadges({
      counts: countsFixture({
        related: 1,
        total: 1,
        relatedSources: 1,
        relatedTargets: 0,
        relatedNeutral: 0,
      }),
      dragFenceRef: fence,
    });

    firePointer(trigger(), 'pointerdown', { pointerType: 'mouse', button: 0, pointerId: 9 });
    expect(fence.current).toBe(true);

    // Pointer captured on the trigger: a release outside still clears it.
    firePointer(trigger(), 'pointerup', { pointerType: 'mouse', pointerId: 9 });
    expect(fence.current).toBe(false);
  });

  it('clears the fence on pointer cancel and lost pointer capture', () => {
    const fence = { current: false };
    renderBadges({
      counts: countsFixture({
        related: 1,
        total: 1,
        relatedSources: 1,
        relatedTargets: 0,
        relatedNeutral: 0,
      }),
      dragFenceRef: fence,
    });

    firePointer(trigger(), 'pointerdown', { pointerType: 'touch', button: 0, pointerId: 4 });
    expect(fence.current).toBe(true);
    firePointer(trigger(), 'pointercancel', { pointerType: 'touch', pointerId: 4 });
    expect(fence.current).toBe(false);

    firePointer(trigger(), 'pointerdown', { pointerType: 'mouse', button: 0, pointerId: 6 });
    expect(fence.current).toBe(true);
    fireEvent(trigger(), new Event('lostpointercapture', { bubbles: true }));
    expect(fence.current).toBe(false);
  });
});

describe('EpicRelationBadges preview content', () => {
  it('loads details only in the resolved main runtime', () => {
    renderBadges({
      counts: countsFixture({
        related: 1,
        total: 1,
        relatedSources: 1,
        relatedTargets: 0,
        relatedNeutral: 0,
      }),
    });
    expect(useEpicRelationsMock).toHaveBeenCalledWith(FOCAL_ID, { enabled: false });

    openKeyboardPreview();
    expect(useEpicRelationsMock).toHaveBeenLastCalledWith(FOCAL_ID, { enabled: true });
  });

  it('renders no cached main detail rows in a non-main runtime', () => {
    mockQuery(firstPage([sourceRow]));
    worktreeRuntime.apiBase = '/wt/demo';
    renderBadges({
      counts: countsFixture({
        related: 1,
        total: 1,
        relatedSources: 1,
        relatedTargets: 0,
        relatedNeutral: 0,
      }),
    });
    openKeyboardPreview();

    expect(useEpicRelationsMock).toHaveBeenLastCalledWith(FOCAL_ID, { enabled: false });
    expect(previewHeading()).toBeInTheDocument();
    expect(screen.queryByText('Design API')).not.toBeInTheDocument();
  });

  it('groups the first page by role and type and hides empty groups', () => {
    mockQuery(firstPage([sourceRow, blocksRow]));
    renderBadges({
      counts: countsFixture({
        related: 1,
        blocks: 1,
        total: 2,
        relatedSources: 1,
        relatedTargets: 0,
        relatedNeutral: 0,
      }),
    });
    openKeyboardPreview();

    expect(screen.getByText('Source (1)')).toBeInTheDocument();
    expect(screen.getByText('Blocks (1)')).toBeInTheDocument();
    expect(screen.queryByText('Target (1)')).not.toBeInTheDocument();
    expect(screen.queryByText('No direction yet (1)')).not.toBeInTheDocument();
    expect(screen.queryByText('Blocked by (1)')).not.toBeInTheDocument();
  });

  it('renders every role group plus title, status, project, and short ID', () => {
    const longTitle =
      'A very long relation title that must truncate without displacing the facts below it';
    mockQuery(
      firstPage([
        targetRow,
        neutralRow,
        blockedByRow,
        relationRow('rel-long', 'related', FOCAL_ID, 'epic-long', 'epic-long', longTitle),
      ]),
    );
    renderBadges({
      counts: countsFixture({
        related: 3,
        blockedBy: 1,
        total: 4,
        relatedSources: 0,
        relatedTargets: 1,
        relatedNeutral: 2,
      }),
    });
    openKeyboardPreview();

    expect(screen.getByText('Target (2)')).toBeInTheDocument();
    expect(screen.getByText('No direction yet (1)')).toBeInTheDocument();
    expect(screen.getByText('Blocked by (1)')).toBeInTheDocument();

    expect(screen.getByTitle(longTitle)).toHaveClass('truncate');
    expect(screen.getAllByText('In Progress').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Current Project').length).toBeGreaterThan(0);
    expect(screen.getAllByText('epic-shi').length).toBeGreaterThan(0);
  });

  it('shows a delayed loading indicator only after the delay', () => {
    jest.useFakeTimers();
    mockQuery({ isLoading: true });
    renderBadges({
      counts: countsFixture({
        related: 1,
        total: 1,
        relatedSources: 1,
        relatedTargets: 0,
        relatedNeutral: 0,
      }),
    });
    openKeyboardPreview();

    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    act(() => {
      jest.advanceTimersByTime(200);
    });
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    jest.useRealTimers();
  });

  it('renders a decorative failure line without retry controls', () => {
    mockQuery({ isError: true });
    renderBadges({
      counts: countsFixture({
        related: 1,
        total: 1,
        relatedSources: 1,
        relatedTargets: 0,
        relatedNeutral: 0,
      }),
    });
    openKeyboardPreview();

    expect(screen.getByText('Relations could not be loaded.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });

  it('renders a safe empty state for a relation-free Epic', () => {
    mockQuery(firstPage([]));
    renderBadges({
      counts: countsFixture({
        related: 1,
        total: 1,
        relatedSources: 1,
        relatedTargets: 0,
        relatedNeutral: 0,
      }),
    });
    openKeyboardPreview();

    expect(screen.getByText('No relations yet.')).toBeInTheDocument();
  });

  it('renders only the first 20-row page and the exact +N note', () => {
    const pageTwo: EpicRelation[] = Array.from({ length: 3 }, (_, index) =>
      relationRow(`rel-x-${index}`, 'related', null, null, `epic-x-${index}`, `Extra ${index}`),
    );
    mockQuery({
      data: {
        pages: [
          { items: [sourceRow], total: 4, limit: 20, offset: 0 },
          { items: pageTwo, total: 4, limit: 20, offset: 20 },
        ],
        pageParams: [0, 20],
      },
    });
    renderBadges({
      counts: countsFixture({
        related: 4,
        total: 4,
        relatedSources: 4,
        relatedTargets: 0,
        relatedNeutral: 0,
      }),
    });
    openKeyboardPreview();

    expect(screen.getByText('Design API')).toBeInTheDocument();
    expect(screen.queryByText('Extra 0')).not.toBeInTheDocument();
    expect(screen.getByText('+3 more — open the Epic to see all.')).toBeInTheDocument();
  });

  it('gives the dialog an accessible name through the visible heading', () => {
    mockQuery(firstPage([sourceRow]));
    renderBadges({
      counts: countsFixture({
        related: 1,
        total: 1,
        relatedSources: 1,
        relatedTargets: 0,
        relatedNeutral: 0,
      }),
    });
    openKeyboardPreview();

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAccessibleName('Relations for Focal Epic');
  });

  it('passes composed accessibility checks while open', async () => {
    mockQuery(firstPage([sourceRow, blocksRow]));
    renderBadges({
      counts: countsFixture({
        related: 1,
        blocks: 1,
        total: 2,
        relatedSources: 1,
        relatedTargets: 0,
        relatedNeutral: 0,
      }),
    });
    openKeyboardPreview();

    expect(await axe(document.body)).toHaveNoViolations();
  });
});

describe('EpicRelationBadges title navigation', () => {
  it('routes a same-project title through a clean path without project activation', () => {
    mockQuery(firstPage([sourceRow]));
    renderBadges({ counts: relatedCounts(1) });
    openKeyboardPreview();

    const link = screen.getByRole('link', { name: 'Design API' });
    expect(link).toHaveAttribute('href', '/epics/epic-design');

    fireEvent.click(link);
    expect(mockProjectSelection.activateProject).not.toHaveBeenCalled();
    expect(currentLocation()).toBe('/epics/epic-design');
    expect(screen.getByTestId('epic-route')).toBeInTheDocument();
  });

  it('activates a cross-project target before ordinary SPA navigation', () => {
    const locationsAtActivation: string[] = [];
    mockProjectSelection.activateProject.mockImplementation(() => {
      locationsAtActivation.push(currentLocation());
    });
    mockQuery(firstPage([crossProjectRow]));
    renderBadges({ counts: relatedCounts(1) });
    openKeyboardPreview();

    const link = screen.getByRole('link', { name: 'Remote Epic' });
    expect(link).toHaveAttribute('href', '/epics/epic-remote?projectId=project-2');

    fireEvent.click(link);
    expect(mockProjectSelection.activateProject).toHaveBeenCalledWith({
      id: 'project-2',
      workspaceId: 'workspace-1',
    });
    // The activation ran while the Board route was still current, so the
    // target project is active before the router renders the Epic page.
    expect(locationsAtActivation).toEqual(['/board']);
    expect(currentLocation()).toBe('/epics/epic-remote?projectId=project-2');
  });

  it.each(['ctrlKey', 'metaKey', 'shiftKey', 'altKey'] as const)(
    'keeps a modified %s click native and off the current tab',
    (modifier) => {
      mockQuery(firstPage([crossProjectRow]));
      renderBadges({ counts: relatedCounts(1) });
      openKeyboardPreview();

      const link = screen.getByRole('link', { name: 'Remote Epic' });
      fireEvent.click(link, { [modifier]: true });

      expect(mockProjectSelection.activateProject).not.toHaveBeenCalled();
      expect(currentLocation()).toBe('/board');
    },
  );

  it('renders a cross-project title as plain text while the focal workspace is unavailable', () => {
    mockProjectSelection.selectedWorkspace = undefined;
    mockQuery(firstPage([crossProjectRow, sourceRow]));
    renderBadges({ counts: relatedCounts(2) });
    openKeyboardPreview();

    expect(screen.queryByRole('link', { name: 'Remote Epic' })).not.toBeInTheDocument();
    expect(screen.getByText('Remote Epic').closest('a')).toBeNull();
    // Same-project titles stay interactive without workspace knowledge.
    expect(screen.getByRole('link', { name: 'Design API' })).toBeInTheDocument();
  });

  it('marks title links undraggable', () => {
    mockQuery(firstPage([sourceRow]));
    renderBadges({ counts: relatedCounts(1) });
    openKeyboardPreview();

    expect(screen.getByRole('link', { name: 'Design API' })).toHaveAttribute('draggable', 'false');
  });
});

describe('EpicRelationBadges keyboard entry and focus', () => {
  it('focuses the first cached title exactly once after explicit entry', () => {
    mockQuery(firstPage([sourceRow, targetRow]));
    const { rerender } = renderBadges({ counts: relatedCounts(2) });
    openKeyboardPreview();

    const firstLink = screen.getByRole('link', { name: 'Design API' });
    expect(firstLink).not.toHaveFocus();
    expect(trigger()).toHaveFocus();

    enterPreview();
    expect(firstLink).toHaveFocus();

    // A query refresh in the same open cycle never refocuses: focus stays
    // wherever the user moved it.
    const secondLink = screen.getByRole('link', { name: 'Ship CLI' });
    secondLink.focus();
    rerender(badgesTree({ counts: relatedCounts(2), epicId: FOCAL_ID, epicTitle: 'Focal Epic' }));
    expect(secondLink).toHaveFocus();
  });

  it('focuses the first delayed title once when rows arrive', () => {
    mockQuery({ isLoading: true });
    const { rerender } = renderBadges({ counts: relatedCounts(1) });
    openKeyboardPreview();

    enterPreview();
    expect(trigger()).toHaveFocus();

    mockQuery(firstPage([sourceRow]));
    rerender(badgesTree({ counts: relatedCounts(1), epicId: FOCAL_ID, epicTitle: 'Focal Epic' }));
    expect(screen.getByRole('link', { name: 'Design API' })).toHaveFocus();
  });

  it('leaves focus on the trigger for empty and failed results after entry', () => {
    mockQuery(firstPage([]));
    const { rerender } = renderBadges({ counts: relatedCounts(1) });
    openKeyboardPreview();

    enterPreview();
    expect(trigger()).toHaveFocus();

    mockQuery({ isError: true });
    rerender(badgesTree({ counts: relatedCounts(1), epicId: FOCAL_ID, epicTitle: 'Focal Epic' }));
    enterPreview();
    expect(trigger()).toHaveFocus();
  });

  it('cycles Tab and Shift+Tab through the loaded title links after explicit entry', () => {
    mockQuery(firstPage([sourceRow, targetRow]));
    renderBadges({ counts: relatedCounts(2) });
    openKeyboardPreview();

    enterPreview();
    const firstLink = screen.getByRole('link', { name: 'Design API' });
    const secondLink = screen.getByRole('link', { name: 'Ship CLI' });
    expect(firstLink).toHaveFocus();

    // Tab from the last link wraps to the first through the Radix focus loop.
    secondLink.focus();
    fireEvent.keyDown(secondLink, { key: 'Tab' });
    expect(firstLink).toHaveFocus();

    // Shift+Tab from the first link wraps back to the last.
    fireEvent.keyDown(firstLink, { key: 'Tab', shiftKey: true });
    expect(secondLink).toHaveFocus();
  });
});

describe('EpicRelationBadges Escape restore', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function escapeFromPreview() {
    fireEvent.keyDown(document.body, { key: 'Escape' });
    act(() => {
      jest.advanceTimersByTime(1000);
    });
  }

  it('restores the trigger without reopening after pending timers run', () => {
    mockQuery(firstPage([sourceRow]));
    renderBadges({ counts: relatedCounts(1) });
    openKeyboardPreview();
    enterPreview();
    expect(screen.getByRole('link', { name: 'Design API' })).toHaveFocus();

    escapeFromPreview();

    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(trigger()).toHaveFocus();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Design API' })).not.toBeInTheDocument();
  });

  it('behaves identically across repeated Enter, Escape cycles', () => {
    mockQuery(firstPage([sourceRow]));
    renderBadges({ counts: relatedCounts(1) });
    openKeyboardPreview();

    for (let cycle = 0; cycle < 2; cycle += 1) {
      enterPreview();
      expect(trigger()).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByRole('link', { name: 'Design API' })).toHaveFocus();

      escapeFromPreview();
      expect(trigger()).toHaveAttribute('aria-expanded', 'false');
      expect(trigger()).toHaveFocus();
    }
  });

  it('reopens normally when focus leaves and returns to the trigger after Escape', () => {
    mockQuery(firstPage([sourceRow]));
    renderBadges({ counts: relatedCounts(1) });
    openKeyboardPreview();
    enterPreview();
    escapeFromPreview();
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');

    trigger().blur();
    trigger().focus();
    fireEvent.focus(trigger());

    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    expect(previewHeading()).toBeInTheDocument();
  });
});
