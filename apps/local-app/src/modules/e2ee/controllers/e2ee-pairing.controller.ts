import { Body, Controller, Post } from '@nestjs/common';
import { ValidationError } from '../../../common/errors/error-types';
import {
  E2eePairingService,
  type BeginQrPairingResult,
  type CompleteQrPairingResult,
} from '../services/e2ee-pairing.service';

interface BeginBody {
  channelId?: string;
}

interface CompleteBody {
  channelId?: string;
  deviceEncPubKey?: string;
  deviceEncKid?: string;
  pairingMac?: string;
  label?: string;
  /** Optional stable per-install id relayed through the QR channel (M2 dedup); opaque here. */
  installId?: string;
}

/**
 * Renderer-facing endpoints for the QR auto-verified key exchange (Phase-1 Task:4). The
 * UI calls `begin` after the pairing channel is created to obtain the PC public key +
 * pairing secret to embed in the on-screen QR, then `complete` with the device key + MAC
 * it received (relayed via identity-service) to verify and trust the device. The private
 * key and the verification never leave the main process.
 */
@Controller('api/e2ee/pairing')
export class E2eePairingController {
  constructor(private readonly pairing: E2eePairingService) {}

  @Post('begin')
  async begin(@Body() body: BeginBody): Promise<BeginQrPairingResult> {
    if (!body?.channelId) throw new ValidationError('channelId is required');
    return this.pairing.beginQrPairing(body.channelId);
  }

  @Post('complete')
  async complete(@Body() body: CompleteBody): Promise<CompleteQrPairingResult> {
    if (!body?.channelId) throw new ValidationError('channelId is required');
    if (!body.deviceEncPubKey || !body.deviceEncKid || !body.pairingMac) {
      throw new ValidationError('deviceEncPubKey, deviceEncKid and pairingMac are required');
    }
    return this.pairing.completeQrPairing({
      channelId: body.channelId,
      deviceEncPubKey: body.deviceEncPubKey,
      deviceEncKid: body.deviceEncKid,
      pairingMac: body.pairingMac,
      ...(body.label !== undefined ? { label: body.label } : {}),
      ...(body.installId !== undefined ? { installId: body.installId } : {}),
    });
  }
}
