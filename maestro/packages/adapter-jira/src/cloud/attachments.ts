/**
 * Attachment metadata is the same shape on Jira Cloud (REST v3) and Data
 * Center (REST v2): `fields.attachment[]` with `id`, `filename`, `mimeType`,
 * `size`, `content`. The module moved up a level so the DC driver reads it
 * too; this file keeps the old import path alive.
 */
export * from "../attachments.js";
