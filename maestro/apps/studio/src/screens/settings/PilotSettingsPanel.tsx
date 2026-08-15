import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import { ApiError, messageKeyOf } from "../../api/errors.ts";
import { useApi, useAuth } from "../../auth/AuthProvider.tsx";
import { hasAnyRole } from "../../auth/types.ts";
import { useT } from "../../i18n/I18nProvider.tsx";
import { Button, Card, Input, Select, useToast } from "../../ui/index.ts";
import { useLabel } from "../common/label.ts";
import { QueryState } from "../shared/QueryState.tsx";

/**
 * The flow engine's runtime settings ("Motor ayarları"), edited from Studio
 * through the BFF proxy (`GET/POST /studio/pilot/settings`).
 *
 * SCHEMA-AGNOSTIC ON PURPOSE. The pilot owns the settings vocabulary and grows
 * it independently of this build (e.g. an `autoStart` added engine-side). So
 * this panel renders whatever the GET returned — booleans as checkboxes,
 * numbers as number inputs, strings as text — and POSTs the WHOLE object back
 * with only the edited fields overwritten. A field this build has never heard
 * of is therefore shown, editable by type, and never silently dropped from the
 * write. Known fields get proper labels from the catalog; unknown ones show
 * their machine identifier (the same fallback rule as useLabel everywhere).
 *
 * The pilot REFUSES a write mid-run (409): a run snapshots its settings at
 * start, so a change never alters an in-flight flow. That refusal is surfaced
 * as its own Turkish sentence rather than the generic error.
 */

/** Who may save. Mirrors the BFF's PILOT_WRITE_ROLES — enforced there anyway. */
const WRITE_ROLES = ["admin", "tech-lead"] as const;

/** Known fields first, in the order an operator scans them; the rest follow sorted. */
const KNOWN_ORDER: readonly string[] = [
  "approverGroup",
  "model",
  "commandPollMs",
  "discoveryPollMs",
  "dataClass",
  "operatorAccount",
  "sandboxRoot",
  "reviewStatusName",
  "autoMerge",
];

/** The contract's data classes — the one field with a closed vocabulary. */
const DATA_CLASSES = ["acik", "dahili", "gizli"] as const;

type SettingsWire = Readonly<Record<string, unknown>>;

export function PilotSettingsPanel(): ReactNode {
  const t = useT();
  const api = useApi();
  const toast = useToast();
  const label = useLabel();
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const canWrite = hasAnyRole(session, WRITE_ROLES);

  // Edits are an OVERLAY on the fetched object, so a refetch never wipes a
  // half-typed form and an untouched field is posted exactly as it arrived.
  const [edits, setEdits] = useState<Record<string, unknown>>({});

  const query = useQuery({
    queryKey: ["pilot-settings"],
    queryFn: ({ signal }) => api.get<SettingsWire>("/studio/pilot/settings", { signal }),
    retry: false,
  });

  const merged: Record<string, unknown> = { ...(query.data ?? {}), ...edits };

  const save = useMutation({
    // The WHOLE merged object: fields this build does not know survive the write.
    mutationFn: () => api.post<SettingsWire>("/studio/pilot/settings", merged),
    onSuccess: () => {
      setEdits({});
      void queryClient.invalidateQueries({ queryKey: ["pilot-settings"] });
      toast.show("success", t("pilot_settings.toast.saved"));
    },
    onError: (error) => {
      // 409 = the engine is mid-run; its own refusal, with its own sentence.
      const busy = error instanceof ApiError && error.status === 409;
      toast.show("error", busy ? t("pilot_settings.error.busy") : t(messageKeyOf(error)));
    },
  });

  const set = (key: string, value: unknown): void =>
    setEdits((prev) => ({ ...prev, [key]: value }));

  const keys = fieldOrder(query.data ?? {});

  return (
    <Card
      title={t("pilot_settings.title")}
      subtitle={t("pilot_settings.subtitle")}
      actions={
        canWrite ? (
          <Button
            variant="primary"
            size="sm"
            busy={save.isPending}
            disabled={query.data === undefined}
            onClick={() => save.mutate()}
          >
            {t("pilot_settings.action.save")}
          </Button>
        ) : undefined
      }
    >
      {!canWrite && <p className="screen-note">{t("pilot_settings.readonly")}</p>}
      <QueryState
        isPending={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
        skeletonRows={4}
      >
        <div className="scr-grid" style={{ gap: 8 }}>
          {keys.map((key) => (
            <SettingField
              key={key}
              name={key}
              value={merged[key]}
              disabled={!canWrite}
              labelText={label(`pilot_settings.field.${key}`, key)}
              onChange={(value) => set(key, value)}
            />
          ))}
        </div>
      </QueryState>
    </Card>
  );
}

/** Known keys the wire actually carries, in scan order, then the unknown rest. */
function fieldOrder(wire: SettingsWire): readonly string[] {
  const present = new Set(Object.keys(wire));
  const known = KNOWN_ORDER.filter((key) => present.has(key));
  const rest = [...present].filter((key) => !KNOWN_ORDER.includes(key)).sort();
  return [...known, ...rest];
}

/**
 * One field, rendered by VALUE TYPE. `dataClass` is the single special case —
 * a closed enum with catalog labels. Values of any other shape (objects,
 * arrays, null) are shown read-only as JSON: they are preserved in the POST,
 * and an editor that guessed at their structure would corrupt them.
 */
function SettingField({
  name,
  value,
  labelText,
  disabled,
  onChange,
}: {
  readonly name: string;
  readonly value: unknown;
  readonly labelText: string;
  readonly disabled: boolean;
  readonly onChange: (value: unknown) => void;
}): ReactNode {
  const t = useT();

  if (name === "dataClass" && typeof value === "string") {
    return (
      <Select
        label={labelText}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        options={DATA_CLASSES.map((cls) => ({ value: cls, label: t(`data_class.${cls}`) }))}
      />
    );
  }

  if (typeof value === "boolean") {
    return (
      <label className="scr-mini" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          type="checkbox"
          checked={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        {labelText}
      </label>
    );
  }

  if (typeof value === "number") {
    return (
      <Input
        label={labelText}
        type="number"
        value={String(value)}
        disabled={disabled}
        onChange={(event) => {
          const next = Number(event.target.value);
          // An emptied/garbled number keeps the last valid value rather than
          // posting NaN or a surprise 0 to the engine.
          if (event.target.value !== "" && Number.isFinite(next)) onChange(next);
        }}
      />
    );
  }

  if (typeof value === "string") {
    return (
      <Input
        label={labelText}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  return (
    <div className="ui-field">
      <span className="ui-field__label">{labelText}</span>
      <code className="scr-mono scr-mini">{JSON.stringify(value)}</code>
    </div>
  );
}
