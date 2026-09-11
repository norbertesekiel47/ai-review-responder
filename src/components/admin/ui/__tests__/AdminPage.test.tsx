// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AdminPage } from '../AdminPage';

describe('AdminPage', () => {
  it('renders group, title, description, actions, and children', () => {
    render(
      <AdminPage group="Operate" title="Costs" description="LLM + API spend" actions={<button>Export</button>}>
        <div>page body</div>
      </AdminPage>,
    );
    expect(screen.getByText('Operate')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Costs' })).toBeInTheDocument();
    expect(screen.getByText('LLM + API spend')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument();
    expect(screen.getByText('page body')).toBeInTheDocument();
  });

  // X28: the eyebrow is a breadcrumb, not a caption. The group links to its
  // sidebar landing page (derived from ADMIN_NAV_GROUPS, the IA's single owner).
  it('renders the group eyebrow as a breadcrumb link to the group landing page', () => {
    render(
      <AdminPage group="Businesses" title="Main Street Cafe">
        <div />
      </AdminPage>,
    );
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(nav).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Businesses' })).toHaveAttribute('href', '/admin/locations/csv-import');
    // Operate's landing page is Overview; Safety's is Flagged.
    expect(nav.querySelectorAll('li')).toHaveLength(1);
  });

  it('adds the optional parent crumb between the group and the title', () => {
    render(
      <AdminPage
        group="Businesses"
        parent={{ href: '/admin/locations/csv-import', label: 'Locations import' }}
        title="Main Street Cafe"
      >
        <div />
      </AdminPage>,
    );
    const links = screen.getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(['Businesses', 'Locations import']);
    expect(links[1]).toHaveAttribute('href', '/admin/locations/csv-import');
    // The separator is decorative — hidden from the accessibility tree.
    expect(screen.getByText('›')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('heading', { name: 'Main Street Cafe' })).toBeInTheDocument();
  });

  it.each([
    ['Operate', '/admin/overview'],
    ['Safety', '/admin/flagged'],
    ['Growth', '/admin/demos'],
  ] as const)('links the %s group to %s', (group, href) => {
    render(
      <AdminPage group={group} title="x">
        <div />
      </AdminPage>,
    );
    expect(screen.getByRole('link', { name: group })).toHaveAttribute('href', href);
  });
});
