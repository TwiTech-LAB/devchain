import { fireEvent, render, screen } from '@testing-library/react';
import { EditProjectDialog } from './EditProjectDialog';

const defaultProps = {
  open: true,
  onOpenChange: jest.fn(),
  formData: {
    name: 'Test Project',
    description: '',
    rootPath: '/tmp/test',
    isTemplate: false,
  },
  onNameChange: jest.fn(),
  onDescriptionChange: jest.fn(),
  onIsTemplateChange: jest.fn(),
  pathValidation: { isAbsolute: true, exists: true, checked: true },
  onPathChange: jest.fn(),
  onSubmit: jest.fn(),
  onCancel: jest.fn(),
  isSubmitting: false,
};

describe('EditProjectDialog', () => {
  it('renders the dialog with form fields', () => {
    render(<EditProjectDialog {...defaultProps} />);

    expect(screen.getByLabelText('Name *')).toHaveValue('Test Project');
    expect(screen.getByLabelText('Root Path *')).toHaveValue('/tmp/test');
  });

  it('renders template state and emits its semantic change', () => {
    const onIsTemplateChange = jest.fn();
    render(
      <EditProjectDialog
        {...defaultProps}
        formData={{ ...defaultProps.formData, isTemplate: true }}
        onIsTemplateChange={onIsTemplateChange}
      />,
    );

    const checkbox = screen.getByLabelText('Mark as template');
    expect(checkbox).toHaveAttribute('data-state', 'checked');
    fireEvent.click(checkbox);
    expect(onIsTemplateChange).toHaveBeenCalledWith(false);
  });
});
