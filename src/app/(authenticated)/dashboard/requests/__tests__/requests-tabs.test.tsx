// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RequestsTabs } from '../RequestsTabs';

// #1092. The routed bar survives — scoped to mobile by CSS (#1089) — and gains
// a third destination, because the Review QR surface moves under Requests. A
// sidebar-only QR entry would be unreachable on a phone, which is the exact
// defect #1089 exists to prevent, reintroduced for the one route being moved.
describe('RequestsTabs', () => {
  it('RequestsTabs offers Review QR alongside Requests and Contacts', () => {
    render(<RequestsTabs active="qr" />);
    expect(screen.getByRole('link', { name: 'Requests' })).toHaveAttribute(
      'href',
      '/dashboard/requests',
    );
    expect(screen.getByRole('link', { name: 'Contacts' })).toHaveAttribute(
      'href',
      '/dashboard/requests/contacts',
    );
    expect(screen.getByRole('link', { name: 'Review QR' })).toHaveAttribute(
      'href',
      '/dashboard/requests/qr',
    );
  });

  it('marks only the active route with aria-current, and uses no tab role', () => {
    render(<RequestsTabs active="contacts" />);
    expect(screen.getByRole('link', { name: 'Contacts' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: 'Review QR' })).not.toHaveAttribute('aria-current');
    // A routed bar is navigation, never a tablist (docs/design/console/DESIGN.md).
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
  });

  it('carries the routed marker class the breakpoint rule keys off', () => {
    const { container } = render(<RequestsTabs active="requests" />);
    expect(container.querySelector('.tabs--routed')).not.toBeNull();
  });
});
