import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CustomPromptPicker, type CustomPromptPickerTarget } from './CustomPromptPicker';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    json: async () => body,
  } as Response;
}

function createTarget(
  fetchFn: jest.Mock,
  insertPromptText = jest.fn().mockResolvedValue(undefined),
): CustomPromptPickerTarget {
  return {
    sessionId: 'session-1',
    projectId: 'project-1',
    apiBase: '',
    fetchFn,
    terminalHandle: {
      clear: jest.fn(),
      fit: jest.fn(),
      focus: jest.fn(),
      insertPromptText,
    },
  };
}

function PickerHarness({ target }: { target: CustomPromptPickerTarget }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open picker
      </button>
      <CustomPromptPicker open={open} target={target} onOpenChange={setOpen} />
    </>
  );
}

describe('CustomPromptPicker', () => {
  it('keeps duplicate titles distinct and closes only after confirmed insertion', async () => {
    const insertPromptText = jest.fn().mockResolvedValue(undefined);
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            {
              id: 'prompt-1',
              projectId: 'project-1',
              title: 'Deploy',
              tags: ['type:custom'],
            },
            {
              id: 'prompt-2',
              projectId: 'project-1',
              title: 'Deploy',
              tags: ['type:custom'],
            },
          ],
          total: 2,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'prompt-2',
          projectId: 'project-1',
          title: 'Deploy',
          content: 'review deployment',
          tags: ['type:custom'],
        }),
      );
    const target = createTarget(fetchFn, insertPromptText);

    render(<PickerHarness target={target} />);

    const duplicateButtons = await screen.findAllByRole('button', { name: /Deploy Prompt ID/ });
    expect(duplicateButtons).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: /Deploy Prompt ID prompt-2/ }));

    await waitFor(() => {
      expect(insertPromptText).toHaveBeenCalledWith('review deployment');
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(target.terminalHandle.focus).toHaveBeenCalled();
    });
    expect(fetchFn).toHaveBeenNthCalledWith(
      2,
      '/api/prompts/prompt-2',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('disables duplicate selection while detail and insertion are pending', async () => {
    let resolveDetail: ((response: Response) => void) | undefined;
    const detailPromise = new Promise<Response>((resolve) => {
      resolveDetail = resolve;
    });
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            {
              id: 'prompt-1',
              projectId: 'project-1',
              title: 'Draft',
              tags: ['type:custom'],
            },
          ],
          total: 1,
        }),
      )
      .mockReturnValueOnce(detailPromise);
    const insertPromptText = jest.fn().mockResolvedValue(undefined);

    render(<PickerHarness target={createTarget(fetchFn, insertPromptText)} />);
    const button = await screen.findByRole('button', { name: /Draft Prompt ID prompt-1/ });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(button).toBeDisabled();

    resolveDetail?.(
      jsonResponse({
        id: 'prompt-1',
        projectId: 'project-1',
        title: 'Draft',
        content: 'draft text',
        tags: ['type:custom'],
      }),
    );
    await waitFor(() => expect(insertPromptText).toHaveBeenCalledTimes(1));
  });

  it('keeps the dialog open and announces detail validation or insertion failures', async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            {
              id: 'prompt-1',
              projectId: 'project-1',
              title: 'Changed',
              tags: ['type:custom'],
            },
          ],
          total: 1,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'prompt-1',
          projectId: 'project-1',
          title: 'Changed',
          content: 'changed text',
          tags: ['type:system'],
        }),
      );

    render(<PickerHarness target={createTarget(fetchFn)} />);
    fireEvent.click(await screen.findByRole('button', { name: /Changed Prompt ID prompt-1/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The selected prompt is no longer a custom prompt.',
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('invalidates a deferred selection when closed so it cannot affect a reopened picker', async () => {
    let resolveOldDetail: ((response: Response) => void) | undefined;
    const oldDetail = new Promise<Response>((resolve) => {
      resolveOldDetail = resolve;
    });
    const listResponse = {
      items: [
        {
          id: 'prompt-1',
          projectId: 'project-1',
          title: 'Deferred',
          tags: ['type:custom'],
        },
      ],
      total: 1,
    };
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(listResponse))
      .mockReturnValueOnce(oldDetail)
      .mockResolvedValueOnce(jsonResponse(listResponse));
    const insertPromptText = jest.fn().mockResolvedValue(undefined);
    const target = createTarget(fetchFn, insertPromptText);

    render(<PickerHarness target={target} />);
    fireEvent.click(await screen.findByRole('button', { name: /Deferred Prompt ID prompt-1/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect((fetchFn.mock.calls[1][1] as RequestInit).signal).toHaveProperty('aborted', true);

    fireEvent.click(screen.getByRole('button', { name: 'Open picker' }));
    const reopenedPrompt = await screen.findByRole('button', {
      name: /Deferred Prompt ID prompt-1/,
    });
    expect(reopenedPrompt).toBeEnabled();

    await act(async () => {
      resolveOldDetail?.(
        jsonResponse({
          id: 'prompt-1',
          projectId: 'project-1',
          title: 'Deferred',
          content: 'stale text',
          tags: ['type:custom'],
        }),
      );
      await oldDetail;
      await Promise.resolve();
    });

    expect(insertPromptText).not.toHaveBeenCalled();
    expect(target.terminalHandle.focus).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: /Insert custom prompt/i })).toBeInTheDocument();
    expect(reopenedPrompt).toBeEnabled();
  });

  it('invalidates a deferred selection when the terminal target changes', async () => {
    let resolveOldDetail: ((response: Response) => void) | undefined;
    const oldDetail = new Promise<Response>((resolve) => {
      resolveOldDetail = resolve;
    });
    const oldFetch = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            {
              id: 'old-prompt',
              projectId: 'project-1',
              title: 'Old target',
              tags: ['type:custom'],
            },
          ],
          total: 1,
        }),
      )
      .mockReturnValueOnce(oldDetail);
    const oldTarget = createTarget(oldFetch);
    const newFetch = jest.fn().mockResolvedValue(
      jsonResponse({
        items: [
          {
            id: 'new-prompt',
            projectId: 'project-2',
            title: 'New target',
            tags: ['type:custom'],
          },
        ],
        total: 1,
      }),
    );
    const newTarget = {
      ...createTarget(newFetch),
      sessionId: 'session-2',
      projectId: 'project-2',
      apiBase: '/wt/new-target',
    };
    const onOpenChange = jest.fn();

    const { rerender } = render(
      <CustomPromptPicker open={true} target={oldTarget} onOpenChange={onOpenChange} />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Old target Prompt ID old-prompt/ }));

    rerender(<CustomPromptPicker open={true} target={newTarget} onOpenChange={onOpenChange} />);
    const newPrompt = await screen.findByRole('button', {
      name: /New target Prompt ID new-prompt/,
    });
    expect((oldFetch.mock.calls[1][1] as RequestInit).signal).toHaveProperty('aborted', true);

    await act(async () => {
      resolveOldDetail?.(
        jsonResponse({
          id: 'old-prompt',
          projectId: 'project-1',
          title: 'Old target',
          content: 'stale target text',
          tags: ['type:custom'],
        }),
      );
      await oldDetail;
      await Promise.resolve();
    });

    expect(oldTarget.terminalHandle.insertPromptText).not.toHaveBeenCalled();
    expect(newTarget.terminalHandle.insertPromptText).not.toHaveBeenCalled();
    expect(oldTarget.terminalHandle.focus).not.toHaveBeenCalled();
    expect(newTarget.terminalHandle.focus).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(newPrompt).toBeEnabled();
    expect(screen.getByRole('dialog', { name: /Insert custom prompt/i })).toBeInTheDocument();
  });
});
