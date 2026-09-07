/**
 * The dependency-free `.docx`/zip reader now lives in `@maestro/doc-text`, so
 * the worker can read a ticket's Word attachments with the same code the BFF
 * uses to scan a corporate template. Re-exported here so the BFF's own
 * imports and tests keep their paths.
 */
export {
  DOCX_DOCUMENT_ENTRY,
  DOCX_STYLES_ENTRY,
  DocxReadError,
  looksLikeZip,
  MAX_ENTRY_BYTES,
  readZipEntry,
  zipEntryNames,
} from "@maestro/doc-text";
