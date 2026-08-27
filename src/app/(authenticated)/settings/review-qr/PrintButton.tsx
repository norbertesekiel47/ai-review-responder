'use client';

// Print trigger for the Review QR print view. Hidden by the print page's
// @media print rule (.print-hide) so it never appears on paper.

export function PrintButton() {
  return (
    <button type="button" className="btn btn-primary print-hide" onClick={() => window.print()}>
      Print
    </button>
  );
}
