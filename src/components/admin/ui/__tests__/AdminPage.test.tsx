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
});
