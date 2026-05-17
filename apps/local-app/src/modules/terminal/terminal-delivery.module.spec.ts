import { Module } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test, TestingModule } from '@nestjs/testing';
import { EventsCoreModule } from '../events/events-core.module';
import { SessionsModule } from '../sessions/sessions.module';
import { ProcessExecutorModule } from './services/process-executor/process-executor.module';
import { GuestDeliveryService } from './services/guest-delivery.service';
import { TerminalDeliveryFacade } from './services/terminal-delivery-facade.service';
import { TerminalSessionRegistry } from './services/terminal-session/terminal-session-registry';
import { TerminalGateway } from './gateways/terminal.gateway';
import { PtyService } from './services/pty.service';
import { TerminalIOService } from './services/terminal-io/terminal-io.service';
import { TerminalDeliveryModule } from './terminal-delivery.module';
import { TerminalModule } from './terminal.module';

describe('Terminal delivery wrappers', () => {
  let moduleRef: TestingModule;
  let terminalIO: jest.Mocked<Pick<TerminalIOService, 'deliverImmediate' | 'sessionExists'>>;
  let guestDelivery: GuestDeliveryService;
  let deliveryFacade: TerminalDeliveryFacade;

  beforeEach(async () => {
    terminalIO = {
      deliverImmediate: jest.fn().mockResolvedValue({
        confirmed: true,
        nonce: 'nonce-1',
        retryCount: 0,
      }),
      sessionExists: jest.fn().mockResolvedValue(true),
    };

    moduleRef = await Test.createTestingModule({
      providers: [
        GuestDeliveryService,
        TerminalDeliveryFacade,
        { provide: TerminalIOService, useValue: terminalIO },
      ],
    }).compile();

    guestDelivery = moduleRef.get(GuestDeliveryService);
    deliveryFacade = moduleRef.get(TerminalDeliveryFacade);
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  it('GuestDeliveryService delegates to immediate terminal delivery with guest defaults', async () => {
    await expect(guestDelivery.deliverToGuest({ name: 'guest-tmux' }, 'hello')).resolves.toEqual({
      delivered: true,
    });

    expect(terminalIO.deliverImmediate).toHaveBeenCalledWith({ name: 'guest-tmux' }, 'hello', {
      submitKeys: ['Enter'],
      confirm: false,
    });
  });

  it('GuestDeliveryService maps terminal delivery errors to result objects', async () => {
    terminalIO.deliverImmediate.mockRejectedValue(new Error('tmux failed'));

    await expect(
      guestDelivery.deliverToGuest({ name: 'guest-tmux' }, 'hello', ['Escape']),
    ).resolves.toEqual({ delivered: false, error: 'tmux failed' });
  });

  it('TerminalDeliveryFacade refuses agent delivery without a tmux session', async () => {
    await expect(deliveryFacade.deliverToAgent({ tmuxSessionId: null }, 'hello')).resolves.toEqual({
      delivered: false,
      error: 'NO_TMUX_SESSION',
    });

    expect(terminalIO.deliverImmediate).not.toHaveBeenCalled();
  });

  it('TerminalDeliveryFacade delivers to an agent tmux session', async () => {
    await expect(
      deliveryFacade.deliverToAgent({ tmuxSessionId: 'agent-tmux' }, 'hello', {
        submitKeys: ['Enter'],
      }),
    ).resolves.toEqual({ delivered: true });

    expect(terminalIO.deliverImmediate).toHaveBeenCalledWith({ name: 'agent-tmux' }, 'hello', {
      submitKeys: ['Enter'],
      confirm: false,
    });
  });

  it('TerminalDeliveryFacade exposes terminal liveness checks', async () => {
    await expect(deliveryFacade.sessionExists({ name: 'agent-tmux' })).resolves.toBe(true);

    expect(terminalIO.sessionExists).toHaveBeenCalledWith({ name: 'agent-tmux' });
  });
});

describe('TerminalDeliveryModule shape', () => {
  it('imports only delivery-safe modules', () => {
    const imports =
      (Reflect.getMetadata(MODULE_METADATA.IMPORTS, TerminalDeliveryModule) as unknown[]) ?? [];

    expect(imports).toEqual(expect.arrayContaining([EventsCoreModule, ProcessExecutorModule]));
    expect(imports).not.toEqual(
      expect.arrayContaining([
        TerminalModule,
        SessionsModule,
        PtyService,
        TerminalGateway,
        TerminalSessionRegistry,
      ]),
    );
  });

  it('owns and exports terminal delivery providers', () => {
    const providers =
      (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, TerminalDeliveryModule) as unknown[]) ?? [];
    const exports =
      (Reflect.getMetadata(MODULE_METADATA.EXPORTS, TerminalDeliveryModule) as unknown[]) ?? [];

    expect(providers).toEqual(
      expect.arrayContaining([TerminalIOService, GuestDeliveryService, TerminalDeliveryFacade]),
    );
    expect(exports).toEqual(
      expect.arrayContaining([TerminalIOService, GuestDeliveryService, TerminalDeliveryFacade]),
    );
  });

  it('TerminalModule does not provide TerminalIOService directly', () => {
    const providers =
      (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, TerminalModule) as unknown[]) ?? [];
    const exports =
      (Reflect.getMetadata(MODULE_METADATA.EXPORTS, TerminalModule) as unknown[]) ?? [];

    expect(providers).not.toEqual(expect.arrayContaining([TerminalIOService]));
    expect(exports).toEqual(expect.arrayContaining([TerminalDeliveryModule]));
  });

  it('compiles standalone and resolves delivery providers', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TerminalDeliveryModule],
    }).compile();

    expect(moduleRef.get(TerminalIOService)).toBeInstanceOf(TerminalIOService);
    expect(moduleRef.get(GuestDeliveryService)).toBeInstanceOf(GuestDeliveryService);
    expect(moduleRef.get(TerminalDeliveryFacade)).toBeInstanceOf(TerminalDeliveryFacade);

    await moduleRef.close();
  });

  it('TerminalModule re-exports the same TerminalIOService singleton from TerminalDeliveryModule', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TerminalModule],
    }).compile();

    const fromTerminalModule = moduleRef.get(TerminalIOService);
    const fromDeliveryModule = moduleRef.select(TerminalDeliveryModule).get(TerminalIOService);

    expect(fromTerminalModule).toBe(fromDeliveryModule);

    await moduleRef.close();
  });

  it('downstream importers of TerminalModule can resolve terminal delivery providers', async () => {
    @Module({
      imports: [TerminalModule],
    })
    class DownstreamModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [DownstreamModule],
    }).compile();

    expect(moduleRef.get(TerminalIOService)).toBeInstanceOf(TerminalIOService);
    expect(moduleRef.get(GuestDeliveryService)).toBeInstanceOf(GuestDeliveryService);
    expect(moduleRef.get(TerminalDeliveryFacade)).toBeInstanceOf(TerminalDeliveryFacade);

    await moduleRef.close();
  });
});
