import { render, screen, fireEvent } from '@testing-library/react';
import { InputSourceSelector } from './InputSourceSelector';
import type { ActionInput as ActionInputDef, EventFieldDefinition } from '@/ui/lib/actions';

describe('InputSourceSelector', () => {
  const mockEventFields: EventFieldDefinition[] = [
    { field: 'agentName', label: 'Agent Name', type: 'string' },
    { field: 'sessionId', label: 'Session ID', type: 'string' },
    { field: 'viewportSnippet', label: 'Viewport Content', type: 'string' },
  ];

  describe('string input (template editor)', () => {
    const stringInputDef: ActionInputDef = {
      name: 'text',
      label: 'Text',
      description: 'Enter text',
      type: 'string',
      required: true,
    };

    it('should render template editor without toggle buttons', () => {
      const onChange = jest.fn();
      render(
        <InputSourceSelector
          inputDef={stringInputDef}
          value={{ source: 'custom', customValue: '' }}
          onChange={onChange}
          availableEventFields={mockEventFields}
        />,
      );

      // Should have input field
      expect(screen.getByRole('textbox')).toBeInTheDocument();

      // Should NOT have Custom/Event Field toggle buttons
      expect(screen.queryByRole('button', { name: 'Custom' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Event Field' })).not.toBeInTheDocument();

      // Should have variable selector
      expect(screen.getByText('Select variable...')).toBeInTheDocument();
    });

    it('should display template syntax hint when event fields are available', () => {
      render(
        <InputSourceSelector
          inputDef={stringInputDef}
          value={{ source: 'custom', customValue: '' }}
          onChange={jest.fn()}
          availableEventFields={mockEventFields}
        />,
      );

      expect(screen.getByText(/syntax to insert event/)).toBeInTheDocument();
    });

    it('should not display variable selector when no event fields', () => {
      render(
        <InputSourceSelector
          inputDef={stringInputDef}
          value={{ source: 'custom', customValue: '' }}
          onChange={jest.fn()}
          availableEventFields={[]}
        />,
      );

      expect(screen.queryByText('Select variable...')).not.toBeInTheDocument();
    });

    it('should allow typing in the input field', async () => {
      const onChange = jest.fn();
      render(
        <InputSourceSelector
          inputDef={stringInputDef}
          value={{ source: 'custom', customValue: '' }}
          onChange={onChange}
          availableEventFields={mockEventFields}
        />,
      );

      const input = screen.getByRole('textbox');
      fireEvent.change(input, { target: { value: 'Hello World' } });

      expect(onChange).toHaveBeenCalledWith({
        source: 'custom',
        customValue: 'Hello World',
        eventField: undefined,
      });
    });

    it('should display current value', () => {
      render(
        <InputSourceSelector
          inputDef={stringInputDef}
          value={{ source: 'custom', customValue: 'Hello {{agentName}}' }}
          onChange={jest.fn()}
          availableEventFields={mockEventFields}
        />,
      );

      expect(screen.getByDisplayValue('Hello {{agentName}}')).toBeInTheDocument();
    });

    it('should have Insert button disabled when no variable selected', () => {
      render(
        <InputSourceSelector
          inputDef={stringInputDef}
          value={{ source: 'custom', customValue: '' }}
          onChange={jest.fn()}
          availableEventFields={mockEventFields}
        />,
      );

      const insertButton = screen.getByRole('button', { name: 'Insert' });
      expect(insertButton).toBeDisabled();
    });
  });

  describe('textarea input (template editor)', () => {
    const textareaInputDef: ActionInputDef = {
      name: 'message',
      label: 'Message',
      description: 'Enter message',
      type: 'textarea',
      required: false,
    };

    it('should render textarea for textarea type', () => {
      render(
        <InputSourceSelector
          inputDef={textareaInputDef}
          value={{ source: 'custom', customValue: '' }}
          onChange={jest.fn()}
          availableEventFields={mockEventFields}
        />,
      );

      // Textarea should be present
      const textarea = screen.getByRole('textbox');
      expect(textarea.tagName.toLowerCase()).toBe('textarea');
    });

    it('should render textarea for string type with message in name', () => {
      const messageInputDef: ActionInputDef = {
        name: 'customMessage',
        label: 'Custom Message',
        description: 'Enter a message',
        type: 'string',
        required: false,
      };

      render(
        <InputSourceSelector
          inputDef={messageInputDef}
          value={{ source: 'custom', customValue: '' }}
          onChange={jest.fn()}
          availableEventFields={mockEventFields}
        />,
      );

      const textarea = screen.getByRole('textbox');
      expect(textarea.tagName.toLowerCase()).toBe('textarea');
    });
  });

  describe('select input (with toggle)', () => {
    const selectInputDef: ActionInputDef = {
      name: 'submitKey',
      label: 'Submit Key',
      description: 'Select submit key',
      type: 'select',
      required: true,
      options: [
        { value: 'Enter', label: 'Enter' },
        { value: 'Ctrl+Enter', label: 'Ctrl+Enter' },
      ],
    };

    it('should render toggle buttons for select input', () => {
      render(
        <InputSourceSelector
          inputDef={selectInputDef}
          value={{ source: 'custom', customValue: '' }}
          onChange={jest.fn()}
          availableEventFields={mockEventFields}
        />,
      );

      expect(screen.getByRole('button', { name: 'Custom' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Event Field' })).toBeInTheDocument();
    });

    it('should show select dropdown when custom source selected', () => {
      render(
        <InputSourceSelector
          inputDef={selectInputDef}
          value={{ source: 'custom', customValue: '' }}
          onChange={jest.fn()}
          availableEventFields={mockEventFields}
        />,
      );

      // Should have combobox (select trigger)
      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });

    it('should switch to event field selector when Event Field clicked', async () => {
      const onChange = jest.fn();
      render(
        <InputSourceSelector
          inputDef={selectInputDef}
          value={{ source: 'custom', customValue: 'Enter' }}
          onChange={onChange}
          availableEventFields={mockEventFields}
        />,
      );

      const eventFieldButton = screen.getByRole('button', { name: 'Event Field' });
      fireEvent.click(eventFieldButton);

      expect(onChange).toHaveBeenCalledWith({
        source: 'event_field',
        customValue: undefined,
        eventField: '',
      });
    });
  });

  describe('number input (with toggle)', () => {
    const numberInputDef: ActionInputDef = {
      name: 'count',
      label: 'Count',
      description: 'Enter count',
      type: 'number',
      required: false,
    };

    it('should render toggle buttons for number input', () => {
      render(
        <InputSourceSelector
          inputDef={numberInputDef}
          value={{ source: 'custom', customValue: '' }}
          onChange={jest.fn()}
          availableEventFields={mockEventFields}
        />,
      );

      expect(screen.getByRole('button', { name: 'Custom' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Event Field' })).toBeInTheDocument();
    });

    it('should show number input when custom source selected', () => {
      render(
        <InputSourceSelector
          inputDef={numberInputDef}
          value={{ source: 'custom', customValue: '42' }}
          onChange={jest.fn()}
          availableEventFields={mockEventFields}
        />,
      );

      const input = screen.getByRole('spinbutton');
      expect(input).toHaveValue(42);
    });
  });

  describe('boolean input (with toggle)', () => {
    const booleanInputDef: ActionInputDef = {
      name: 'enabled',
      label: 'Enabled',
      description: 'Enable feature',
      type: 'boolean',
      required: false,
    };

    it('should render toggle buttons for boolean input', () => {
      render(
        <InputSourceSelector
          inputDef={booleanInputDef}
          value={{ source: 'custom', customValue: '' }}
          onChange={jest.fn()}
          availableEventFields={mockEventFields}
        />,
      );

      expect(screen.getByRole('button', { name: 'Custom' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Event Field' })).toBeInTheDocument();
    });

    it('should show checkbox when custom source selected', () => {
      render(
        <InputSourceSelector
          inputDef={booleanInputDef}
          value={{ source: 'custom', customValue: 'true' }}
          onChange={jest.fn()}
          availableEventFields={mockEventFields}
        />,
      );

      const checkbox = screen.getByRole('checkbox');
      expect(checkbox).toBeChecked();
    });
  });

  describe('allowedSources behavior', () => {
    it('should hide toggle for custom-only select input', () => {
      const customOnlySelectDef: ActionInputDef = {
        name: 'submitKey',
        label: 'Submit Key',
        description: 'Select submit key',
        type: 'select',
        required: false,
        options: [
          { value: 'Enter', label: 'Enter' },
          { value: 'none', label: 'None' },
        ],
        allowedSources: ['custom'],
      };

      render(
        <InputSourceSelector
          inputDef={customOnlySelectDef}
          value={{ source: 'custom', customValue: 'Enter' }}
          onChange={jest.fn()}
          availableEventFields={mockEventFields}
        />,
      );

      // Should NOT have toggle buttons
      expect(screen.queryByRole('button', { name: 'Custom' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Event Field' })).not.toBeInTheDocument();

      // Should have the select dropdown
      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });

    it('should show toggle for select input without allowedSources', () => {
      const selectWithoutAllowedSources: ActionInputDef = {
        name: 'option',
        label: 'Option',
        description: 'Select option',
        type: 'select',
        required: false,
        options: [{ value: 'a', label: 'A' }],
        // No allowedSources - defaults to both
      };

      render(
        <InputSourceSelector
          inputDef={selectWithoutAllowedSources}
          value={{ source: 'custom', customValue: '' }}
          onChange={jest.fn()}
          availableEventFields={mockEventFields}
        />,
      );

      // Should have toggle buttons
      expect(screen.getByRole('button', { name: 'Custom' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Event Field' })).toBeInTheDocument();
    });

    it('should show toggle for select input with both sources allowed', () => {
      const selectWithBothSources: ActionInputDef = {
        name: 'option',
        label: 'Option',
        description: 'Select option',
        type: 'select',
        required: false,
        options: [{ value: 'a', label: 'A' }],
        allowedSources: ['custom', 'event_field'],
      };

      render(
        <InputSourceSelector
          inputDef={selectWithBothSources}
          value={{ source: 'custom', customValue: '' }}
          onChange={jest.fn()}
          availableEventFields={mockEventFields}
        />,
      );

      // Should have toggle buttons
      expect(screen.getByRole('button', { name: 'Custom' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Event Field' })).toBeInTheDocument();
    });

    it('should hide toggle for custom-only number input', () => {
      const customOnlyNumberDef: ActionInputDef = {
        name: 'count',
        label: 'Count',
        description: 'Enter count',
        type: 'number',
        required: false,
        allowedSources: ['custom'],
      };

      render(
        <InputSourceSelector
          inputDef={customOnlyNumberDef}
          value={{ source: 'custom', customValue: '42' }}
          onChange={jest.fn()}
          availableEventFields={mockEventFields}
        />,
      );

      // Should NOT have toggle buttons
      expect(screen.queryByRole('button', { name: 'Custom' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Event Field' })).not.toBeInTheDocument();

      // Should have the number input
      expect(screen.getByRole('spinbutton')).toBeInTheDocument();
    });
  });

  describe('error display', () => {
    const stringInputDef: ActionInputDef = {
      name: 'text',
      label: 'Text',
      description: 'Enter text',
      type: 'string',
      required: true,
    };

    it('should display error message', () => {
      render(
        <InputSourceSelector
          inputDef={stringInputDef}
          value={{ source: 'custom', customValue: '' }}
          onChange={jest.fn()}
          availableEventFields={mockEventFields}
          error="This field is required"
        />,
      );

      expect(screen.getByText('This field is required')).toBeInTheDocument();
    });
  });

  describe('required indicator', () => {
    it('should show required indicator for required inputs', () => {
      const requiredInputDef: ActionInputDef = {
        name: 'text',
        label: 'Text',
        description: 'Enter text',
        type: 'string',
        required: true,
      };

      render(
        <InputSourceSelector
          inputDef={requiredInputDef}
          value={{ source: 'custom', customValue: '' }}
          onChange={jest.fn()}
          availableEventFields={mockEventFields}
        />,
      );

      expect(screen.getByText('*')).toBeInTheDocument();
    });

    it('should not show required indicator for optional inputs', () => {
      const optionalInputDef: ActionInputDef = {
        name: 'text',
        label: 'Text',
        description: 'Enter text',
        type: 'string',
        required: false,
      };

      render(
        <InputSourceSelector
          inputDef={optionalInputDef}
          value={{ source: 'custom', customValue: '' }}
          onChange={jest.fn()}
          availableEventFields={mockEventFields}
        />,
      );

      expect(screen.queryByText('*')).not.toBeInTheDocument();
    });
  });
});
