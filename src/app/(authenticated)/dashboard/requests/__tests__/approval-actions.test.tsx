// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ApprovalActions, approvalButtonLabel } from '../ApprovalActions';

describe('approvalButtonLabel', () => {
  it('carries the live count on the idle approve label and drops it while busy', () => {
    expect(approvalButtonLabel({ verb: 'approve', busy: false, sendPhrase: '3 messages' })).toBe(
      'Approve and send 3 messages',
    );
    expect(approvalButtonLabel({ verb: 'approve', busy: true, sendPhrase: '3 messages' })).toBe('Approving…');
  });

  it('names the stop verb in the owner\'s word, idle and in flight', () => {
    expect(approvalButtonLabel({ verb: 'halt', busy: false, sendPhrase: '3 messages' })).toBe('Stop this batch');
    expect(approvalButtonLabel({ verb: 'halt', busy: true, sendPhrase: '3 messages' })).toBe('Stopping…');
  });
});

describe('ApprovalActions', () => {
  const base = { busy: false, unavailable: false, sendPhrase: '2 messages' };

  it('renders nothing when the Batch state offers no verb', () => {
    const { container } = render(
      <ApprovalActions {...base} verb={null} onApprove={vi.fn()} onHalt={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('wires approve as the primary button and halt as the secondary one', () => {
    const onApprove = vi.fn();
    const onHalt = vi.fn();
    const { rerender } = render(
      <ApprovalActions {...base} verb="approve" onApprove={onApprove} onHalt={onHalt} />,
    );
    const approve = screen.getByRole('button', { name: 'Approve and send 2 messages' });
    expect(approve).toHaveClass('btn-primary');
    fireEvent.click(approve);
    expect(onApprove).toHaveBeenCalledOnce();
    expect(onHalt).not.toHaveBeenCalled();

    rerender(<ApprovalActions {...base} verb="halt" onApprove={onApprove} onHalt={onHalt} />);
    const halt = screen.getByRole('button', { name: 'Stop this batch' });
    expect(halt).toHaveClass('btn-secondary');
    fireEvent.click(halt);
    expect(onHalt).toHaveBeenCalledOnce();
    expect(onApprove).toHaveBeenCalledOnce();
  });

  // UX audit D7: a block the label cannot explain gets a one-line reason.
  it('explains an unavailable verb and points the button at the reason', () => {
    render(
      <ApprovalActions {...base} verb="halt" unavailable onApprove={vi.fn()} onHalt={vi.fn()} />,
    );
    const halt = screen.getByRole('button', { name: 'Stop this batch' });
    expect(halt).toBeDisabled();
    expect(halt).toHaveAccessibleDescription(
      'You can stop this batch once the new version of that message is ready.',
    );
  });

  it('gives a busy verb no reason — the relabel already says what is happening', () => {
    render(
      <ApprovalActions {...base} verb="approve" busy unavailable onApprove={vi.fn()} onHalt={vi.fn()} />,
    );
    const approve = screen.getByRole('button', { name: 'Approving…' });
    expect(approve).toBeDisabled();
    expect(approve).not.toHaveAttribute('aria-describedby');
    expect(screen.queryByText(/once the new version/)).not.toBeInTheDocument();
  });
});
