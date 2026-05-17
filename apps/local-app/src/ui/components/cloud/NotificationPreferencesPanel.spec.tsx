import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let mockSmartSuppressionState = { enabled: true, windowMinutes: 5 };
let mockSmartSuppressionLoading = false;
let mockSmartSuppressionPending = false;
let mockSmartSuppressionError = false;
const mockSmartSuppressionMutate = jest.fn();

jest.mock('@/ui/hooks/useNotificationPreferences', () => ({
  ...jest.requireActual('@/ui/hooks/useNotificationPreferences'),
  useNotificationPreferences: () => ({
    preferences: [],
    catalog: jest.requireActual('@/ui/hooks/useNotificationPreferences')
      .STATIC_NOTIFICATION_CATALOG,
    isLoading: false,
    upsert: { mutate: jest.fn(), isPending: false, isError: false },
  }),
}));

jest.mock('@/ui/hooks/useSmartSuppression', () => ({
  useSmartSuppression: () => ({
    smartSuppression: mockSmartSuppressionState,
    isLoading: mockSmartSuppressionLoading,
    upsert: {
      mutate: mockSmartSuppressionMutate,
      isPending: mockSmartSuppressionPending,
      isError: mockSmartSuppressionError,
    },
  }),
}));

jest.mock('@/ui/hooks/useQuietHours', () => ({
  useQuietHours: () => ({
    quietHours: null,
    isLoading: false,
    upsert: { mutate: jest.fn(), isPending: false },
  }),
}));

jest.mock('../ui/select', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const React = require('react');

  interface SelectTriggerProps {
    id?: string;
    'aria-label'?: string;
    children: React.ReactNode;
  }

  interface SelectContentProps {
    children: React.ReactNode;
  }

  interface SelectItemProps {
    value: string;
    children: React.ReactNode;
  }

  interface SelectProps {
    value: string;
    disabled?: boolean;
    onValueChange?: (value: string) => void;
    children: React.ReactNode;
  }

  interface SelectValueProps {
    placeholder?: string;
  }

  const SelectTrigger = ({ children }: SelectTriggerProps) => <>{children}</>;
  SelectTrigger.__SELECT_TRIGGER = true;

  const SelectContent = ({ children }: SelectContentProps) => <>{children}</>;
  SelectContent.__SELECT_CONTENT = true;

  const SelectItem = ({ value, children }: SelectItemProps) => (
    <option value={value}>{children}</option>
  );
  SelectItem.__SELECT_ITEM = true;

  const collect = (
    nodes: React.ReactNode,
  ): {
    options: React.ReactNode[];
    triggerProps: Pick<SelectTriggerProps, 'id' | 'aria-label'>;
  } => {
    const options: React.ReactNode[] = [];
    let triggerProps: Pick<SelectTriggerProps, 'id' | 'aria-label'> = {};

    React.Children.forEach(nodes, (child: React.ReactElement) => {
      if (!child?.type) return;
      if (child.type.__SELECT_TRIGGER) {
        triggerProps = { id: child.props.id, 'aria-label': child.props['aria-label'] };
      }
      if (child.type.__SELECT_CONTENT || child.type.__SELECT_TRIGGER) {
        const nested = collect(child.props.children);
        options.push(...nested.options);
        triggerProps = { ...triggerProps, ...nested.triggerProps };
      } else if (child.type.__SELECT_ITEM) {
        options.push(
          <option key={child.props.value} value={child.props.value}>
            {child.props.children}
          </option>,
        );
      }
    });

    return { options, triggerProps };
  };

  const Select = ({ value, disabled, onValueChange, children }: SelectProps) => {
    const { options, triggerProps } = collect(children);
    return (
      <select
        id={triggerProps.id}
        aria-label={triggerProps['aria-label']}
        value={value}
        disabled={disabled}
        onChange={(event) => onValueChange?.(event.target.value)}
      >
        {options}
      </select>
    );
  };

  const SelectValue = ({ placeholder }: SelectValueProps) => <>{placeholder}</>;

  return { Select, SelectTrigger, SelectContent, SelectItem, SelectValue };
});

import { NotificationPreferencesPanel } from './NotificationPreferencesPanel';

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <NotificationPreferencesPanel />
    </QueryClientProvider>,
  );
}

describe('NotificationPreferencesPanel', () => {
  beforeEach(() => {
    mockSmartSuppressionState = { enabled: true, windowMinutes: 5 };
    mockSmartSuppressionLoading = false;
    mockSmartSuppressionPending = false;
    mockSmartSuppressionError = false;
    mockSmartSuppressionMutate.mockReset();
  });

  it('renders the section heading', () => {
    renderPanel();
    expect(screen.getByText(/push alert rules/i)).toBeInTheDocument();
    expect(screen.getByText(/inbox history is still kept/i)).toBeInTheDocument();
  });

  it('frames notification rules in a cloud settings card', () => {
    renderPanel();

    const card = screen.getByTestId('notification-rules-card');
    expect(card).toHaveClass('rounded-lg', 'border', 'bg-card');
    expect(card).toContainElement(screen.getByRole('heading', { name: /push alert rules/i }));
    expect(card).toContainElement(screen.getByText('Smart notifications'));
    expect(card).toContainElement(screen.getByLabelText(/push notifications for epic assigned/i));
  });

  it('renders category toggle rows', () => {
    renderPanel();
    expect(screen.getByLabelText(/push notifications for epic assigned/i)).toBeInTheDocument();
  });

  it('does not render quiet hours section', () => {
    renderPanel();
    expect(screen.queryByText(/quiet hours/i)).not.toBeInTheDocument();
  });

  it('renders smart notification controls with accessible labels and default window', () => {
    renderPanel();

    expect(screen.getByText('Smart notifications')).toBeInTheDocument();
    expect(
      screen.getByText(/pause push notifications for projects you are actively using/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/inbox items still appear/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/enable smart notifications/i)).toBeChecked();
    expect(screen.getByLabelText(/smart notifications activity window/i)).toHaveValue('5');
    expect(screen.getByRole('option', { name: '5 minutes' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '10 minutes' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '15 minutes' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '30 minutes' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '60 minutes' })).not.toBeInTheDocument();
  });

  it('persists smart notification toggle changes through useSmartSuppression', () => {
    renderPanel();

    fireEvent.click(screen.getByLabelText(/enable smart notifications/i));

    expect(mockSmartSuppressionMutate).toHaveBeenCalledWith(
      { enabled: false, windowMinutes: 5 },
      expect.objectContaining({
        onError: expect.any(Function),
        onSuccess: expect.any(Function),
      }),
    );
  });

  it('persists smart notification window changes through useSmartSuppression', () => {
    renderPanel();

    fireEvent.change(screen.getByLabelText(/smart notifications activity window/i), {
      target: { value: '15' },
    });

    expect(mockSmartSuppressionMutate).toHaveBeenCalledWith(
      { enabled: true, windowMinutes: 15 },
      expect.objectContaining({
        onError: expect.any(Function),
        onSuccess: expect.any(Function),
      }),
    );
  });

  it('renders deterministic pending state and disables smart controls', () => {
    mockSmartSuppressionPending = true;

    renderPanel();

    expect(screen.getByRole('status')).toHaveTextContent(/saving smart notification settings/i);
    expect(screen.getByLabelText(/enable smart notifications/i)).toBeDisabled();
    expect(screen.getByLabelText(/smart notifications activity window/i)).toBeDisabled();
  });

  it('disables the activity window selector when smart notifications are off', () => {
    mockSmartSuppressionState = { enabled: false, windowMinutes: 5 };

    renderPanel();

    expect(screen.getByLabelText(/enable smart notifications/i)).not.toBeChecked();
    expect(screen.getByLabelText(/smart notifications activity window/i)).toBeDisabled();
  });

  it('rolls back local smart notification changes and surfaces an error on failure', () => {
    mockSmartSuppressionMutate.mockImplementation((_next, options) => options.onError());

    renderPanel();
    const toggle = screen.getByLabelText(/enable smart notifications/i);

    fireEvent.click(toggle);

    expect(toggle).toBeChecked();
    expect(screen.getByRole('alert')).toHaveTextContent(
      /could not save smart notification settings/i,
    );
  });

  it('does not render a global test push button', () => {
    renderPanel();
    expect(screen.queryByRole('button', { name: /send test push/i })).not.toBeInTheDocument();
  });
});
