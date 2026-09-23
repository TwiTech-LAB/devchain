import React, { useState } from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MarkdownReferenceInput } from './MarkdownReferenceInput';

function renderWithQuery(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function Harness({ projectId }: { projectId?: string }) {
  const [value, setValue] = useState('');
  return (
    <MarkdownReferenceInput
      value={value}
      onChange={setValue}
      projectId={projectId}
      placeholder="Write instructions..."
    />
  );
}

function requestUrls(call: unknown[]): string {
  const input = call[0] as RequestInfo | URL;
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return (input as Request).url;
}

async function settleDebounce() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
  });
}

describe('MarkdownReferenceInput', () => {
  const originalFetch = globalThis.fetch;
  let fetchSpy: jest.SpyInstance;
  let rafSpy: jest.SpyInstance;

  beforeEach(() => {
    if (!globalThis.fetch) {
      globalThis.fetch = jest.fn();
    }
    fetchSpy = jest.spyOn(globalThis, 'fetch');
    rafSpy = jest
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => {
        cb(performance.now());
        return 1;
      });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (globalThis as unknown as { fetch?: unknown }).fetch;
    }
    rafSpy.mockRestore();
  });

  it('suggests prompts for @ search, requests only /api/prompts, and inserts [[prompt:title]]', async () => {
    fetchSpy.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/prompts') && url.includes('q=init')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            items: [
              {
                id: 'prompt-1',
                title: 'Initialize Agent',
                tags: ['setup'],
                projectId: 'project-1',
              },
            ],
          }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) } as Response);
    });

    const user = userEvent.setup();

    renderWithQuery(<Harness projectId="project-1" />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    await user.type(textarea, '@init');
    await settleDebounce();

    expect(fetchSpy).toHaveBeenCalled();
    for (const call of fetchSpy.mock.calls) {
      expect(requestUrls(call)).not.toContain('/api/documents');
    }

    const promptOption = await screen.findByRole('option', { name: /Initialize Agent/i });
    expect(promptOption).toBeInTheDocument();

    await user.click(promptOption);

    await waitFor(() => expect(textarea).toHaveValue('[[prompt:Initialize Agent]]'));
  });

  it('treats # as ordinary text without triggering suggestion requests', async () => {
    const user = userEvent.setup();

    renderWithQuery(<Harness projectId="project-1" />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    await user.type(textarea, '#role');
    await settleDebounce();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole('option')).toBeNull();
    expect(textarea).toHaveValue('#role');
  });

  it('inserts a prompt reference through complete keyboard selection', async () => {
    fetchSpy.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/prompts') && url.includes('q=depl')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            items: [
              {
                id: 'prompt-1',
                title: 'Deploy Checklist',
                tags: [],
                projectId: 'project-1',
              },
              {
                id: 'prompt-2',
                title: 'Deploy Notes',
                tags: [],
                projectId: 'project-1',
              },
            ],
          }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) } as Response);
    });

    const user = userEvent.setup();

    renderWithQuery(<Harness projectId="project-1" />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    await user.type(textarea, 'Prefix @depl');
    await settleDebounce();

    const firstOption = await screen.findByRole('option', { name: /Deploy Checklist/i });
    expect(firstOption).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Deploy Notes/i })).toBeInTheDocument();
    expect(firstOption).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(textarea).toHaveValue('Prefix [[prompt:Deploy Notes]]'));

    const expectedCaret = 'Prefix '.length + '[[prompt:Deploy Notes]]'.length;
    await waitFor(() => expect(textarea.selectionStart).toBe(expectedCaret));
    expect(textarea.selectionEnd).toBe(expectedCaret);
  });

  it('performs no prompt lookup when projectId is undefined', async () => {
    const user = userEvent.setup();

    renderWithQuery(<Harness />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    await user.type(textarea, '@init');
    await settleDebounce();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole('option')).toBeNull();
  });
});
