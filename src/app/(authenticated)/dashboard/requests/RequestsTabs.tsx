import Link from 'next/link';
import './requests.css';

interface Props {
  /** Which routed sibling is the current page. */
  active: 'requests' | 'contacts' | 'qr';
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
      <nav className="tabs tabs--routed" aria-label="Requests views">
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
        {/* The **Review QR** surface, moved out of Settings by #1092. It needs a
            pill as well as a sidebar child: below the breakpoint the sidebar is
            hidden, and a sidebar-only entry would be unreachable on a phone —
            the exact defect #1089 exists to prevent. */}
        <Link
          href="/dashboard/requests/qr"
          className={`tab ${active === 'qr' ? 'active' : ''}`}
          aria-current={active === 'qr' ? 'page' : undefined}
        >
          Review QR
        </Link>
      </nav>
    </div>
  );
}
