// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AdminPage } from '../AdminPage';

describe('AdminPage', () => {
  it('renders group, title, description, actions, and children', () => {
    render(
      <AdminPage group="Growth" title="Report" description="Report details" actions={<button>Export</button>}>
        <div>page body</div>
      </AdminPage>,
    );
    expect(screen.getByText('Growth')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Report' })).toBeInTheDocument();
    expect(screen.getByText('Report details')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument();
    expect(screen.getByText('page body')).toBeInTheDocument();
  });

  // X28: the eyebrow is a breadcrumb, not a caption. The group links to its
  // sidebar landing page (derived from ADMIN_NAV_GROUPS, the IA's single owner).
  it('renders the group eyebrow as a breadcrumb link to the group landing page', () => {
    render(
      <AdminPage group="Growth" title="Main Street Cafe">
        <div />
      </AdminPage>,
    );
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(nav).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Growth' })).toHaveAttribute('href', '/admin/impersonate');
    expect(nav.querySelectorAll('li')).toHaveLength(1);
  });

  it('adds the optional parent crumb between the group and the title', () => {
    render(
      <AdminPage
        group="Growth"
        parent={{ href: '/admin/impersonate', label: 'Support' }}
        title="Main Street Cafe"
      >
        <div />
      </AdminPage>,
    );
    const links = screen.getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(['Growth', 'Support']);
    expect(links[1]).toHaveAttribute('href', '/admin/impersonate');
    // The separator is decorative — hidden from the accessibility tree.
    expect(screen.getByText('›')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('heading', { name: 'Main Street Cafe' })).toBeInTheDocument();
  });

  it.each([
    ['Growth', '/admin/impersonate'],
  ] as const)('links the %s group to %s', (group, href) => {
    render(
      <AdminPage group={group} title="x">
        <div />
      </AdminPage>,
    );
    expect(screen.getByRole('link', { name: group })).toHaveAttribute('href', href);
  });
});
