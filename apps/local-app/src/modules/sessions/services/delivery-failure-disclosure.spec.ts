import {
  classifyDeliveryFailure,
  getStrictestFailureDisclosure,
  PROJECT_SAFE_DELIVERY_ERROR,
} from './delivery-failure-disclosure';

describe('delivery failure disclosure', () => {
  it('preserves the legacy error and classification when no policy is supplied', () => {
    expect(
      classifyDeliveryFailure(undefined, 'tmux failed at /private/project', 'tmux_error'),
    ).toEqual({
      error: 'tmux failed at /private/project',
      failureCode: 'tmux_error',
    });
  });

  it('maps protected failures to the stable public error and internal classification', () => {
    expect(
      classifyDeliveryFailure('project-safe', 'tmux failed at /private/project', 'tmux_error'),
    ).toEqual({
      error: PROJECT_SAFE_DELIVERY_ERROR,
      failureCode: 'project_delivery_failed',
    });
  });

  it('selects project-safe disclosure for a mixed batch', () => {
    expect(
      getStrictestFailureDisclosure([
        { failureDisclosure: undefined },
        { failureDisclosure: 'project-safe' },
      ]),
    ).toBe('project-safe');
    expect(getStrictestFailureDisclosure([{ failureDisclosure: undefined }])).toBe('legacy');
  });
});
