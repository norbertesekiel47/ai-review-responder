export {
  lockValidLink,
  establishApprovalSession,
  approve,
  edit,
  regenerate,
  approveBySession,
  editBySession,
  regenerateBySession,
} from './service';

export type { ApprovalLink, AuditContext, SessionAuditContext } from './service';

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
