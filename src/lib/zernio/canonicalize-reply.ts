// src/lib/zernio/canonicalize-reply.ts
//
// Used by BOTH the publisher 409 verifier (spec §6.10b) AND the ingest
// reconcile helper (spec §6.3b) to compare reply text robustly. A round-trip
// through Zernio + Google can introduce CRLF↔LF and Unicode NFC↔NFD differences
// that .trim() alone misses, causing false text-mismatch supersessions.
//
// Conservative normalization only:
//   - trim outer whitespace
//   - collapse \r\n and lone \r → \n
//   - Unicode-normalize to NFC
// Does NOT collapse internal whitespace (would change meaning).

export function canonicalizeReplyText(text: string | null | undefined): string {
  if (text == null) return '';
  return text
    .replace(/\r\n?/g, '\n')   // CRLF / CR → LF
    .normalize('NFC')           // canonical-composition Unicode normalization
    .trim();
}
