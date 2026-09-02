import Link from 'next/link';
import './requests.css';

interface Props {
  /** Which routed sibling is the current page. */
  active: 'requests' | 'contacts';
}

/**
 * Routed tab bar for the two Requests surfaces — the batch screen and the
 * contacts list it is built from (UX audit D28). The `ReviewsTabs` pattern,
 * verbatim: plain navigation links, not state, so each route keeps its own
 * server-rendered data model; the shell's `.tabs`/`.tab` pill styling; and
 * `aria-current` on the page the owner is on. Rendered by BOTH clients, so
 * Contacts finally has a way back that is not the browser's Back button.
 */
export function RequestsTabs({ active }: Props) {
  return (
    <div className="rq-subnav">
      <nav className="tabs" aria-label="Requests views">
        <Link
          href="/dashboard/requests"
          className={`tab ${active === 'requests' ? 'active' : ''}`}
          aria-current={active === 'requests' ? 'page' : undefined}
        >
          Requests
        </Link>
        <Link
          href="/dashboard/requests/contacts"
          className={`tab ${active === 'contacts' ? 'active' : ''}`}
          aria-current={active === 'contacts' ? 'page' : undefined}
        >
          Contacts
        </Link>
      </nav>
    </div>
  );
}
