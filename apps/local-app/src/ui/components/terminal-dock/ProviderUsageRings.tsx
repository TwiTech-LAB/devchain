import type { ComponentType, ReactNode } from 'react';
import {
  STANDARD_WINDOW_LABELS,
  type ProviderUsageProvider,
  type ProviderUsageSettings,
  type UsageSnapshot,
  type UsageWindow,
} from '@devchain/shared';
import { useProviderUsage } from '@/ui/hooks/useProviderUsage';
import { useStoredChoice } from '@/ui/hooks/useStoredChoice';
import {
  PERCENT_TONE_FILL_CLASS,
  PERCENT_TONE_TEXT_CLASS,
  percentTone,
  type PercentTone,
} from '@/ui/lib/percent-tone';
import { getProviderIconDataUri } from '@/ui/lib/providers';
import {
  formatTime,
  isUsageMuted,
  usageForecast,
  type UsageForecastKind,
} from '@/ui/lib/usage-forecast';
import { cn } from '@/ui/lib/utils';
import { providerName } from '@/ui/pages/cloud/login-choices';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../ui/context-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';

const RING_SIZE = 28;
const STROKE_WIDTH = 2.5;
const ARC_GAP = 1;
const CENTER = RING_SIZE / 2;

/** Longer windows rank higher; the longest becomes the outer arc. */
const WINDOW_RANK: Record<UsageWindow['kind'], number> = { weekly: 2, '5h': 1, other: 0 };

const WINDOW_SHORT_LABELS: Record<UsageWindow['kind'], string | null> = {
  '5h': '5-hour',
  weekly: 'weekly',
  other: null,
};

/** Smart mode tags each number with its window, since the shown window changes. */
const WINDOW_TAGS: Record<UsageWindow['kind'], string | null> = {
  '5h': 'S',
  weekly: 'W',
  other: null,
};

const DEFAULT_WINDOW_LABELS: Record<UsageWindow['kind'], string> = {
  ...STANDARD_WINDOW_LABELS,
  other: 'Limit',
};

/** How each account's usage is drawn: a preference of this browser. */
const STYLES = ['rings', 'bars', 'columns', 'minimal'] as const;
type UsageStyle = (typeof STYLES)[number];
const STYLE_STORAGE_KEY = 'devchain.providerUsage.style';

const STYLE_LABELS: Record<UsageStyle, string> = {
  rings: 'Rings',
  bars: 'Bars',
  columns: 'Columns',
  minimal: 'Minimal',
};

/** Which percents show next to each graphic: a preference of this browser. */
const NUMBERS_MODES = ['none', '5h', 'weekly', 'both', 'smart'] as const;
type NumbersMode = (typeof NUMBERS_MODES)[number];
const NUMBERS_MODE_STORAGE_KEY = 'devchain.providerUsage.numbers';

const NUMBERS_MODE_LABELS: Record<NumbersMode, string> = {
  none: 'None',
  '5h': '5-hour',
  weekly: 'Weekly',
  both: 'Both',
  smart: 'Smart (S = 5-hour, W = weekly)',
};

type RingTone = PercentTone | 'muted';

const FORECAST_TEXT: Record<UsageForecastKind, string> = {
  'on-track': 'text-status-ok',
  'runs-out': 'text-status-warn',
  reached: 'text-status-warn',
};

/** Graphic colors; the numbers keep the text color below the warning threshold. */
const TONE_TEXT: Record<RingTone, string> = {
  ...PERCENT_TONE_TEXT_CLASS,
  normal: 'text-primary',
  muted: 'text-muted-foreground',
};

const TONE_FILL: Record<RingTone, string> = {
  ...PERCENT_TONE_FILL_CLASS,
  muted: 'bg-muted-foreground',
};

/** At most two windows, longest first. agy reports its model groups as extras only. */
function ringWindows(snapshot: UsageSnapshot): UsageWindow[] {
  const source = snapshot.windows.length > 0 ? snapshot.windows : snapshot.extras;
  return [...source].sort((a, b) => WINDOW_RANK[b.kind] - WINDOW_RANK[a.kind]).slice(0, 2);
}

/** The tone of a window's displayed (rounded) percent. */
function windowTone(window: UsageWindow): PercentTone {
  return percentTone(Math.round(window.usedPercent));
}

/** A window's graphic tone: its own tone, or grey when the data is not current. */
function meterTone(window: UsageWindow, muted: boolean): RingTone {
  return muted ? 'muted' : windowTone(window);
}

function fillPercent(window: UsageWindow): number {
  return Math.min(Math.max(window.usedPercent, 0), 100);
}

/** The 5-hour window above the ring's other window; null when the ring has no such pair. */
function stackedWindows(windows: readonly UsageWindow[]): UsageWindow[] | null {
  const fiveHour = windows.find((window) => window.kind === '5h');
  const other = windows.find((window) => window !== fiveHour);
  return fiveHour && other ? [fiveHour, other] : null;
}

function highestWindow(windows: readonly UsageWindow[]): UsageWindow | null {
  return windows.reduce<UsageWindow | null>(
    (top, window) => (top === null || window.usedPercent > top.usedPercent ? window : top),
    null,
  );
}

/**
 * The windows whose percents show next to the ring, top line first. A mode whose window
 * the account lacks shows the highest percent; `smart` stacks both only when both warn.
 */
function labelWindows(windows: readonly UsageWindow[], mode: NumbersMode): UsageWindow[] {
  const highest = highestWindow(windows);
  if (mode === 'none' || highest === null) return [];
  if (mode === '5h' || mode === 'weekly') {
    return [highestWindow(windows.filter((window) => window.kind === mode)) ?? highest];
  }
  if (mode === 'smart' && windows.some((window) => windowTone(window) === 'normal')) {
    return [highest];
  }
  return stackedWindows(windows) ?? [highest];
}

function headerTitle(snapshot: UsageSnapshot): string {
  const detail =
    snapshot.plan ??
    (snapshot.accountKey.startsWith('claude:token:') ? 'provider env token' : null);
  return [providerName(snapshot.provider), detail].filter(Boolean).join(' · ');
}

/** The account label only adds information when it is not the bare provider name. */
function distinctAccountLabel(snapshot: UsageSnapshot): string | null {
  const label = snapshot.label.trim();
  if (label === providerName(snapshot.provider) || label.toLowerCase() === snapshot.provider) {
    return null;
  }
  return label || null;
}

export function formatResetDate(resetsAt: number): string {
  const date = new Date(resetsAt * 1000);
  const day = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${day}, ${formatTime(date)}`;
}

export function formatTimeUntil(resetsAt: number, now: number): string {
  const totalMinutes = Math.max(0, Math.floor((resetsAt * 1000 - now) / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days} d ${hours} h`;
  if (hours > 0) return `${hours} h ${minutes} min`;
  return `${minutes} min`;
}

function resetText(window: UsageWindow, now: number): string {
  if (window.resetsAt === null) return 'Not started';
  return `Resets ${formatResetDate(window.resetsAt)} · in ${formatTimeUntil(window.resetsAt, now)}`;
}

function footerText(snapshot: UsageSnapshot, now: number): string {
  if (snapshot.state === 'unsupported') return 'Usage checks are not available for this account.';
  if (snapshot.state === 'error' || snapshot.state === 'not-available') {
    return snapshot.error ?? 'The last usage check failed.';
  }
  if (snapshot.fetchedAt === null) return 'No data yet';
  const minutes = Math.floor((now - Date.parse(snapshot.fetchedAt)) / 60_000);
  return minutes < 1 ? 'Updated just now' : `Updated ${minutes} min ago`;
}

function ariaLabel(snapshot: UsageSnapshot, windows: readonly UsageWindow[], muted: boolean) {
  const name = providerName(snapshot.provider);
  if (muted || windows.length === 0) return `${name} usage: no current data`;
  const described = snapshot.windows.length > 0 ? snapshot.windows : windows;
  const parts = described.map(
    (window) =>
      `${WINDOW_SHORT_LABELS[window.kind] ?? window.label} ${Math.round(window.usedPercent)}%`,
  );
  return `${name} usage: ${parts.join(', ')}`;
}

interface GraphicProps {
  provider: ProviderUsageProvider;
  windows: readonly UsageWindow[];
  muted: boolean;
}

function ProviderIcon({ provider }: Pick<GraphicProps, 'provider'>) {
  const icon = getProviderIconDataUri(provider);
  return icon ? <img src={icon} alt="" className="h-3.5 w-3.5 shrink-0" /> : null;
}

/** Each arc takes the tone of its own window; the longest window is the outer arc. */
function Ring({ provider, windows, muted }: GraphicProps) {
  const icon = getProviderIconDataUri(provider);
  const outerRadius = (RING_SIZE - STROKE_WIDTH) / 2;
  const iconSize = windows.length > 1 ? 10 : 14;
  return (
    <svg
      width={RING_SIZE}
      height={RING_SIZE}
      viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
      aria-hidden="true"
    >
      {windows.map((window, index) => {
        const tone = meterTone(window, muted);
        const radius = outerRadius - index * (STROKE_WIDTH + ARC_GAP);
        const circumference = 2 * Math.PI * radius;
        const fraction = fillPercent(window) / 100;
        return (
          <g key={window.id}>
            <circle
              cx={CENTER}
              cy={CENTER}
              r={radius}
              fill="none"
              strokeWidth={STROKE_WIDTH}
              className="stroke-border"
            />
            <circle
              data-testid="usage-arc"
              data-tone={tone}
              className={TONE_TEXT[tone]}
              cx={CENTER}
              cy={CENTER}
              r={radius}
              fill="none"
              stroke="currentColor"
              strokeWidth={STROKE_WIDTH}
              strokeLinecap="round"
              strokeDasharray={`${circumference * fraction} ${circumference}`}
              transform={`rotate(-90 ${CENTER} ${CENTER})`}
            />
          </g>
        );
      })}
      {icon && (
        <image
          href={icon}
          x={CENTER - iconSize / 2}
          y={CENTER - iconSize / 2}
          width={iconSize}
          height={iconSize}
        />
      )}
    </svg>
  );
}

/** One horizontal bar per window, 5-hour on top like the stacked numbers. */
function Bars({ provider, windows, muted }: GraphicProps) {
  return (
    <span className="flex items-center gap-1">
      <ProviderIcon provider={provider} />
      <span className="flex w-6 flex-col gap-[3px]">
        {(stackedWindows(windows) ?? windows).map((window) => (
          <span key={window.id} className="h-[3px] overflow-hidden rounded-full bg-border">
            <span
              data-testid="usage-meter"
              className={cn('block h-full rounded-full', TONE_FILL[meterTone(window, muted)])}
              style={{ width: `${fillPercent(window)}%` }}
            />
          </span>
        ))}
      </span>
    </span>
  );
}

/** One vertical bar per window, 5-hour on the left. */
function Columns({ provider, windows, muted }: GraphicProps) {
  return (
    <span className="flex items-center gap-1">
      <ProviderIcon provider={provider} />
      <span className="flex h-5 gap-[3px]">
        {(stackedWindows(windows) ?? windows).map((window) => (
          <span
            key={window.id}
            className="flex h-full w-[3px] items-end overflow-hidden rounded-full bg-border"
          >
            <span
              data-testid="usage-meter"
              className={cn('block w-full rounded-full', TONE_FILL[meterTone(window, muted)])}
              style={{ height: `${fillPercent(window)}%` }}
            />
          </span>
        ))}
      </span>
    </span>
  );
}

const GRAPHICS: Record<UsageStyle, ComponentType<GraphicProps>> = {
  rings: Ring,
  bars: Bars,
  columns: Columns,
  minimal: ProviderIcon,
};

function ChoiceGroup<T extends string>({
  label,
  choices,
  labels,
  value,
  onChange,
}: {
  label: string;
  choices: readonly T[];
  labels: Record<T, string>;
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <>
      <ContextMenuLabel>{label}</ContextMenuLabel>
      <ContextMenuRadioGroup value={value} onValueChange={(next) => onChange(next as T)}>
        {choices.map((choice) => (
          <ContextMenuRadioItem key={choice} value={choice}>
            {labels[choice]}
          </ContextMenuRadioItem>
        ))}
      </ContextMenuRadioGroup>
    </>
  );
}

function WindowBlock({ window, now }: { window: UsageWindow; now: number }) {
  const percent = Math.round(window.usedPercent);
  return (
    <div className="space-y-1" data-testid="usage-window">
      <div className="flex items-center justify-between gap-4 text-xs">
        <span className="font-medium">{window.label || DEFAULT_WINDOW_LABELS[window.kind]}</span>
        <span className="tabular-nums">{percent}% used</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn('h-full rounded-full', TONE_FILL[percentTone(percent)])}
          style={{ width: `${Math.min(Math.max(percent, 0), 100)}%` }}
        />
      </div>
      <p className="text-xs text-muted-foreground">{resetText(window, now)}</p>
    </div>
  );
}

/** The rounded percent; a tagged window shows its tag in place of the percent sign. */
function PercentText({ window, tagged }: { window: UsageWindow; tagged: boolean }) {
  const tag = tagged ? WINDOW_TAGS[window.kind] : null;
  return (
    <>
      {Math.round(window.usedPercent)}
      {tag === null ? (
        '%'
      ) : (
        <span className="ml-px text-[0.75em] font-medium text-muted-foreground">{tag}</span>
      )}
    </>
  );
}

function PercentLabel({
  windows,
  muted,
  mode,
}: {
  windows: readonly UsageWindow[];
  muted: boolean;
  mode: NumbersMode;
}) {
  if (mode === 'none') return null;
  if (muted) {
    return (
      <span
        data-testid="usage-percent"
        className="font-semibold tabular-nums text-muted-foreground"
      >
        —
      </span>
    );
  }
  const shown = labelWindows(windows, mode);
  const tagged = mode === 'smart';
  if (shown.length === 1) {
    return (
      <span
        data-testid="usage-percent"
        className={cn('font-semibold tabular-nums', PERCENT_TONE_TEXT_CLASS[windowTone(shown[0])])}
      >
        <PercentText window={shown[0]} tagged={tagged} />
      </span>
    );
  }
  return (
    <span className="flex flex-col text-[10px] font-semibold leading-tight tabular-nums">
      {shown.map((window) => (
        <span
          key={window.id}
          data-testid="usage-percent"
          className={PERCENT_TONE_TEXT_CLASS[windowTone(window)]}
        >
          <PercentText window={window} tagged={tagged} />
        </span>
      ))}
    </span>
  );
}

function UsageRing({
  snapshot,
  config,
  style,
  numbersMode,
  menu,
  onOpen,
}: {
  snapshot: UsageSnapshot;
  config: ProviderUsageSettings;
  style: UsageStyle;
  numbersMode: NumbersMode;
  menu: ReactNode;
  onOpen: () => void;
}) {
  const now = Date.now();
  const windows = ringWindows(snapshot);
  const top = highestWindow(windows);
  const highest = top === null ? null : Math.round(top.usedPercent);
  const tone: RingTone =
    highest === null || isUsageMuted(snapshot, config, now) ? 'muted' : percentTone(highest);
  const muted = tone === 'muted';
  const accountLabel = distinctAccountLabel(snapshot);
  const failed = snapshot.state === 'error' || snapshot.state === 'not-available';
  const Graphic = GRAPHICS[style];
  const forecast = usageForecast(snapshot, config, now);

  return (
    <Tooltip
      onOpenChange={(open) => {
        if (open) onOpen();
      }}
    >
      <ContextMenu>
        <TooltipTrigger asChild>
          <ContextMenuTrigger asChild>
            <button
              type="button"
              data-testid="provider-usage-ring"
              data-tone={tone}
              className="flex h-8 items-center gap-1 rounded-md px-1 text-xs outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={ariaLabel(snapshot, windows, muted)}
            >
              <Graphic provider={snapshot.provider} windows={windows} muted={muted} />
              <PercentLabel windows={windows} muted={muted} mode={numbersMode} />
            </button>
          </ContextMenuTrigger>
        </TooltipTrigger>
        <ContextMenuContent>{menu}</ContextMenuContent>
      </ContextMenu>
      <TooltipContent className="w-64 p-3">
        <div className="space-y-3" data-testid="provider-usage-card">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{headerTitle(snapshot)}</p>
              {accountLabel && (
                <p className="truncate text-xs text-muted-foreground">{accountLabel}</p>
              )}
            </div>
            <span className="text-sm font-semibold tabular-nums">
              {highest === null ? '—' : `${highest}%`}
            </span>
          </div>
          {forecast && (
            <p
              data-testid="usage-forecast"
              data-kind={forecast.kind}
              className={cn('text-xs', FORECAST_TEXT[forecast.kind])}
            >
              {forecast.text}
            </p>
          )}
          {[...snapshot.windows, ...snapshot.extras].map((window) => (
            <WindowBlock key={window.id} window={window} now={now} />
          ))}
          <p className={cn('text-xs', failed ? 'text-destructive' : 'text-muted-foreground')}>
            {footerText(snapshot, now)}
          </p>
          <p className="text-[10px] text-muted-foreground">Right-click for display options.</p>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

/** One usage ring per provider account of the project; renders nothing without accounts. */
export function ProviderUsageRings({ projectId }: { projectId: string | null }) {
  const { data, refreshForHover } = useProviderUsage(projectId);
  const [style, setStyle] = useStoredChoice(STYLE_STORAGE_KEY, STYLES, 'rings');
  const [numbersMode, setNumbersMode] = useStoredChoice(
    NUMBERS_MODE_STORAGE_KEY,
    NUMBERS_MODES,
    'both',
  );
  if (!data || data.accounts.length === 0) return null;

  const onOpen = () => void refreshForHover();
  const menu = (
    <>
      <ChoiceGroup
        label="Style"
        choices={STYLES}
        labels={STYLE_LABELS}
        value={style}
        onChange={setStyle}
      />
      <ContextMenuSeparator />
      <ChoiceGroup
        label="Numbers"
        choices={NUMBERS_MODES}
        labels={NUMBERS_MODE_LABELS}
        value={numbersMode}
        onChange={setNumbersMode}
      />
    </>
  );
  return (
    <TooltipProvider delayDuration={300}>
      <div data-testid="provider-usage-rings" className="flex shrink-0 items-center gap-0.5">
        {data.accounts.map((snapshot) => (
          <UsageRing
            key={snapshot.accountKey}
            snapshot={snapshot}
            config={data.config}
            style={style}
            numbersMode={numbersMode}
            menu={menu}
            onOpen={onOpen}
          />
        ))}
      </div>
    </TooltipProvider>
  );
}
