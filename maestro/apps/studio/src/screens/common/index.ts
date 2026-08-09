/**
 * Building blocks specific to the platform-management screens.
 *
 * Cross-cluster pieces live in `../shared/` (owned by the flow-screens agent):
 * `QueryState`/`NotAvailable`, `ageLabel`, `screens.css`. Import those from
 * there — they are re-exported here only so a management screen has one import
 * for the pair, not because this module owns them.
 */
export * from "./admin-api.ts";
export * from "./onboarding-api.ts";
export { ConfirmModal } from "./ConfirmModal.tsx";
export type { ConfirmModalProps } from "./ConfirmModal.tsx";
export { NotAvailable, QueryState } from "../shared/QueryState.tsx";
export type { QueryStateProps } from "../shared/QueryState.tsx";
export { formatValue, KeyValue, useDuration } from "./format.tsx";
export type { KeyValueEntry, KeyValueProps } from "./format.tsx";
export { useEnumLabel, useLabel } from "./label.ts";
export type { EnumLabel } from "./label.ts";
