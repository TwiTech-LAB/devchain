import { useRef, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { EnvEditor, type EnvEditorHandle } from './EnvEditor';

function EnvEditorHarness({ initialEnv = {} }: { initialEnv?: Record<string, string> }) {
  const [env, setEnv] = useState(initialEnv);
  const ref = useRef<EnvEditorHandle>(null);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const committed = ref.current?.commitPending();
        if (committed) {
          setEnv(committed);
        }
      }}
    >
      <EnvEditor ref={ref} env={env} onChange={setEnv} />
      <button type="submit">Save</button>
      <output aria-label="env-json">{JSON.stringify(env)}</output>
    </form>
  );
}

describe('EnvEditor', () => {
  it('commits the pending row when the parent form is submitted', () => {
    render(<EnvEditorHarness />);

    fireEvent.change(screen.getByPlaceholderText('NEW_KEY'), { target: { value: 'API_KEY' } });
    fireEvent.change(screen.getByPlaceholderText('value'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.getByLabelText('env-json')).toHaveTextContent(
      JSON.stringify({ API_KEY: 'secret' }),
    );
    expect(screen.getByPlaceholderText('NEW_KEY')).toHaveValue('');
    expect(screen.getByPlaceholderText('value')).toHaveValue('');
  });

  it('keeps the plus button behavior for adding another empty row', () => {
    render(<EnvEditorHarness />);

    fireEvent.change(screen.getByPlaceholderText('NEW_KEY'), { target: { value: 'NODE_ENV' } });
    fireEvent.change(screen.getByPlaceholderText('value'), { target: { value: 'test' } });
    fireEvent.click(screen.getByRole('button', { name: /Add environment variable/i }));

    expect(screen.getByLabelText('env-json')).toHaveTextContent(
      JSON.stringify({ NODE_ENV: 'test' }),
    );
    expect(screen.getByPlaceholderText('NEW_KEY')).toHaveValue('');
    expect(screen.getByPlaceholderText('value')).toHaveValue('');
  });

  it('blocks parent submit and shows validation for invalid pending keys', () => {
    render(<EnvEditorHarness initialEnv={{ EXISTING: 'value' }} />);

    fireEvent.change(screen.getByPlaceholderText('NEW_KEY'), { target: { value: 'BAD-KEY' } });
    fireEvent.change(screen.getByPlaceholderText('value'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.getByText(/Key must be alphanumeric/i)).toBeInTheDocument();
    expect(screen.getByLabelText('env-json')).toHaveTextContent(
      JSON.stringify({ EXISTING: 'value' }),
    );
  });
});
