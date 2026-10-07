import { Test, TestingModule } from '@nestjs/testing';
import { ValidationError } from '../../../common/errors/error-types';
import { E2eePairingService } from '../services/e2ee-pairing.service';
import { E2eePairingController } from './e2ee-pairing.controller';

describe('E2eePairingController', () => {
  let controller: E2eePairingController;
  let service: { beginQrPairing: jest.Mock; completeQrPairing: jest.Mock };

  beforeEach(async () => {
    service = {
      beginQrPairing: jest
        .fn()
        .mockResolvedValue({ pcEncPubKey: 'pub', pcEncKid: 'kid', pairingSecret: 'sec' }),
      completeQrPairing: jest.fn().mockResolvedValue({ kid: 'mob-kid', trust: 'verified' }),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [E2eePairingController],
      providers: [{ provide: E2eePairingService, useValue: service }],
    }).compile();
    controller = module.get(E2eePairingController);
  });

  it('begin rejects a missing channelId', async () => {
    await expect(controller.begin({})).rejects.toBeInstanceOf(ValidationError);
    expect(service.beginQrPairing).not.toHaveBeenCalled();
  });

  it('complete forwards the device key + MAC to the service', async () => {
    const res = await controller.complete({
      channelId: 'chan-1',
      deviceEncPubKey: 'dpub',
      deviceEncKid: 'dkid',
      pairingMac: 'mac',
      label: '  Pixel  ',
    });
    expect(service.completeQrPairing).toHaveBeenCalledWith({
      channelId: 'chan-1',
      deviceEncPubKey: 'dpub',
      deviceEncKid: 'dkid',
      pairingMac: 'mac',
      label: 'Pixel',
    });
    expect(res.trust).toBe('verified');
  });

  it('complete omits a blank label and rejects labels over 120 characters', async () => {
    const input = {
      channelId: 'chan-1',
      deviceEncPubKey: 'dpub',
      deviceEncKid: 'dkid',
      pairingMac: 'mac',
    };
    await controller.complete({ ...input, label: '   ' });
    expect(service.completeQrPairing).toHaveBeenLastCalledWith(input);

    await expect(controller.complete({ ...input, label: 'x'.repeat(121) })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it.each([
    { name: 'with installId', extra: { installId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } },
    { name: 'without installId', extra: {} },
  ])('completes pairing $name', async ({ extra }) => {
    const input = {
      channelId: 'chan-1',
      deviceEncPubKey: 'dpub',
      deviceEncKid: 'dkid',
      pairingMac: 'mac',
      ...extra,
    };
    await controller.complete(input);
    expect(service.completeQrPairing).toHaveBeenCalledWith(input);
    expect('installId' in service.completeQrPairing.mock.calls[0][0]).toBe('installId' in extra);
  });

  it('complete rejects when the device key/MAC fields are missing', async () => {
    await expect(controller.complete({ channelId: 'chan-1' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(service.completeQrPairing).not.toHaveBeenCalled();
  });
});
