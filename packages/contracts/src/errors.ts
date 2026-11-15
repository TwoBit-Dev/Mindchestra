import { z } from 'zod';

export const ErrorCodeSchema = z.enum([
  'INVALID_INPUT',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'NOT_READY',
  'CURSOR_EXPIRED',
  'RATE_LIMITED',
  'UNAVAILABLE',
  'AUTH_REQUIRED',
  'UNSUPPORTED',
  'TIMEOUT',
  'CANCELLED',
  'UNKNOWN_OUTCOME',
  'INTERNAL'
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ErrorResponseSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string().min(1).max(2000),
  retryable: z.boolean(),
  requestId: z.string().min(1).optional(),
  details: z.record(z.string(), z.unknown()).optional()
}).strict();
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export const ErrorEnvelopeSchema = z.object({
  error: ErrorResponseSchema
}).strict();
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  INVALID_INPUT: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  NOT_READY: 409,
  CURSOR_EXPIRED: 410,
  RATE_LIMITED: 429,
  UNAVAILABLE: 503,
  AUTH_REQUIRED: 403,
  UNSUPPORTED: 400,
  TIMEOUT: 504,
  CANCELLED: 409,
  UNKNOWN_OUTCOME: 500,
  INTERNAL: 500
};

export class MindchestraError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options?: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown }
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'MindchestraError';
    this.code = code;
    this.retryable = options?.retryable ?? (code === 'RATE_LIMITED' || code === 'UNAVAILABLE' || code === 'TIMEOUT' || code === 'NOT_READY');
    this.details = options?.details;
  }

  get httpStatus(): number {
    return ERROR_HTTP_STATUS[this.code];
  }

  toResponse(requestId?: string): ErrorResponse {
    const response: ErrorResponse = {
      code: this.code,
      message: this.message,
      retryable: this.retryable
    };
    if (requestId !== undefined) {
      response.requestId = requestId;
    }
    if (this.details !== undefined) {
      response.details = this.details;
    }
    return response;
  }

  toEnvelope(requestId?: string): ErrorEnvelope {
    return {
      error: this.toResponse(requestId)
    };
  }
}
