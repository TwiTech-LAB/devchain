import { AppError } from '../../../common/errors/error-types';

/** A step's precondition does not hold; `code` names which one. */
export class RemoteOperationStepRefusedError extends AppError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message, code, 409, details);
  }
}
