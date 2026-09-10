/**
 * Error vocabulary (002 §4.3).
 *
 * The vendored spec types `ErrorCode` as a plain string with no enum (verified 2026-09-07), so the
 * codes below are ours. Where the Neon proxy classifies a control-plane failure as retryable it
 * matches on its own `Reason` enum, so the two codes it cares about keep those names:
 * `RunningOperations` (retryable) and `EndpointNotFound` / `ProjectNotFound` (not retryable).
 */

export const ERROR_CODES = {
  authFailed: 'AUTH_FAILED',
  badRequest: 'BAD_REQUEST',
  notFound: 'RESOURCE_NOT_FOUND',
  projectNotFound: 'PROJECT_NOT_FOUND',
  branchNotFound: 'BRANCH_NOT_FOUND',
  endpointNotFound: 'ENDPOINT_NOT_FOUND',
  roleNotFound: 'ROLE_NOT_FOUND',
  databaseNotFound: 'DATABASE_NOT_FOUND',
  alreadyExists: 'ALREADY_EXISTS',
  wrongLsnOrTimestamp: 'WRONG_LSN_OR_TIMESTAMP',
  preconditionFailed: 'PRECONDITION_FAILED',
  runningOperations: 'RUNNING_OPERATIONS',
  notImplemented: 'NOT_IMPLEMENTED',
  forbidden: 'FORBIDDEN',
  orgNotFound: 'ORG_NOT_FOUND',
  memberNotFound: 'MEMBER_NOT_FOUND',
  internal: 'INTERNAL_SERVER_ERROR',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface GeneralErrorBody {
  readonly code: string;
  readonly message: string;
  readonly request_id?: string;
}

export class ApiError extends Error {
  public readonly httpStatus: number;
  public readonly code: ErrorCode;
  public readonly requestId: string | undefined;

  public constructor(httpStatus: number, code: ErrorCode, message: string, requestId?: string) {
    super(message);
    this.name = 'ApiError';
    this.httpStatus = httpStatus;
    this.code = code;
    this.requestId = requestId;
  }

  public toBody(): GeneralErrorBody {
    return this.requestId === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, request_id: this.requestId };
  }
}

export const errors = {
  unauthorized: (message = 'API key is missing or invalid') => new ApiError(401, ERROR_CODES.authFailed, message),
  badRequest: (message: string) => new ApiError(400, ERROR_CODES.badRequest, message),
  notFound: (what: string) => new ApiError(404, ERROR_CODES.notFound, `${what} was not found`),
  projectNotFound: (id: string) => new ApiError(404, ERROR_CODES.projectNotFound, `project ${id} was not found`),
  branchNotFound: (id: string) => new ApiError(404, ERROR_CODES.branchNotFound, `branch ${id} was not found`),
  endpointNotFound: (id: string) => new ApiError(404, ERROR_CODES.endpointNotFound, `endpoint ${id} was not found`),
  roleNotFound: (name: string) => new ApiError(404, ERROR_CODES.roleNotFound, `role ${name} was not found`),
  databaseNotFound: (name: string) => new ApiError(404, ERROR_CODES.databaseNotFound, `database ${name} was not found`),
  alreadyExists: (what: string) => new ApiError(409, ERROR_CODES.alreadyExists, `${what} already exists`),
  wrongLsnOrTimestamp: (message: string) => new ApiError(400, ERROR_CODES.wrongLsnOrTimestamp, message),
  /** `reveal_password` on a project created with store_passwords=false. */
  preconditionFailed: (message: string) => new ApiError(412, ERROR_CODES.preconditionFailed, message),
  /** Another operation holds this resource; the proxy treats this class as retryable. */
  runningOperations: (message = 'another operation is running on this resource') =>
    new ApiError(423, ERROR_CODES.runningOperations, message),
  notImplemented: (what: string) => new ApiError(501, ERROR_CODES.notImplemented, `${what} is not implemented`),
  forbidden: (message = 'the credential is not allowed to perform this action') => new ApiError(403, ERROR_CODES.forbidden, message),
  orgNotFound: (id: string) => new ApiError(404, ERROR_CODES.orgNotFound, `organization ${id} was not found`),
  memberNotFound: (id: string) => new ApiError(404, ERROR_CODES.memberNotFound, `member ${id} was not found`),
  internal: (message = 'internal error') => new ApiError(500, ERROR_CODES.internal, message),
} as const;
