/**
 * ADR-082 — stop a catalog write losing state the server already has.
 *
 * Pure: no I/O, so the rules are testable without a catalog.
 *
 * ── Why this exists ──────────────────────────────────────────────────
 * ADR-035 makes the browser authoritative and resolves conflicts by
 * last-writer-wins on whole records. Two incidents four days apart
 * showed that is too coarse:
 *
 *   2026-09-29  2 records lost 4 metadata_extra keys each;
 *               one description truncated 1246 -> 300 chars
 *   2026-10-03  3 records lost the same keys after a fix meant to
 *               prevent it; descriptions 1246 -> 300 and 4466 -> 300
 *
 * Neither push was malformed. Each sent a complete, valid record that
 * was simply missing things the server had. The cause is a browser tab
 * whose copy predates the server's: `syncWithServer` adopts the
 * server's record only when it is newer and runs at boot, while
 * `mutate()` touches `lastModified` to now — so a stale copy becomes
 * authoritative by the act of touching it.
 *
 * A client-side guard was tried and failed, because both it and its
 * check read the client's copy. The data at risk exists only on the
 * server, so it compared stale to stale and saw nothing wrong. The
 * protection therefore lives here, at the boundary every write already
 * passes through, and depends on nothing the caller remembers to do.
 */

/** What the server declined to overwrite, for the audit line. */
export interface WriteProtection {
  record_id: string;
  field: "metadata_extra" | "description";
  /** Keys preserved, for metadata_extra. */
  kept_keys?: string[];
  /** Lengths, for description. */
  stored_length?: number;
  incoming_length?: number;
}

export interface ProtectOptions {
  /** Opt out of §2 for a deliberate shortening that is a prefix. */
  allowDescriptionShrink?: boolean;
}

interface RecordShape {
  metadata_extra?: Record<string, unknown> | null;
  description?: string | null;
  [k: string]: unknown;
}

/**
 * §2 — is this description change a silent truncation?
 *
 * A truncation leaves the kept text a prefix of the original. Both
 * incidents went to exactly 300 characters, the length Kaltura's
 * `media.list` returns, overwriting text enriched elsewhere.
 *
 * An operator genuinely rewriting a description produces something
 * that is not a prefix, so the ordinary edit is untouched. Shortening
 * to a strict prefix — trimming a trailing paragraph — is caught, and
 * needs `allowDescriptionShrink`. That asymmetry is deliberate: the
 * cost of a false positive is an edit the operator must repeat, and
 * the cost of a false negative was 946 and 4166 characters of
 * generated text.
 */
export function isSilentTruncation(stored: string, incoming: string): boolean {
  if (incoming.length >= stored.length) return false;
  return stored.startsWith(incoming);
}

/**
 * Apply the write protections to one record.
 *
 * `stored` absent (a new record) passes straight through — there is
 * nothing to lose. A `stored` that will not parse also passes through:
 * refusing a write because the EXISTING value is corrupt would make a
 * bad record permanent.
 */
export function protectRecordWrite(
  recordId: string,
  stored: string | undefined,
  incoming: string,
  opts: ProtectOptions = {},
): { json: string; protections: WriteProtection[] } {
  if (!stored) return { json: incoming, protections: [] };

  let a: RecordShape;
  let b: RecordShape;
  try {
    a = JSON.parse(stored) as RecordShape;
    b = JSON.parse(incoming) as RecordShape;
  } catch {
    return { json: incoming, protections: [] };
  }

  const protections: WriteProtection[] = [];
  let touched = false;

  // §1 — metadata_extra merges key-wise. A key the server has and the
  // push lacks is kept. Values the push DOES carry win, so an update
  // still updates; only disappearance is prevented.
  const storedExtra = (a.metadata_extra ?? {}) as Record<string, unknown>;
  const incomingExtra = (b.metadata_extra ?? {}) as Record<string, unknown>;
  const keptKeys = Object.keys(storedExtra).filter(k => !(k in incomingExtra));
  if (keptKeys.length > 0) {
    b.metadata_extra = { ...storedExtra, ...incomingExtra };
    protections.push({ record_id: recordId, field: "metadata_extra", kept_keys: keptKeys });
    touched = true;
  }

  // §2 — a description may not silently shrink to a prefix of itself.
  const storedDesc = a.description ?? "";
  const incomingDesc = b.description ?? "";
  if (!opts.allowDescriptionShrink && storedDesc && isSilentTruncation(storedDesc, incomingDesc)) {
    b.description = storedDesc;
    protections.push({
      record_id: recordId,
      field: "description",
      stored_length: storedDesc.length,
      incoming_length: incomingDesc.length,
    });
    touched = true;
  }

  // §3 — everything else keeps last-writer-wins, so an untouched
  // record is returned byte-identical rather than re-serialised.
  return { json: touched ? JSON.stringify(b) : incoming, protections };
}
