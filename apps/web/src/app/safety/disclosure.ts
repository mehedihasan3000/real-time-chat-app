/**
 * Safety surfaces v0 (P1-18, DEC-008).
 *
 * Block/report controls are native API flows; this module documents the
 * consent + preview contract the web UI must implement (no server-side
 * decryption/scanning; excerpts only after explicit consent).
 */
export const SAFETY_DISCLOSURE =
  "Reports include only the metadata and excerpts you select. The server never decrypts or scans message content. Reporter identity is never disclosed to the reported user." as const;

export const EXCERPT_PREVIEW_REQUIRED = true as const;
