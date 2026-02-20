import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CreateWorktreeDialog } from '../../modules/orchestrator/ui/app/orchestrator-app';

jest.mock('@radix-ui/react-dialog', () => {
  const actual = jest.requireActual('@radix-ui/react-dialog');
  return {
    ...actual,
    Portal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

function renderWithClient(ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

function buildProps(overrides: Partial<React.ComponentProps<typeof CreateWorktreeDialog>> = {}) {
  return {
    open: true,
    onOpenChange: jest.fn(),
    templates: [{ slug: '3-agent-dev', name: '3-Agent Dev' }],
    baseBranchOptions: ['main'],
    isBranchesLoading: false,
    branchesError: null,
    isTemplatesLoading: false,
    templatesError: null,
    dockerAvailable: true,
    isSubmitting: false,
    onSubmit: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('CreateWorktreeDialog docker runtime selection', () => {
  it('defaults docker checkbox to checked and enabled when docker is available', () => {
    renderWithClient(<CreateWorktreeDialog {...buildProps({ dockerAvailable: true })} />);

    const checkbox = screen.getByRole('checkbox', { name: /use docker container/i });
    expect(checkbox).toHaveAttribute('data-state', 'checked');
    expect(checkbox).not.toBeDisabled();
  });

  it('disables docker checkbox and shows helper text when docker is unavailable', () => {
    renderWithClient(<CreateWorktreeDialog {...buildProps({ dockerAvailable: false })} />);

    const checkbox = screen.getByRole('checkbox', { name: /use docker container/i });
    expect(checkbox).toHaveAttribute('data-state', 'unchecked');
    expect(checkbox).toBeDisabled();
    expect(
      screen.getByText(
        'Docker is required for container isolation. Worktree will run as a host process.',
      ),
    ).toBeInTheDocument();
  });

  it('submits runtimeType=container by default when docker is available', async () => {
    const onSubmit = jest.fn().mockResolvedValue(undefined);
    renderWithClient(<CreateWorktreeDialog {...buildProps({ dockerAvailable: true, onSubmit })} />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'feature-auth' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'feature-auth',
          branchName: 'feature-auth',
          baseBranch: 'main',
          templateSlug: '3-agent-dev',
          runtimeType: 'container',
        }),
      );
    });
  });

  it('submits runtimeType=process when docker checkbox is unchecked', async () => {
    const onSubmit = jest.fn().mockResolvedValue(undefined);
    renderWithClient(<CreateWorktreeDialog {...buildProps({ dockerAvailable: true, onSubmit })} />);

    fireEvent.click(screen.getByRole('checkbox', { name: /use docker container/i }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'feature-auth' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimeType: 'process',
        }),
      );
    });
  });
});
