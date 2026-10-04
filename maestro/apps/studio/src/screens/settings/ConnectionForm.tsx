import { CONNECTION_KIND_SPECS, missingConfigKeys } from "@maestro/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import { messageKeyOf } from "../../api/errors.ts";
import { useApi } from "../../auth/AuthProvider.tsx";
import { useT } from "../../i18n/I18nProvider.tsx";
import { Button, FieldGroup, Input, Modal, Select, useToast } from "../../ui/index.ts";
import type { ManagedConnection, ManagedConnectionInput, ManagedConnectionKind } from "../common/index.ts";
import {
  BOT_DISPLAY_NAME_KEY,
  KINDS,
  SKIP_TLS_KEY,
  familyOf,
  isAuthField,
  isJiraKind,
  isModelKind,
  isProbeless,
  isTokenRequired,
  isValidBaseUrl,
  sendsEmptyToken,
  urlPlaceholder,
} from "./connection-kinds.ts";

/**
 * The add/edit dialog for one connection, in four named groups:
 *
 *  1. Kimlik — id (new rows only), kind, display name.
 *  2. Adres — the base URL, with a hint written for THIS kind (the old form
 *     told every model kind "without /v1" while OpenRouter's own address ends
 *     in `/api/v1` and only `openai_compat` is ever trimmed).
 *  3. Kimlik doğrulama — the scheme the kind really uses, stated in words, plus
 *     the fields that feed it: the Jira Cloud e-mail and the token.
 *  4. Seçenekler — enabled, on-prem and default (model kinds), TLS skip, the
 *     model id, the bot's display name (Jira), and the rest of the kind's
 *     non-secret fields.
 *
 * Required fields carry a `*`; every check runs as the operator types and
 * shows once the box has been left or a save was attempted. The token is
 * write-only: on edit it starts locked behind the stored mask and an untouched
 * save omits it, so the stored credential survives.
 */
export function ConnectionForm({
  connection,
  initialKind,
  onClose,
}: {
  readonly connection?: ManagedConnection;
  /** Pre-selected kind for a new row (from the family's "add" button). */
  readonly initialKind?: ManagedConnectionKind;
  readonly onClose: () => void;
}): ReactNode {
  const api = useApi();
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const editing = connection !== undefined;

  const [id, setId] = useState(connection?.id ?? "");
  const [kind, setKind] = useState<ManagedConnectionKind>(connection?.kind ?? initialKind ?? "jira_dc");
  const [displayName, setDisplayName] = useState(connection?.displayName ?? "");
  const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? "");
  const [enabled, setEnabled] = useState(connection?.enabled ?? true);
  const [onPrem, setOnPrem] = useState(connection?.onPrem ?? kind === "openai_compat");
  const [isDefault, setIsDefault] = useState(connection?.isDefault ?? false);
  /** The kind's non-secret fields by config key — round-tripped verbatim so a learned `botAccountId` survives. */
  const [cfg, setCfg] = useState<Record<string, string>>(() => ({ ...(connection?.config ?? {}) }));
  const [skipTls, setSkipTls] = useState(connection?.config[SKIP_TLS_KEY] === "true");
  // On edit with a token set, the field is locked until the admin chooses to change it.
  const [changingToken, setChangingToken] = useState(!editing || !(connection?.secretSet ?? false));
  const [token, setToken] = useState("");
  const [left, setLeft] = useState<ReadonlySet<string>>(new Set());
  const [submitted, setSubmitted] = useState(false);

  const spec = CONNECTION_KIND_SPECS[kind];
  const model = isModelKind(kind);
  const jira = isJiraKind(kind);
  const tokenRequired = isTokenRequired(kind);

  // ── validation, live ───────────────────────────────────────────────────────
  const missing = missingConfigKeys(kind, cfg);
  const errors: Record<string, string | undefined> = {
    id: !editing && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id.trim()) ? t("connections.error.id") : undefined,
    name: displayName.trim() === "" ? t("connections.error.name") : undefined,
    url: !isValidBaseUrl(kind, baseUrl.trim())
      ? t(kind === "smtp" ? "connections.error.url_smtp" : "connections.error.url")
      : undefined,
    token: changingToken && tokenRequired && token === "" ? t("connections.error.token") : undefined,
  };
  for (const field of spec.fields) {
    if (missing.includes(field.key)) {
      errors[field.key] = t("connections.error.missing_config", { fields: t(field.labelKey) });
    }
  }
  const blocked = Object.values(errors).some((error) => error !== undefined);
  const show = (field: string): { error: string } | Record<string, never> =>
    (submitted || left.has(field)) && errors[field] !== undefined ? { error: errors[field] } : {};
  const leave = (field: string) => () => setLeft((current) => new Set(current).add(field));
  const req = (label: string): string => `${label} *`;

  /**
   * The non-secret config bag the save sends: stored keys verbatim, the kind's
   * fields trimmed (an empty optional is dropped, not stored as ""), the bot
   * display name likewise, and the TLS switch written as "true" or REMOVED —
   * an absent key is the fail-closed default everywhere it is read.
   */
  const configBag = (): Record<string, string> => {
    const bag: Record<string, string> = { ...cfg };
    for (const key of [...spec.fields.map((field) => field.key), BOT_DISPLAY_NAME_KEY]) {
      const value = (bag[key] ?? "").trim();
      if (value === "") delete bag[key];
      else bag[key] = value;
    }
    if (skipTls) bag[SKIP_TLS_KEY] = "true";
    else delete bag[SKIP_TLS_KEY];
    return bag;
  };

  const save = useMutation({
    mutationFn: () => {
      const body: ManagedConnectionInput & { id?: string } = {
        kind,
        displayName: displayName.trim(),
        baseUrl: baseUrl.trim(),
        // The KIND decides the scheme; the form states it, never asks.
        authKind: spec.authKind,
        config: configBag(),
        enabled,
        // Only meaningful for a model row — the resolver ignores both otherwise.
        onPrem: model && onPrem,
        isDefault: model && isDefault,
        // A token travels only when the admin actually entered one, so an
        // untouched edit keeps the stored credential. The self-hosted server is
        // the exception: its empty box is a real answer ("no key") and is SENT.
        ...(changingToken && (token !== "" || sendsEmptyToken(kind)) ? { token } : {}),
      };
      return editing
        ? api.put<{ connection: ManagedConnection }>(`/studio/connections/${connection.id}`, body)
        : api.post<{ connection: ManagedConnection }>("/studio/connections", { ...body, id: id.trim() });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["connections"] });
      toast.show(
        "success",
        t(editing ? "connections.toast.updated" : "connections.toast.created", {
          name: displayName.trim() || id.trim(),
        }),
      );
      onClose();
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  const submit = (): void => {
    setSubmitted(true);
    if (blocked) return;
    save.mutate();
  };

  /**
   * Switching kind rebuilds the config bag for the NEW kind: keys it knows are
   * kept (an operator correcting a typo does not retype), the rest are dropped
   * — an Anthropic model id must not be saved on a Jira row. The on-prem
   * default follows the kind for a new row only; an edit keeps the assertion.
   */
  const changeKind = (next: ManagedConnectionKind): void => {
    setKind(next);
    const keep = new Set(CONNECTION_KIND_SPECS[next].fields.map((field) => field.key));
    if (isJiraKind(next)) keep.add(BOT_DISPLAY_NAME_KEY);
    keep.add("botAccountId");
    setCfg((current) => {
      const rebuilt: Record<string, string> = {};
      for (const [key, value] of Object.entries(current)) if (keep.has(key)) rebuilt[key] = value;
      return rebuilt;
    });
    if (!editing) setOnPrem(next === "openai_compat");
  };

  const authFields = spec.fields.filter((field) => isAuthField(field.key));
  const optionFields = spec.fields.filter((field) => !isAuthField(field.key));

  const configInput = (field: (typeof spec.fields)[number]): ReactNode => (
    <Input
      key={field.key}
      label={field.required ? req(t(field.labelKey)) : t(field.labelKey)}
      value={cfg[field.key] ?? ""}
      onChange={(event) => setCfg((current) => ({ ...current, [field.key]: event.target.value }))}
      onBlur={leave(field.key)}
      {...(field.placeholder === undefined ? {} : { placeholder: field.placeholder })}
      {...(field.hintKey === undefined ? {} : { hint: t(field.hintKey) })}
      {...show(field.key)}
    />
  );

  return (
    <Modal
      open
      onClose={onClose}
      title={t(editing ? "connections.modal.edit_title" : "connections.modal.add_title")}
      closeLabel={t("action.close")}
      footer={
        <>
          <span className="scr-mini" style={{ marginRight: "auto" }}>
            {t("connections.required_note")}
          </span>
          <Button onClick={onClose}>{t("action.cancel")}</Button>
          <Button variant="primary" busy={save.isPending} onClick={submit}>
            {t(editing ? "action.save" : "connections.action.add")}
          </Button>
        </>
      }
    >
      <div className="scr-stack">
        <FieldGroup legend={t("connections.group.identity")} columns={2}>
          {!editing && (
            <Input
              label={req(t("connections.field.id"))}
              value={id}
              onChange={(event) => setId(event.target.value)}
              onBlur={leave("id")}
              hint={t("connections.field.id_hint")}
              {...show("id")}
            />
          )}
          <Select
            label={req(t("connections.field.kind"))}
            value={kind}
            disabled={editing}
            onChange={(event) => changeKind(event.target.value as ManagedConnectionKind)}
            options={KINDS.map((option) => ({
              value: option,
              // Grouped by family in the label, so jira_cloud and jira_dc read as alternatives.
              label: `${t(`connections.family.${familyOf(option)}`)} · ${t(`connections.kind.${option}`)}`,
            }))}
          />
          <Input
            label={req(t("connections.field.name"))}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            onBlur={leave("name")}
            {...show("name")}
          />
        </FieldGroup>

        <FieldGroup legend={t("connections.group.address")}>
          <Input
            label={req(t("connections.field.url"))}
            value={baseUrl}
            placeholder={urlPlaceholder(kind)}
            hint={t(`connections.url_hint.${kind}`)}
            onChange={(event) => setBaseUrl(event.target.value)}
            onBlur={leave("url")}
            {...show("url")}
          />
        </FieldGroup>

        <FieldGroup
          legend={t("connections.group.auth")}
          hint={
            isProbeless(kind)
              ? `${t(`connections.auth_scheme.${kind}`)} · ${t("connections.probeless")}`
              : t(`connections.auth_scheme.${kind}`)
          }
        >
          {authFields.map(configInput)}
          {changingToken ? (
            <Input
              label={tokenRequired ? req(t("connections.field.token")) : t("connections.field.token")}
              type="password"
              autoComplete="new-password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              onBlur={leave("token")}
              hint={t(tokenRequired ? "connections.field.token_hint" : "connections.field.token_hint_optional")}
              {...show("token")}
            />
          ) : (
            <div className="scr-row">
              <span className="scr-mini">{t("connections.field.token")}</span>
              <span className="scr-mono">{`****${connection?.secretMask ?? ""}`}</span>
              <Button size="sm" variant="ghost" onClick={() => setChangingToken(true)}>
                {t("connections.token.change")}
              </Button>
            </div>
          )}
        </FieldGroup>

        <FieldGroup legend={t("connections.group.options")}>
          {optionFields.map(configInput)}
          {jira && (
            <Input
              label={t("connections.cfg.bot_display_name")}
              value={cfg[BOT_DISPLAY_NAME_KEY] ?? ""}
              onChange={(event) =>
                setCfg((current) => ({ ...current, [BOT_DISPLAY_NAME_KEY]: event.target.value }))
              }
              placeholder="Maestro"
              hint={t("connections.cfg.bot_display_name_hint")}
            />
          )}
          <div className="scr-checklist">
            <Check checked={enabled} onChange={setEnabled} label={t("connections.field.enabled")} />
            {model && (
              <>
                <Check
                  checked={onPrem}
                  onChange={setOnPrem}
                  label={t("connections.field.on_prem")}
                  hint={t("connections.field.on_prem_hint")}
                />
                <Check
                  checked={isDefault}
                  onChange={setIsDefault}
                  label={t("connections.field.is_default")}
                  hint={t("connections.field.is_default_hint")}
                />
              </>
            )}
            <Check
              checked={skipTls}
              onChange={setSkipTls}
              label={t("connections.field.skip_tls")}
              hint={t("connections.field.skip_tls_hint")}
            />
          </div>
        </FieldGroup>
      </div>
    </Modal>
  );
}

/** A checkbox with its label and an optional hint under it. */
function Check({
  checked,
  onChange,
  label,
  hint,
}: {
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
  readonly label: string;
  readonly hint?: string;
}): ReactNode {
  return (
    <div>
      <label className="scr-check">
        <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
        {label}
      </label>
      {hint !== undefined && <p className="scr-hint" style={{ margin: "2px 0 0 22px" }}>{hint}</p>}
    </div>
  );
}
