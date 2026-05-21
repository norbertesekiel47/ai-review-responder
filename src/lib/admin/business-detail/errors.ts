// src/lib/admin/business-detail/errors.ts
//
// Typed errors for the admin business-detail service.
// Kept separate to avoid circular imports between update.ts and business-detail-service.ts.

/**
 * Thrown when the UPDATE businesses statement matches zero rows (the
 * business id does not exist). Route maps to 404.
 */
export class AdminBusinessNotFoundError extends Error {
  constructor() {
    super('Admin business not found');
    this.name = 'AdminBusinessNotFoundError';
  }
}
