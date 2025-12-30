import { useRef, useState } from 'react';
import { Label } from '@/ui/components/ui/label';
import { Input } from '@/ui/components/ui/input';
import { Textarea } from '@/ui/components/ui/textarea';
import { Checkbox } from '@/ui/components/ui/checkbox';
import { Button } from '@/ui/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import type { ActionInput as ActionInputDef, EventFieldDefinition } from '@/ui/lib/actions';
import type { ActionInput as SubscriberActionInput } from '@/ui/lib/subscribers';

export type InputSource = 'custom' | 'event_field';

/**
 * Check if an input type supports template interpolation.
 * String and textarea inputs can use {{field}} template variables.
 */
function isTextInput(type: string): boolean {
  return type === 'string' || type === 'textarea';
}

/**
 * Check if an input only allows custom values (no event_field mapping).
 * If allowedSources is not specified, defaults to allowing both sources.
 */
function isCustomOnly(inputDef: ActionInputDef): boolean {
  const allowedSources = inputDef.allowedSources;
  if (!allowedSources || allowedSources.length === 0) {
    return false; // Default: both sources allowed
  }
  return allowedSources.length === 1 && allowedSources[0] === 'custom';
}

interface InputSourceSelectorProps {
  inputDef: ActionInputDef;
  value: SubscriberActionInput;
  onChange: (value: SubscriberActionInput) => void;
  availableEventFields: EventFieldDefinition[];
  error?: string;
}

export function InputSourceSelector({
  inputDef,
  value,
  onChange,
  availableEventFields,
  error,
}: InputSourceSelectorProps) {
  const source = value.source || 'custom';

  const handleSourceChange = (newSource: InputSource) => {
    onChange({
      source: newSource,
      customValue: newSource === 'custom' ? value.customValue || '' : undefined,
      eventField: newSource === 'event_field' ? value.eventField || '' : undefined,
    });
  };

  const handleCustomValueChange = (customValue: string) => {
    onChange({
      source: 'custom',
      customValue,
      eventField: undefined,
    });
  };

  const handleEventFieldChange = (eventField: string) => {
    onChange({
      source: 'event_field',
      customValue: undefined,
      eventField,
    });
  };

  // For string/textarea inputs, use template editor (no toggle)
  if (isTextInput(inputDef.type)) {
    return (
      <div className="space-y-2 p-3 border rounded-lg">
        <div>
          <Label className="font-medium">
            {inputDef.label}
            {inputDef.required && <span className="text-destructive ml-1">*</span>}
          </Label>
          <p className="text-xs text-muted-foreground">{inputDef.description}</p>
        </div>
        <TemplateEditor
          inputDef={inputDef}
          value={value.customValue || ''}
          onChange={handleCustomValueChange}
          availableEventFields={availableEventFields}
          error={error}
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    );
  }

  // For non-text inputs that are custom-only, render without toggle
  if (isCustomOnly(inputDef)) {
    return (
      <div className="space-y-2 p-3 border rounded-lg">
        <div>
          <Label className="font-medium">
            {inputDef.label}
            {inputDef.required && <span className="text-destructive ml-1">*</span>}
          </Label>
          <p className="text-xs text-muted-foreground">{inputDef.description}</p>
        </div>
        <NonTextValueInput
          inputDef={inputDef}
          value={value.customValue || ''}
          onChange={handleCustomValueChange}
          error={error}
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    );
  }

  // For non-text inputs with both sources allowed, keep toggle behavior
  return (
    <div className="space-y-2 p-3 border rounded-lg">
      <div className="flex items-center justify-between">
        <div>
          <Label className="font-medium">
            {inputDef.label}
            {inputDef.required && <span className="text-destructive ml-1">*</span>}
          </Label>
          <p className="text-xs text-muted-foreground">{inputDef.description}</p>
        </div>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => handleSourceChange('custom')}
            className={`px-2 py-1 text-xs rounded transition-colors ${
              source === 'custom'
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:bg-muted/80'
            }`}
          >
            Custom
          </button>
          <button
            type="button"
            onClick={() => handleSourceChange('event_field')}
            className={`px-2 py-1 text-xs rounded transition-colors ${
              source === 'event_field'
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:bg-muted/80'
            }`}
          >
            Event Field
          </button>
        </div>
      </div>

      {source === 'custom' ? (
        <NonTextValueInput
          inputDef={inputDef}
          value={value.customValue || ''}
          onChange={handleCustomValueChange}
          error={error}
        />
      ) : (
        <EventFieldSelector
          value={value.eventField || ''}
          onChange={handleEventFieldChange}
          availableEventFields={availableEventFields}
          error={error}
        />
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

/**
 * Template editor for string/textarea inputs.
 * Allows users to type free text and insert {{field}} variables from the event payload.
 */
interface TemplateEditorProps {
  inputDef: ActionInputDef;
  value: string;
  onChange: (value: string) => void;
  availableEventFields: EventFieldDefinition[];
  error?: string;
}

function TemplateEditor({
  inputDef,
  value,
  onChange,
  availableEventFields,
  error,
}: TemplateEditorProps) {
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const [selectedField, setSelectedField] = useState<string>('');

  const placeholder =
    inputDef.defaultValue?.toString() || `Enter ${inputDef.label.toLowerCase()}...`;

  // Determine if we should use textarea (for message/text/content fields or textarea type)
  const useTextarea =
    inputDef.type === 'textarea' ||
    inputDef.name.toLowerCase().includes('message') ||
    inputDef.name.toLowerCase().includes('text') ||
    inputDef.name.toLowerCase().includes('content');

  const insertVariable = () => {
    if (!selectedField || !inputRef.current) return;

    const input = inputRef.current;
    const start = input.selectionStart ?? value.length;
    const end = input.selectionEnd ?? value.length;
    const variable = `{{${selectedField}}}`;

    const newValue = value.slice(0, start) + variable + value.slice(end);
    onChange(newValue);

    // Reset selection and refocus
    setTimeout(() => {
      if (inputRef.current) {
        const newPosition = start + variable.length;
        inputRef.current.setSelectionRange(newPosition, newPosition);
        inputRef.current.focus();
      }
    }, 0);
  };

  return (
    <div className="space-y-2">
      {useTextarea ? (
        <Textarea
          ref={inputRef as React.RefObject<HTMLTextAreaElement>}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={3}
          className={error ? 'border-destructive' : ''}
        />
      ) : (
        <Input
          ref={inputRef as React.RefObject<HTMLInputElement>}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={error ? 'border-destructive' : ''}
        />
      )}

      {availableEventFields.length > 0 && (
        <div className="flex items-center gap-2">
          <Select value={selectedField} onValueChange={setSelectedField}>
            <SelectTrigger className="flex-1 h-8 text-xs">
              <SelectValue placeholder="Select variable..." />
            </SelectTrigger>
            <SelectContent>
              {availableEventFields.map((fieldDef) => (
                <SelectItem key={fieldDef.field} value={fieldDef.field}>
                  <span className="font-mono text-xs">{`{{${fieldDef.field}}}`}</span>
                  <span className="ml-2 text-muted-foreground">{fieldDef.label}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={insertVariable}
            disabled={!selectedField}
            className="h-8 text-xs"
          >
            Insert
          </Button>
        </div>
      )}

      {availableEventFields.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Use <code className="bg-muted px-1 rounded">{`{{field}}`}</code> syntax to insert event
          values
        </p>
      )}
    </div>
  );
}

/**
 * Input component for non-text types (number, boolean, select).
 * These types keep the Custom vs Event Field toggle behavior.
 */
interface NonTextValueInputProps {
  inputDef: ActionInputDef;
  value: string;
  onChange: (value: string) => void;
  error?: string;
}

function NonTextValueInput({ inputDef, value, onChange, error }: NonTextValueInputProps) {
  switch (inputDef.type) {
    case 'number':
      return (
        <Input
          type="number"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={inputDef.defaultValue?.toString() || '0'}
          className={error ? 'border-destructive' : ''}
        />
      );

    case 'boolean':
      return (
        <div className="flex items-center space-x-2">
          <Checkbox
            id={`input-${inputDef.name}`}
            checked={value === 'true'}
            onCheckedChange={(checked) => onChange(checked ? 'true' : 'false')}
          />
          <Label htmlFor={`input-${inputDef.name}`} className="cursor-pointer">
            {inputDef.defaultValue === true ? 'Enabled by default' : 'Enable'}
          </Label>
        </div>
      );

    case 'select':
      return (
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger className={error ? 'border-destructive' : ''}>
            <SelectValue placeholder={`Select ${inputDef.label.toLowerCase()}...`} />
          </SelectTrigger>
          <SelectContent>
            {inputDef.options?.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );

    default:
      // Fallback for unknown types - should not happen for non-text inputs
      return (
        <Input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={inputDef.defaultValue?.toString() || ''}
          className={error ? 'border-destructive' : ''}
        />
      );
  }
}

interface EventFieldSelectorProps {
  value: string;
  onChange: (value: string) => void;
  availableEventFields: EventFieldDefinition[];
  error?: string;
}

function EventFieldSelector({
  value,
  onChange,
  availableEventFields,
  error,
}: EventFieldSelectorProps) {
  if (availableEventFields.length === 0) {
    return (
      <div className="space-y-2">
        <Input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Enter event field name..."
          className={error ? 'border-destructive' : ''}
        />
        <p className="text-xs text-muted-foreground">
          No predefined event fields available. Enter a custom field name.
        </p>
      </div>
    );
  }

  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={error ? 'border-destructive' : ''}>
        <SelectValue placeholder="Select event field..." />
      </SelectTrigger>
      <SelectContent>
        {availableEventFields.map((fieldDef) => (
          <SelectItem key={fieldDef.field} value={fieldDef.field}>
            {fieldDef.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
