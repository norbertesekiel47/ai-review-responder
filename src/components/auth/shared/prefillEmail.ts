// sessionStorage key used to hand the email from the signup form
// (when the API returns account_exists) to the login form, without
// putting the email in the URL/history/server logs. Cleared on read.
export const PREFILL_EMAIL_KEY = 'rw-auth-prefill-email';
