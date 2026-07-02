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

  it('begin delegates to the service with the channelId', async () => {
    const res = await controller.begin({ channelId: 'chan-1' });
    expect(service.beginQrPairing).toHaveBeenCalledWith('chan-1');
    expect(res.pcEncPubKey).toBe('pub');
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
      label: 'Pixel',
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

  it('complete forwards an optional installId (M2 dedup) when present', async () => {
    await controller.complete({
      channelId: 'chan-1',
      deviceEncPubKey: 'dpub',
      deviceEncKid: 'dkid',
      pairingMac: 'mac',
      installId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    expect(service.completeQrPairing).toHaveBeenCalledWith({
      channelId: 'chan-1',
      deviceEncPubKey: 'dpub',
      deviceEncKid: 'dkid',
      pairingMac: 'mac',
      installId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
  });

  it('complete omits installId from the forwarded input when the body has none (old client)', async () => {
    await controller.complete({
      channelId: 'chan-1',
      deviceEncPubKey: 'dpub',
      deviceEncKid: 'dkid',
      pairingMac: 'mac',
    });
    const forwarded = service.completeQrPairing.mock.calls[0][0];
    expect('installId' in forwarded).toBe(false);
  });

  it('complete rejects when the device key/MAC fields are missing', async () => {
    await expect(controller.complete({ channelId: 'chan-1' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(service.completeQrPairing).not.toHaveBeenCalled();
  });
});
