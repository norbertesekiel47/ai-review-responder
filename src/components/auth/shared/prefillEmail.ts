// sessionStorage key used to hand the email from the signup form
// (when the API returns account_exists) to the login form, without
// putting the email in the URL/history/server logs. Cleared on read.
export const PREFILL_EMAIL_KEY = 'rw-auth-prefill-email';

// sessionStorage key used to hand the email to /signup/check-email from the
// client login path (email-not-confirmed) WITHOUT putting it in the URL/history/
// referrer/logs. CheckEmailClient reads this only when no ?email= param is
// present (server signup/pay redirects still pass ?email= and take precedence).
// Cleared on read.
export const CHECK_EMAIL_EMAIL_KEY = 'rw-auth-check-email';
