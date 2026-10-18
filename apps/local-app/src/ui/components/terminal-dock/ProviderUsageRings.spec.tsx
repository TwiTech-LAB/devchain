import { fireEvent, render, screen, within } from '@testing-library/react';
import {
  PROVIDER_USAGE_SETTINGS_DEFAULTS,
  type ProviderUsageResponse,
  type UsageSnapshot,
  type UsageWindow,
} from '@devchain/shared';
import { ProviderUsageRings, formatResetDate } from './ProviderUsageRings';

// Layer: component unit with the data hook mocked. Arc count, percent label, tone
// and card copy are rendering decisions of this component; the hook has its own spec.
const mockUseProviderUsage = jest.fn();
jest.mock('@/ui/hooks/useProviderUsage', () => ({
  useProviderUsage: (projectId: string | null) => mockUseProviderUsage(projectId),
}));

const NOW = Date.parse('2026-10-17T12:00:00.000Z');
const NOW_SEC = NOW / 1000;
const refreshForHover = jest.fn().mockResolvedValue(undefined);

function usageWindow(overrides: Partial<UsageWindow> = {}): UsageWindow {
  return {
    id: '5h',
    label: '5-hour limit',
    kind: '5h',
    usedPercent: 22,
    resetsAt: NOW_SEC + (2 * 60 + 13) * 60,
    ...overrides,
  };
}

const WEEKLY = usageWindow({
  id: 'weekly',
  label: 'Weekly limit',
  kind: 'weekly',
  usedPercent: 31,
  resetsAt: NOW_SEC + 3 * 86_400,
});

function snapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    accountKey: 'claude:login:/home/dev/.claude',
    provider: 'claude',
    label: 'Claude',
    windows: [usageWindow(), WEEKLY],
    extras: [],
    plan: 'Max 5x',
    source: 'cli',
    fetchedAt: new Date(NOW - 5 * 60_000).toISOString(),
    state: 'ok',
    error: null,
    ...overrides,
  };
}

function renderRings(accounts: UsageSnapshot[]) {
  const data: ProviderUsageResponse = { accounts, config: { ...PROVIDER_USAGE_SETTINGS_DEFAULTS } };
  mockUseProviderUsage.mockReturnValue({ data, refreshForHover });
  return render(<ProviderUsageRings projectId="project-1" />);
}

const NUMBERS_KEY = 'devchain.providerUsage.numbers';
const STYLE_KEY = 'devchain.providerUsage.style';

function shownPercents(): string[] {
  return screen.queryAllByTestId('usage-percent').map((line) => line.textContent ?? '');
}

beforeEach(() => {
  jest.useFakeTimers({ now: NOW });
  mockUseProviderUsage.mockReset();
  refreshForHover.mockClear();
  localStorage.clear();
});

afterEach(() => jest.useRealTimers());

describe('ProviderUsageRings', () => {
  it.each([
    ['two windows', [usageWindow(), WEEKLY], 2],
    ['one window', [WEEKLY], 1],
  ])('draws one arc per window for %s', (_case, windows, arcs) => {
    renderRings([snapshot({ windows })]);
    expect(screen.getAllByTestId('usage-arc')).toHaveLength(arcs);
  });

  it('describes every window in the ring label', () => {
    renderRings([snapshot()]);
    expect(
      screen.getByRole('button', { name: 'Claude usage: 5-hour 22%, weekly 31%' }),
    ).toBeInTheDocument();
  });

  it('stacks the 5-hour percent above the weekly percent, each in its own color', () => {
    renderRings([snapshot({ windows: [WEEKLY, usageWindow({ usedPercent: 80 })] })]);
    const [fiveHour, weekly] = screen.getAllByTestId('usage-percent');
    expect([fiveHour.textContent, weekly.textContent]).toEqual(['80%', '31%']);
    expect(fiveHour).toHaveClass('text-status-warn');
    expect(weekly.className).not.toMatch(
      /\btext-(primary|status-warn|status-danger|destructive)\b/,
    );
  });

  it('shows one percent when the account has no 5-hour window', () => {
    renderRings([snapshot({ windows: [WEEKLY] })]);
    expect(screen.getAllByTestId('usage-percent').map((line) => line.textContent)).toEqual(['31%']);
  });

  it.each([
    [74, 'normal'],
    [75, 'warn'],
    [89, 'warn'],
    [90, 'danger'],
  ])('tones %s%% as %s', (usedPercent, tone) => {
    renderRings([snapshot({ windows: [usageWindow({ usedPercent })] })]);
    expect(screen.getByTestId('provider-usage-ring')).toHaveAttribute('data-tone', tone);
  });

  it('tones each arc by its own window', () => {
    renderRings([snapshot({ windows: [usageWindow({ usedPercent: 80 }), WEEKLY] })]);
    const tones = screen.getAllByTestId('usage-arc').map((arc) => arc.getAttribute('data-tone'));
    expect(tones).toEqual(['normal', 'warn']);
  });

  it.each([
    ['an error', { state: 'error' as const, error: 'CLI failed' }],
    ['an unsupported account', { state: 'unsupported' as const }],
    [
      'data older than twice openProjectMaxAgeMin',
      { fetchedAt: new Date(NOW - 61 * 60_000).toISOString() },
    ],
  ])('renders %s muted with a dash', (_case, overrides) => {
    renderRings([snapshot(overrides)]);
    const ring = screen.getByTestId('provider-usage-ring');
    expect(ring).toHaveAttribute('data-tone', 'muted');
    expect(ring).toHaveTextContent('—');
  });

  it('keeps data within twice openProjectMaxAgeMin unmuted', () => {
    renderRings([snapshot({ fetchedAt: new Date(NOW - 15 * 60_000).toISOString() })]);
    const ring = screen.getByTestId('provider-usage-ring');
    expect(ring).toHaveAttribute('data-tone', 'normal');
    expect(ring).toHaveTextContent('31%');
  });

  it('uses the agy groups as arcs when the account has no windows', () => {
    const groups = [
      usageWindow({ id: 'gemini', label: 'Gemini', kind: 'weekly' }),
      usageWindow({ id: 'claude', label: 'Claude models', kind: 'weekly' }),
    ];
    renderRings([snapshot({ provider: 'agy', label: 'agy', windows: [], extras: groups })]);
    expect(screen.getAllByTestId('usage-arc')).toHaveLength(2);
  });

  it.each([
    ['none', []],
    ['5h', ['22%']],
    ['weekly', ['31%']],
    ['both', ['22%', '31%']],
    ['smart', ['31W']],
    ['an unknown value', ['22%', '31%']],
  ])('shows the percents of the stored numbers mode %s', (mode, percents) => {
    localStorage.setItem(NUMBERS_KEY, mode);
    renderRings([snapshot()]);
    expect(shownPercents()).toEqual(percents);
  });

  it('shows the higher percent when the chosen window is missing', () => {
    localStorage.setItem(NUMBERS_KEY, '5h');
    renderRings([snapshot({ windows: [WEEKLY] })]);
    expect(shownPercents()).toEqual(['31%']);
  });

  it('tags the 5-hour percent with S in smart mode when it is the higher one', () => {
    localStorage.setItem(NUMBERS_KEY, 'smart');
    renderRings([snapshot({ windows: [usageWindow({ usedPercent: 60 }), WEEKLY] })]);
    expect(shownPercents()).toEqual(['60S']);
  });

  it('stacks both tagged percents in smart mode when both warn', () => {
    localStorage.setItem(NUMBERS_KEY, 'smart');
    renderRings([
      snapshot({ windows: [usageWindow({ usedPercent: 80 }), { ...WEEKLY, usedPercent: 76 }] }),
    ]);
    expect(shownPercents()).toEqual(['80S', '76W']);
  });

  it('stores the numbers mode chosen from the right-click menu', () => {
    renderRings([snapshot()]);
    fireEvent.contextMenu(screen.getByTestId('provider-usage-ring'));
    fireEvent.click(
      within(screen.getByRole('menu')).getByRole('menuitemradio', { name: 'Weekly' }),
    );

    expect(shownPercents()).toEqual(['31%']);
    expect(localStorage.getItem(NUMBERS_KEY)).toBe('weekly');
  });

  it.each([
    ['bars', 'width'],
    ['columns', 'height'],
  ] as const)('fills the %s to each window, 5-hour first', (style, dimension) => {
    localStorage.setItem(STYLE_KEY, style);
    renderRings([snapshot()]);
    const meters = screen.getAllByTestId('usage-meter');
    expect(meters.map((meter) => meter.style[dimension])).toEqual(['22%', '31%']);
    expect(screen.queryAllByTestId('usage-arc')).toHaveLength(0);
  });

  it('draws no graphic but the icon and the numbers in minimal style', () => {
    localStorage.setItem(STYLE_KEY, 'minimal');
    renderRings([snapshot()]);
    expect(screen.queryAllByTestId('usage-arc')).toHaveLength(0);
    expect(screen.queryAllByTestId('usage-meter')).toHaveLength(0);
    expect(shownPercents()).toEqual(['22%', '31%']);
  });

  it('draws rings for an unknown stored style', () => {
    localStorage.setItem(STYLE_KEY, 'pie');
    renderRings([snapshot()]);
    expect(screen.getAllByTestId('usage-arc')).toHaveLength(2);
  });

  it('marks the current style and numbers choice in the right-click menu', () => {
    localStorage.setItem(STYLE_KEY, 'bars');
    localStorage.setItem(NUMBERS_KEY, 'smart');
    renderRings([snapshot()]);
    fireEvent.contextMenu(screen.getByTestId('provider-usage-ring'));

    const checked = within(screen.getByRole('menu'))
      .getAllByRole('menuitemradio')
      .filter((item) => item.getAttribute('aria-checked') === 'true')
      .map((item) => item.textContent);
    expect(checked).toEqual(['Bars', 'Smart (S = 5-hour, W = weekly)']);
  });

  it('stores the style chosen from the right-click menu', () => {
    renderRings([snapshot()]);
    fireEvent.contextMenu(screen.getByTestId('provider-usage-ring'));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitemradio', { name: 'Bars' }));

    expect(screen.getAllByTestId('usage-meter')).toHaveLength(2);
    expect(localStorage.getItem(STYLE_KEY)).toBe('bars');
  });

  it('renders nothing without accounts or without data', () => {
    const { container } = renderRings([]);
    expect(container).toBeEmptyDOMElement();

    mockUseProviderUsage.mockReturnValue({ data: null, refreshForHover });
    const { container: empty } = render(<ProviderUsageRings projectId="project-1" />);
    expect(empty).toBeEmptyDOMElement();
  });

  it('opens a card with every window and extra, its reset and the data age', async () => {
    const extra = usageWindow({
      id: 'weekly-fable',
      label: 'Weekly · Fable',
      kind: 'weekly',
      usedPercent: 12,
      resetsAt: null,
    });
    renderRings([snapshot({ extras: [extra] })]);

    // Radix opens the trigger on focus in jsdom; hover needs real pointer events.
    fireEvent.focus(screen.getByTestId('provider-usage-ring'));
    // Radix renders the content twice (visible + role="tooltip" copy); read the first.
    const [card] = await screen.findAllByTestId('provider-usage-card');

    expect(within(card).getByText('Claude · Max 5x')).toBeInTheDocument();
    const blocks = within(card).getAllByTestId('usage-window');
    expect(blocks.map((block) => block.textContent)).toEqual([
      `5-hour limit22% usedResets ${formatResetDate(usageWindow().resetsAt!)} · in 2 h 13 min`,
      `Weekly limit31% usedResets ${formatResetDate(WEEKLY.resetsAt!)} · in 3 d 0 h`,
      'Weekly · Fable12% usedNot started',
    ]);
    expect(within(card).getByText('Updated 5 min ago')).toBeInTheDocument();
    expect(refreshForHover).toHaveBeenCalledTimes(1);
  });

  it('shows the weekly forecast below the header in the color of its kind', async () => {
    renderRings([snapshot()]);
    fireEvent.focus(screen.getByTestId('provider-usage-ring'));
    const [card] = await screen.findAllByTestId('provider-usage-card');

    const forecast = within(card).getByTestId('usage-forecast');
    expect(forecast.textContent).toMatch(/^Enough for this week: about 54% used by \w{3}\.$/);
    expect(forecast).toHaveClass('text-status-ok');
    expect(card.children[0].nextElementSibling).toBe(forecast);
  });

  it('shows the error text in the card footer', async () => {
    renderRings([snapshot({ state: 'error', error: 'CLI failed' })]);
    fireEvent.focus(screen.getByTestId('provider-usage-ring'));
    const [card] = await screen.findAllByTestId('provider-usage-card');
    expect(within(card).getByText('CLI failed')).toBeInTheDocument();
  });
});
