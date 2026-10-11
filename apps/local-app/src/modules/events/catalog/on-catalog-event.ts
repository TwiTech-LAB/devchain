import { OnEvent } from '@nestjs/event-emitter';
import type { EventName, EventPayload } from './index';

export type CatalogEventOptions = NonNullable<Parameters<typeof OnEvent>[1]>;

export type CatalogEventMethodDecorator<N extends EventName> = <
  F extends (payload: EventPayload<N>) => unknown,
>(
  target: object,
  propertyKey: string | symbol,
  descriptor: TypedPropertyDescriptor<F>,
) => TypedPropertyDescriptor<F> | void;

export function OnCatalogEvent<N extends EventName>(
  name: N,
  options?: CatalogEventOptions,
): CatalogEventMethodDecorator<N> {
  return OnEvent(name, options);
}
