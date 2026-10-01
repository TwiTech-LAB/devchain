/** @jest-environment jsdom */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ProjectWorkspace } from '@/ui/hooks/useProjectSelection';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';

function workspace(id: string, name: string, position: number): ProjectWorkspace {
  return {
    id,
    name,
    position,
    isDefault: position === 0,
    projectCount: 0,
    deviceGrantCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const workspaces = [workspace('alpha', 'Alpha', 0), workspace('archive', 'Archive', 1)];
const colorWorkspaces = [...workspaces, workspace('production', 'Production', 2)];
const colorFamilies = [
  'sky',
  'cyan',
  'teal',
  'blue',
  'indigo',
  'violet',
  'purple',
  'fuchsia',
] as const;

function workspaceColorFamily(button: HTMLElement): (typeof colorFamilies)[number] | undefined {
  return colorFamilies.find((family) => button.className.includes(`border-${family}-500`));
}

describe('WorkspaceSwitcher', () => {
  it('renders nothing for a single workspace', () => {
    render(
      <WorkspaceSwitcher
        workspaces={[workspaces[0]]}
        selectedWorkspaceId="alpha"
        onSelect={jest.fn()}
      />,
    );

    expect(screen.queryByRole('toolbar', { name: 'Switch workspace' })).not.toBeInTheDocument();
  });

  it('preserves order and distinguishes repeated initials with full accessible names', async () => {
    const user = userEvent.setup();
    render(
      <WorkspaceSwitcher
        workspaces={workspaces}
        selectedWorkspaceId="archive"
        onSelect={jest.fn()}
      />,
    );

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toHaveAccessibleName('Switch to workspace Alpha');
    expect(buttons[1]).toHaveAccessibleName('Switch to workspace Archive');
    expect(buttons[0]).toHaveTextContent('A');
    expect(buttons[1]).toHaveTextContent('A');
    expect(buttons[0]).toHaveAttribute('title', 'Alpha');
    expect(buttons[1]).toHaveAttribute('title', 'Archive');
    expect(buttons[0]).toHaveAttribute('aria-pressed', 'false');
    expect(buttons[1]).toHaveAttribute('aria-pressed', 'true');

    await user.hover(buttons[0]);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Alpha');
  });

  it('selects by mouse and keyboard without navigation side effects', async () => {
    const user = userEvent.setup();
    const onSelect = jest.fn();
    render(
      <WorkspaceSwitcher workspaces={workspaces} selectedWorkspaceId="alpha" onSelect={onSelect} />,
    );

    const alpha = screen.getByRole('button', { name: 'Switch to workspace Alpha' });
    const archive = screen.getByRole('button', { name: 'Switch to workspace Archive' });

    await user.click(archive);
    expect(onSelect).toHaveBeenLastCalledWith('archive');

    alpha.focus();
    await user.keyboard('{ArrowRight}');
    expect(archive).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenLastCalledWith('archive');

    await user.keyboard('{Home}');
    expect(alpha).toHaveFocus();
    await user.keyboard('{End}');
    expect(archive).toHaveFocus();
  });

  it('renders muted 32px square tiles with stable name-derived colors', () => {
    const { rerender } = render(
      <WorkspaceSwitcher
        workspaces={colorWorkspaces}
        selectedWorkspaceId="archive"
        onSelect={jest.fn()}
      />,
    );

    const toolbar = screen.getByRole('toolbar', { name: 'Switch workspace' });
    const alpha = screen.getByRole('button', { name: 'Switch to workspace Alpha' });
    const archive = screen.getByRole('button', { name: 'Switch to workspace Archive' });
    const production = screen.getByRole('button', { name: 'Switch to workspace Production' });

    expect(toolbar).toHaveClass('-space-x-1');
    expect(toolbar).not.toHaveClass('-space-x-2');
    for (const button of [alpha, archive, production]) {
      expect(button).toHaveClass('h-8', 'w-8', 'rounded-md', 'font-bold');
      expect(button).not.toHaveClass('h-10', 'w-10', 'rounded-full', 'bg-primary');
    }

    expect(workspaceColorFamily(alpha)).toBe('purple');
    expect(workspaceColorFamily(archive)).toBe('teal');
    expect(workspaceColorFamily(production)).toBe('cyan');

    rerender(
      <WorkspaceSwitcher
        workspaces={[colorWorkspaces[2], colorWorkspaces[1], colorWorkspaces[0]]}
        selectedWorkspaceId="archive"
        onSelect={jest.fn()}
      />,
    );

    expect(
      workspaceColorFamily(screen.getByRole('button', { name: 'Switch to workspace Alpha' })),
    ).toBe('purple');
    expect(
      workspaceColorFamily(screen.getByRole('button', { name: 'Switch to workspace Archive' })),
    ).toBe('teal');
    expect(
      workspaceColorFamily(screen.getByRole('button', { name: 'Switch to workspace Production' })),
    ).toBe('cyan');
  });

  it('normalizes whitespace, case, and compatibility-equivalent names before hashing', () => {
    render(
      <WorkspaceSwitcher
        workspaces={[
          workspace('alpha-lower', 'alpha', 0),
          workspace('alpha-padded', ' Alpha ', 1),
          workspace('alpha-full-width', 'ＡＬＰＨＡ', 2),
        ]}
        selectedWorkspaceId="alpha-lower"
        onSelect={jest.fn()}
      />,
    );

    const families = screen.getAllByRole('button').map(workspaceColorFamily);
    expect(families).toEqual(['purple', 'purple', 'purple']);
  });

  it('keeps identity colors while selection changes intensity and ring state', () => {
    const { rerender } = render(
      <WorkspaceSwitcher
        workspaces={workspaces}
        selectedWorkspaceId="alpha"
        onSelect={jest.fn()}
      />,
    );

    let alpha = screen.getByRole('button', { name: 'Switch to workspace Alpha' });
    let archive = screen.getByRole('button', { name: 'Switch to workspace Archive' });

    expect(alpha).toHaveClass(
      'border-purple-500/50',
      'bg-purple-500/20',
      'text-purple-900',
      'hover:bg-purple-500/30',
      'hover:text-purple-900',
      'dark:text-purple-200',
      'dark:hover:text-purple-200',
      'ring-1',
      'ring-foreground/40',
      'ring-offset-1',
      'focus-visible:ring-2',
      'focus-visible:ring-ring',
      'focus-visible:ring-offset-2',
    );
    expect(archive).toHaveClass(
      'border-teal-500/30',
      'bg-teal-500/10',
      'text-teal-800',
      'hover:bg-teal-500/20',
      'hover:text-teal-900',
      'dark:text-teal-300',
      'dark:hover:text-teal-200',
    );
    expect(archive).not.toHaveClass('ring-1');

    rerender(
      <WorkspaceSwitcher
        workspaces={workspaces}
        selectedWorkspaceId="archive"
        onSelect={jest.fn()}
      />,
    );

    alpha = screen.getByRole('button', { name: 'Switch to workspace Alpha' });
    archive = screen.getByRole('button', { name: 'Switch to workspace Archive' });

    expect(workspaceColorFamily(alpha)).toBe('purple');
    expect(alpha).toHaveClass('bg-purple-500/10', 'text-purple-800');
    expect(alpha).not.toHaveClass('ring-1');
    expect(workspaceColorFamily(archive)).toBe('teal');
    expect(archive).toHaveClass('bg-teal-500/20', 'text-teal-900', 'ring-1');
  });
});
