import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  AppBootstrapFixture,
  compileAppBootstrapFixture,
} from '../../common/test/app-bootstrap.helper';
import { EpicAssignmentNotifierSubscriber } from '../epics/subscribers/epic-assignment-notifier.subscriber';
import { SubEpicCreatedNotifierSubscriber } from '../epics/subscribers/sub-epic-created-notifier.subscriber';
import { ReviewCommentNotifierSubscriber } from '../reviews/subscribers/review-comment-notifier.subscriber';
import { TeamConfigUpdatedNotifierSubscriber } from '../teams/subscribers/team-config-updated-notifier.subscriber';
import { TeamMembershipChangedNotifierSubscriber } from '../teams/subscribers/team-membership-changed-notifier.subscriber';

jest.setTimeout(60_000);

describe('domain subscriber registration in app root', () => {
  let fixture: AppBootstrapFixture | undefined;

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
    jest.restoreAllMocks();
  });

  it('invokes each transitional subscriber from app-root registration', async () => {
    const epicCreatedAssignmentSpy = spyOnSubscriberMethod(
      EpicAssignmentNotifierSubscriber.prototype,
      'handleEpicCreated',
    );
    const epicUpdatedSpy = spyOnSubscriberMethod(
      EpicAssignmentNotifierSubscriber.prototype,
      'handleEpicUpdated',
    );
    const subEpicCreatedSpy = spyOnSubscriberMethod(
      SubEpicCreatedNotifierSubscriber.prototype,
      'handleEpicCreated',
    );
    const reviewCommentSpy = spyOnSubscriberMethod(
      ReviewCommentNotifierSubscriber.prototype,
      'handleReviewCommentCreated',
    );
    const teamConfigSpy = spyOnSubscriberMethod(
      TeamConfigUpdatedNotifierSubscriber.prototype,
      'handleTeamConfigUpdated',
    );
    const teamMemberAddedSpy = spyOnSubscriberMethod(
      TeamMembershipChangedNotifierSubscriber.prototype,
      'handleMemberAdded',
    );
    const teamMemberRemovedSpy = spyOnSubscriberMethod(
      TeamMembershipChangedNotifierSubscriber.prototype,
      'handleMemberRemoved',
    );

    fixture = await compileAppBootstrapFixture();
    await fixture.moduleRef.init();
    const eventEmitter = fixture.moduleRef.get(EventEmitter2);

    eventEmitter.emit('epic.created', {});
    await flushAsyncEventListeners();
    expect(epicCreatedAssignmentSpy).toHaveBeenCalledWith({});
    expect(subEpicCreatedSpy).toHaveBeenCalledWith({});

    eventEmitter.emit('epic.updated', { changes: {} });
    await flushAsyncEventListeners();
    expect(epicUpdatedSpy).toHaveBeenCalledWith({ changes: {} });

    eventEmitter.emit('review.comment.created', {});
    await flushAsyncEventListeners();
    expect(reviewCommentSpy).toHaveBeenCalledWith({});

    eventEmitter.emit('team.config.updated', {});
    await flushAsyncEventListeners();
    expect(teamConfigSpy).toHaveBeenCalledWith({});

    eventEmitter.emit('team.member.added', {});
    await flushAsyncEventListeners();
    expect(teamMemberAddedSpy).toHaveBeenCalledWith({});

    eventEmitter.emit('team.member.removed', {});
    await flushAsyncEventListeners();
    expect(teamMemberRemovedSpy).toHaveBeenCalledWith({});
  });
});

function spyOnSubscriberMethod<
  T extends object,
  M extends jest.FunctionPropertyNames<Required<T>> & string,
>(prototype: T, methodName: M): jest.SpyInstance {
  const methodOf = (target: T): object => {
    const method: unknown = target[methodName];
    if (typeof method !== 'function') {
      throw new Error(`${methodName} is not a function`);
    }
    return method;
  };
  const original = methodOf(prototype);
  const spy = jest.spyOn(prototype, methodName);
  const wrapped = methodOf(prototype);

  for (const metadataKey of Reflect.getMetadataKeys(original)) {
    Reflect.defineMetadata(metadataKey, Reflect.getMetadata(metadataKey, original), wrapped);
  }

  return spy;
}

async function flushAsyncEventListeners(): Promise<void> {
  await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
  await Promise.resolve();
}
