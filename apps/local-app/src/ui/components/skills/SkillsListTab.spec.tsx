import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { SkillListItem } from '@/ui/lib/skills';
import { SkillsListTab } from './SkillsListTab';

const PROJECT_ID = '00000000-0000-0000-0000-0000000000cc';
const fetchMock = jest.fn();
const fetchSkillsMock = jest.fn();
const disableSkillMock = jest.fn();
const enableSkillMock = jest.fn();
const disableAllSkillsMock = jest.fn();
const enableAllSkillsMock = jest.fn();

jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => ({ selectedProjectId: PROJECT_ID }),
}));

jest.mock('@/ui/hooks/useFetchFactory', () => ({
  useFetchFactory: () => fetchMock,
}));

jest.mock('./SyncButton', () => ({
  SyncButton: () => null,
}));

jest.mock('@/ui/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: ReactElement }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactElement }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactElement }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactElement }) => <>{children}</>,
}));

jest.mock('@/ui/lib/skills', () => {
  const actual = jest.requireActual('@/ui/lib/skills');
  return {
    ...actual,
    fetchSkills: (...args: unknown[]) => fetchSkillsMock(...args),
    disableSkill: (...args: unknown[]) => disableSkillMock(...args),
    enableSkill: (...args: unknown[]) => enableSkillMock(...args),
    disableAllSkills: (...args: unknown[]) => disableAllSkillsMock(...args),
    enableAllSkills: (...args: unknown[]) => enableAllSkillsMock(...args),
  };
});

function makeSkill(overrides: Partial<SkillListItem>): SkillListItem {
  return {
    id: 'skill-id',
    slug: 'source/name',
    name: 'name',
    displayName: 'Name',
    description: null,
    shortDescription: null,
    source: 'source',
    category: null,
    status: 'available',
    disabled: false,
    ...overrides,
  } as SkillListItem;
}

function renderTab() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <SkillsListTab />
    </QueryClientProvider>,
  );
}

describe('SkillsListTab', () => {
  beforeEach(() => {
    fetchSkillsMock.mockReset();
    disableSkillMock.mockReset().mockResolvedValue(undefined);
    enableSkillMock.mockReset().mockResolvedValue(undefined);
    disableAllSkillsMock.mockReset();
    enableAllSkillsMock.mockReset();
  });

  it('locks a DevChain skill on and keeps a devchain-local skill toggleable', async () => {
    fetchSkillsMock.mockResolvedValue([
      // A stale "off" flag still renders on: the lock comes from the source name.
      makeSkill({
        id: 'skill-dc',
        slug: 'devchain/code-simplifier',
        name: 'code-simplifier',
        displayName: 'Code Simplifier',
        source: 'devchain',
        disabled: true,
      }),
      makeSkill({
        id: 'skill-dcl',
        slug: 'devchain-local/helper',
        name: 'helper',
        displayName: 'Helper',
        source: 'devchain-local',
      }),
    ]);

    renderTab();

    const locked = await screen.findByRole('switch', {
      name: 'Skill Code Simplifier is always on',
    });
    expect(locked).toBeChecked();
    expect(locked).toBeDisabled();
    expect(screen.getByText('Built-in DevChain skills are always on')).toBeInTheDocument();
    expect(screen.queryByText('Disabled')).toBeNull();
    fireEvent.click(locked);

    const unlocked = screen.getByRole('switch', { name: 'Enable or disable skill Helper' });
    expect(unlocked).toBeChecked();
    expect(unlocked).toBeEnabled();
    fireEvent.click(unlocked);

    await waitFor(() => {
      expect(disableSkillMock).toHaveBeenCalledWith(fetchMock, PROJECT_ID, 'skill-dcl');
    });
    expect(disableSkillMock).toHaveBeenCalledTimes(1);
    expect(enableSkillMock).not.toHaveBeenCalled();
  });

  it('says in the "Disable all" confirmation that DevChain skills stay on', async () => {
    fetchSkillsMock.mockResolvedValue([makeSkill({ id: 'skill-a' })]);

    renderTab();

    await screen.findByRole('switch', { name: 'Enable or disable skill Name' });
    fireEvent.click(screen.getByRole('button', { name: 'Disable All' }));

    expect(
      await screen.findByText(/Built-in DevChain skills\s+stay on\./, { exact: false }),
    ).toBeInTheDocument();
  });
});
