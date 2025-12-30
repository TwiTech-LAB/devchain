import { Badge } from '@/ui/components/ui/badge';
import type { ActionMetadata, EventFieldDefinition } from '@/ui/lib/actions';
import type { ActionInput as SubscriberActionInput } from '@/ui/lib/subscribers';
import { InputSourceSelector } from './InputSourceSelector';

interface ActionInputsFormProps {
  action: ActionMetadata | null;
  values: Record<string, SubscriberActionInput>;
  onChange: (values: Record<string, SubscriberActionInput>) => void;
  /** Event-specific fields based on selected event (not hardcoded action fields) */
  availableEventFields?: EventFieldDefinition[];
  errors?: Record<string, string>;
}

export function ActionInputsForm({
  action,
  values,
  onChange,
  availableEventFields = [],
  errors,
}: ActionInputsFormProps) {
  if (!action || action.inputs.length === 0) {
    return (
      <div className="text-sm text-muted-foreground text-center py-4">
        {action
          ? 'This action has no configurable inputs.'
          : 'Select an action to configure inputs.'}
      </div>
    );
  }

  const handleInputChange = (name: string, value: SubscriberActionInput) => {
    onChange({
      ...values,
      [name]: value,
    });
  };

  const getInputValue = (name: string): SubscriberActionInput => {
    return values[name] || { source: 'custom', customValue: '' };
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 mb-2">
        <Badge variant="outline">{action.category}</Badge>
        <span className="text-sm text-muted-foreground">{action.description}</span>
      </div>
      {action.inputs.map((inputDef) => (
        <InputSourceSelector
          key={inputDef.name}
          inputDef={inputDef}
          value={getInputValue(inputDef.name)}
          onChange={(value) => handleInputChange(inputDef.name, value)}
          availableEventFields={availableEventFields}
          error={errors?.[inputDef.name]}
        />
      ))}
    </div>
  );
}
