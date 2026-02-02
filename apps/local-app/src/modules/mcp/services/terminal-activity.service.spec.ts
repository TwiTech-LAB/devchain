import { Test, TestingModule } from '@nestjs/testing';
import { TerminalActivityService } from './terminal-activity.service';
import { ActivityTrackerService } from '../../sessions/services/activity-tracker.service';

describe('TerminalActivityService', () => {
  let service: TerminalActivityService;
  let activityTrackerMock: jest.Mocked<ActivityTrackerService>;

  beforeEach(async () => {
    activityTrackerMock = {
      signal: jest.fn(),
      clearSession: jest.fn(),
    } as unknown as jest.Mocked<ActivityTrackerService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TerminalActivityService,
        {
          provide: ActivityTrackerService,
          useValue: activityTrackerMock,
        },
      ],
    }).compile();

    service = module.get<TerminalActivityService>(TerminalActivityService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('observeChunk', () => {
    it('should signal activity for real text content', () => {
      service.observeChunk('session-1', 'hello world');
      expect(activityTrackerMock.signal).toHaveBeenCalledWith('session-1');
    });

    it('should NOT signal activity for ANSI-only output (CSI sequences)', () => {
      service.observeChunk('session-1', '\x1B[31m\x1B[0m');
      expect(activityTrackerMock.signal).not.toHaveBeenCalled();
    });

    it('should NOT signal activity for OSC sequences terminated by BEL', () => {
      service.observeChunk('session-1', '\x1B]0;title\x07');
      expect(activityTrackerMock.signal).not.toHaveBeenCalled();
    });

    it('should NOT signal activity for OSC sequences terminated by ST (ESC \\)', () => {
      // This is the bug fix: ST terminator is 2-byte (ESC + \)
      // Previously, only ESC was consumed, leaving \ as spurious non-whitespace
      service.observeChunk('session-1', '\x1B]0;title\x1B\\');
      expect(activityTrackerMock.signal).not.toHaveBeenCalled();
    });

    it('should signal activity for text with ANSI stripped', () => {
      service.observeChunk('session-1', '\x1B[31mhello\x1B[0m');
      expect(activityTrackerMock.signal).toHaveBeenCalledWith('session-1');
    });

    it('should NOT signal activity for control characters only', () => {
      service.observeChunk('session-1', '\x00\x01\x02\x03');
      expect(activityTrackerMock.signal).not.toHaveBeenCalled();
    });

    it('should NOT signal activity for whitespace only', () => {
      service.observeChunk('session-1', '   \t\n  ');
      expect(activityTrackerMock.signal).not.toHaveBeenCalled();
    });

    it('should handle non-string data gracefully', () => {
      service.observeChunk('session-1', null as unknown as string);
      expect(activityTrackerMock.signal).not.toHaveBeenCalled();
    });

    it('should signal activity for Unicode text', () => {
      service.observeChunk('session-1', 'hello 世界');
      expect(activityTrackerMock.signal).toHaveBeenCalledWith('session-1');
    });

    it('should signal activity for emoji', () => {
      service.observeChunk('session-1', 'test 😊');
      expect(activityTrackerMock.signal).toHaveBeenCalledWith('session-1');
    });
  });

  describe('clearSession', () => {
    it('should delegate to ActivityTrackerService', () => {
      service.clearSession('session-1');
      expect(activityTrackerMock.clearSession).toHaveBeenCalledWith('session-1');
    });
  });

  describe('getBufferSize', () => {
    it('should return 0 (legacy no-op)', () => {
      expect(service.getBufferSize('session-1')).toBe(0);
    });
  });

  describe('processChunk', () => {
    it('should return data unchanged and signal activity for non-empty content', async () => {
      const data = 'hello world';
      const result = await service.processChunk('session-1', data);
      expect(result).toBe(data);
      expect(activityTrackerMock.signal).toHaveBeenCalledWith('session-1');
    });
  });
});
