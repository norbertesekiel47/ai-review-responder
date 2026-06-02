// Dummy env vars for unit tests that transitively import db/server.
// Without these, `createClient(process.env.SUPABASE_URL!, ...)` throws at
// module-load time even when the test doesn't actually hit Supabase.
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY ?? 'dummy-service-key-for-tests';
process.env.DATABASE_POOL_URL =
  process.env.DATABASE_POOL_URL ?? 'postgres://test:test@localhost:5432/test';

// Extend jest-dom matchers (toBeInTheDocument, etc.) for jsdom-environment tests.
// The import is a no-op in node-environment tests because the global `document`
// doesn't exist there — but the module itself is safe to import regardless.
import '@testing-library/jest-dom';

// jsdom does not implement the native <dialog> modal API (showModal/close/show).
// Provide a minimal polyfill so components using <dialog> can be rendered/tested.
// It mirrors the spec's observable surface: `open` reflects state and `close`
// dispatches a 'close' event; ESC handling is exercised via the `cancel` event
// the components wire up themselves.
if (typeof HTMLDialogElement !== 'undefined') {
  const proto = HTMLDialogElement.prototype;
  if (!proto.showModal) {
    proto.showModal = function showModal(this: HTMLDialogElement) {
      this.open = true;
    };
  }
  if (!proto.show) {
    proto.show = function show(this: HTMLDialogElement) {
      this.open = true;
    };
  }
  if (!proto.close) {
    proto.close = function close(this: HTMLDialogElement, returnValue?: string) {
      this.open = false;
      if (returnValue !== undefined) this.returnValue = returnValue;
      this.dispatchEvent(new Event('close'));
    };
  }
}
