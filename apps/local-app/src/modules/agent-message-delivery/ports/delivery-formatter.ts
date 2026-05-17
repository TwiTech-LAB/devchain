import type { DeliveryMessage } from '../dtos/delivery.types';

export abstract class DeliveryFormatter {
  abstract format(message: DeliveryMessage): string;
}
