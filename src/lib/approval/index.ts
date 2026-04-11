export {
  lockValidLink,
  establishApprovalSession,
  approve,
  edit,
  regenerate,
} from './service';

export type { ApprovalLink, AuditContext } from './service';

export {
  setDeviceCookie,
  getDeviceCookieHash,
  verifyDeviceCookie,
  setCsrfCookie,
  validateCsrf,
} from './cookies';

export {
  InvalidTokenError,
  ExpiredTokenError,
  RevokedTokenError,
  ConsumedTokenError,
  DeviceConflictError,
  ResponseNotPendingError,
} from './errors';

export { handleApprovalError } from './http-errors';
