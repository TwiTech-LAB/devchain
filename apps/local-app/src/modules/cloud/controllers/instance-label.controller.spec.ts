import { ZodError } from 'zod';
import { InstanceLabelController } from './instance-label.controller';
import type { InstanceLabelService } from '../services/instance-label.service';

describe('InstanceLabelController', () => {
  let controller: InstanceLabelController;
  let setLabel: jest.Mock;

  beforeEach(() => {
    setLabel = jest.fn();
    const service = { setLabel } as unknown as InstanceLabelService;
    controller = new InstanceLabelController(service);
  });

  it('stores a label and echoes it back', async () => {
    setLabel.mockResolvedValue('lab-vm');

    await expect(controller.setLabel({ label: ' lab-vm ' })).resolves.toEqual({
      label: 'lab-vm',
    });
    expect(setLabel).toHaveBeenCalledWith(' lab-vm ');
  });

  it('clears the label on an empty string so attestation falls back to hostname', async () => {
    setLabel.mockResolvedValue(null);

    await expect(controller.setLabel({ label: '' })).resolves.toEqual({ label: null });
    expect(setLabel).toHaveBeenCalledWith('');
  });

  it.each([
    ['a missing label', {}],
    ['a non-string label', { label: 42 }],
    ['an over-long label', { label: 'x'.repeat(129) }],
    ['extra fields', { label: 'ok', extra: true }],
  ])('rejects %s', async (_label, body) => {
    await expect(controller.setLabel(body)).rejects.toBeInstanceOf(ZodError);
    expect(setLabel).not.toHaveBeenCalled();
  });
});
