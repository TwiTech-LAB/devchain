import { render, screen } from '@testing-library/react';
import { ToolGroupItem } from '../ToolGroupItem';
import type { ToolGroupDisplayItem } from '@/ui/utils/ai-group-enhancer';

jest.mock('@/ui/lib/sessions', () => ({
  fetchJsonOrThrow: jest.fn(),
}));

let mockMode: 'reader' | 'diagnostic' = 'reader';

jest.mock('@/ui/hooks/useSessionViewMode', () => ({
  useSessionViewMode: () => ({ mode: mockMode, setMode: jest.fn() }),
}));

function makeGroup(overrides: Partial<ToolGroupDisplayItem> = {}): ToolGroupDisplayItem {
  return {
    type: 'tool-group',
    toolName: 'Read',
    count: 3,
    items: [],
    totalTokens: 150,
    totalDurationMs: 2000,
    errorCount: 0,
    ...overrides,
  };
}

describe('ToolGroupItem — mode-gated hotspot UI', () => {
  afterEach(() => {
    mockMode = 'reader';
  });

  it('hides flame and percentage in reader mode', () => {
    mockMode = 'reader';
    const group = makeGroup();
    render(<ToolGroupItem group={group} isStepHot percentOfChunk={42} />);

    expect(screen.queryByTestId('tool-group-flame')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tool-group-pct')).not.toBeInTheDocument();
  });

  it('shows flame and percentage in diagnostic mode', () => {
    mockMode = 'diagnostic';
    const group = makeGroup();
    render(<ToolGroupItem group={group} isStepHot percentOfChunk={42} />);

    expect(screen.getByTestId('tool-group-flame')).toBeVisible();
    expect(screen.getByTestId('tool-group-pct')).toBeVisible();
    expect(screen.getByTestId('tool-group-pct')).toHaveTextContent('42%');
  });

  it('shows border-l-2 accent in reader mode when isStepHot', () => {
    mockMode = 'reader';
    const group = makeGroup();
    const { container } = render(<ToolGroupItem group={group} isStepHot />);
    expect(container.firstChild).toHaveClass('border-l-2');
  });

  it('shows border-l-2 accent in diagnostic mode when isStepHot', () => {
    mockMode = 'diagnostic';
    const group = makeGroup();
    const { container } = render(<ToolGroupItem group={group} isStepHot />);
    expect(container.firstChild).toHaveClass('border-l-2');
  });

  it('does not show flame when not hot even in diagnostic mode', () => {
    mockMode = 'diagnostic';
    const group = makeGroup();
    render(<ToolGroupItem group={group} isStepHot={false} />);

    expect(screen.queryByTestId('tool-group-flame')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tool-group-pct')).not.toBeInTheDocument();
  });
});
