import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { computeAutoName, TeamQuickAddButton } from './TeamQuickAddButton';
import type { QuickAddPayload } from './TeamQuickAddButton';

// ── Mocks ──

let _popoverOpen = false;
let _popoverOnOpenChange: ((v: boolean) => void) | undefined;

jest.mock('@/ui/components/ui/popover', () => ({
  Popover: ({
    children,
    open,
    onOpenChange,
  }: {
    children: React.ReactNode;
    open: boolean;
    onOpenChange: (v: boolean) => void;
  }) => {
    _popoverOpen = open;
    _popoverOnOpenChange = onOpenChange;
    return <>{children}</>;
  },
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => (
    <div onClick={() => _popoverOnOpenChange?.(true)} data-testid="popover-trigger">
      {children}
    </div>
  ),
  PopoverContent: ({ children }: { children: React.ReactNode }) =>
    _popoverOpen ? <div data-testid="popover-content">{children}</div> : null,
}));

jest.mock('@/ui/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <span data-testid="tooltip-content">{children}</span>
  ),
}));

// ── Helpers ──

function renderButton(overrides: Partial<React.ComponentProps<typeof TeamQuickAddButton>> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const defaultProps: React.ComponentProps<typeof TeamQuickAddButton> = {
    teamId: 'team-1',
    teamName: 'Alpha',
    teamLeadAgentId: 'agent-lead',
    profileIds: ['profile-1'],
    profilesById: new Map([['profile-1', { id: 'profile-1', name: 'Coder' }]]),
    agents: [],
    onAddAgent: jest.fn(),
    ...overrides,
  };
  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <TeamQuickAddButton {...defaultProps} />
      </QueryClientProvider>,
    ),
    queryClient,
    onAddAgent: defaultProps.onAddAgent as jest.Mock,
  };
}

// ── Pure function tests ──

describe('computeAutoName', () => {
  it('returns (1) when no agents exist', () => {
    expect(computeAutoName('Coder', [])).toBe('Coder (1)');
  });

  it('returns (1) when no matching agents exist', () => {
    expect(computeAutoName('Coder', ['Reviewer', 'Bot'])).toBe('Coder (1)');
  });

  it('returns (2) when (1) exists', () => {
    expect(computeAutoName('Coder', ['Coder (1)'])).toBe('Coder (2)');
  });

  it('fills gaps: (1) and (3) exist → returns (2)', () => {
    expect(computeAutoName('Coder', ['Coder (1)', 'Coder (3)'])).toBe('Coder (2)');
  });

  it('is case-insensitive', () => {
    expect(computeAutoName('Coder', ['coder (1)', 'CODER (2)'])).toBe('Coder (3)');
  });

  it('different profile names do not interfere', () => {
    expect(computeAutoName('Coder', ['Reviewer (1)', 'Reviewer (2)'])).toBe('Coder (1)');
  });

  it('handles special regex characters in profile name', () => {
    expect(computeAutoName('C++ Bot', ['C++ Bot (1)'])).toBe('C++ Bot (2)');
  });
});

// ── Component tests ──

describe('TeamQuickAddButton', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('is disabled with tooltip when profileIds is empty', () => {
    renderButton({ profileIds: [] });

    const button = screen.getByRole('button', { name: /Add agent to Alpha/i });
    expect(button).toBeDisabled();
    expect(screen.getByTestId('tooltip-content')).toHaveTextContent(
      'Link profiles to this team first',
    );
  });

  it('is disabled with tooltip when teamLeadAgentId is null', () => {
    renderButton({ teamLeadAgentId: null });

    const button = screen.getByRole('button', { name: /Add agent to Alpha/i });
    expect(button).toBeDisabled();
    expect(screen.getByTestId('tooltip-content')).toHaveTextContent('Assign a team lead first');
  });

  it('is not disabled when allowTeamLeadCreateAgents is false (flag is MCP-only)', () => {
    renderButton();

    const button = screen.getByRole('button', { name: /Add agent to Alpha/i });
    expect(button).not.toBeDisabled();
    expect(screen.getByTestId('tooltip-content')).toHaveTextContent('Add agent');
  });

  it('disabled button wrapper is focusable for tooltip hover/focus', () => {
    renderButton({ profileIds: [] });

    const button = screen.getByRole('button', { name: /Add agent to Alpha/i });
    const wrapper = button.closest('span');
    expect(wrapper).not.toBeNull();
    expect(wrapper).toHaveAttribute('tabindex', '0');

    fireEvent.mouseEnter(wrapper!);
    fireEvent.focus(wrapper!);
    expect(screen.getByTestId('tooltip-content')).toHaveTextContent(
      'Link profiles to this team first',
    );
  });

  it('disabled button wrapper is focusable for leadless tooltip', () => {
    renderButton({ teamLeadAgentId: null });

    const button = screen.getByRole('button', { name: /Add agent to Alpha/i });
    const wrapper = button.closest('span');
    expect(wrapper).not.toBeNull();
    expect(wrapper).toHaveAttribute('tabindex', '0');

    fireEvent.mouseEnter(wrapper!);
    fireEvent.focus(wrapper!);
    expect(screen.getByTestId('tooltip-content')).toHaveTextContent('Assign a team lead first');
  });

  it('clicking disabled button does not open popover or fire callback', () => {
    const { onAddAgent } = renderButton({ profileIds: [] });

    const button = screen.getByRole('button', { name: /Add agent to Alpha/i });
    fireEvent.click(button);

    expect(screen.queryByTestId('popover-content')).not.toBeInTheDocument();
    expect(onAddAgent).not.toHaveBeenCalled();
  });

  it('does not fetch configs when popover is closed', () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy;

    renderButton();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches configs when popover opens', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => [{ id: 'cfg-1', name: 'GPT-4', description: null, profileId: 'profile-1' }],
    })) as unknown as typeof fetch;

    renderButton();

    fireEvent.click(screen.getByRole('button', { name: /Add agent to Alpha/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/profiles/profile-1/provider-configs'),
      );
    });
  });

  it('groups configs by profile and skips empty profiles', async () => {
    const profilesById = new Map([
      ['profile-1', { id: 'profile-1', name: 'Coder' }],
      ['profile-2', { id: 'profile-2', name: 'Reviewer' }],
    ]);

    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('profile-1')) {
        return {
          ok: true,
          json: async () => [
            { id: 'cfg-1', name: 'GPT-4', description: null, profileId: 'profile-1' },
          ],
        };
      }
      // profile-2 returns empty
      return { ok: true, json: async () => [] };
    }) as unknown as typeof fetch;

    renderButton({ profileIds: ['profile-1', 'profile-2'], profilesById });

    fireEvent.click(screen.getByRole('button', { name: /Add agent to Alpha/i }));

    await waitFor(() => {
      expect(screen.getByText('Coder')).toBeInTheDocument();
    });
    expect(screen.getByText('GPT-4')).toBeInTheDocument();
    expect(screen.queryByText('Reviewer')).not.toBeInTheDocument();
  });

  it('renders empty state when all profiles return zero configs', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => [],
    })) as unknown as typeof fetch;

    renderButton();

    fireEvent.click(screen.getByRole('button', { name: /Add agent to Alpha/i }));

    await waitFor(() => {
      expect(
        screen.getByText('No provider configs available. Create one in Profiles first.'),
      ).toBeInTheDocument();
    });
  });

  it('calls onAddAgent with correct payload when config is clicked', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => [{ id: 'cfg-1', name: 'GPT-4', description: null, profileId: 'profile-1' }],
    })) as unknown as typeof fetch;

    const { onAddAgent } = renderButton({ agents: [{ name: 'Coder (1)' }] });

    fireEvent.click(screen.getByRole('button', { name: /Add agent to Alpha/i }));

    await waitFor(() => {
      expect(screen.getByText('GPT-4')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('GPT-4'));

    expect(onAddAgent).toHaveBeenCalledWith({
      teamId: 'team-1',
      teamName: 'Alpha',
      providerConfigId: 'cfg-1',
      profileId: 'profile-1',
      profileName: 'Coder',
      computedName: 'Coder (2)',
    } satisfies QuickAddPayload);
  });
});
