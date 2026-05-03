// src/lib/zernio/canonicalize-reply.ts
//
// Used by BOTH the publisher 409 verifier (spec §6.10b) AND the ingest
// reconcile helper (spec §6.3b) to compare reply text robustly. A round-trip
// through Zernio + Google can introduce CRLF↔LF, Unicode NFC↔NFD, BOM, and
// zero-width-character differences that .trim() alone misses, causing
// false text-mismatch supersessions.
//
// Conservative normalization only:
//   - strip BOM (U+FEFF) and zero-width chars (U+200B-U+200D) globally
//     (these can appear from copy-paste through web UIs and break equality
//     comparisons silently — internal occurrences are removed too because
//     they have no semantic value in user-visible text)
//   - collapse \r\n and lone \r → \n
//   - Unicode-normalize to NFC
//   - trim outer whitespace
// Does NOT collapse internal whitespace (would change meaning).

const BOM_AND_ZERO_WIDTH = /[﻿​-‍]/g;

export function canonicalizeReplyText(text: string | null | undefined): string {
  if (text == null) return '';
  return text
    .replace(BOM_AND_ZERO_WIDTH, '')
    .replace(/\r\n?/g, '\n')   // CRLF / CR → LF
    .normalize('NFC')           // canonical-composition Unicode normalization
    .trim();
}
