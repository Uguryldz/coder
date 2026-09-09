import { useState } from "react";
import type { ReactNode } from "react";
import { SELECTABLE_GATES } from "@maestro/contracts";
import { useT } from "../../i18n/I18nProvider.tsx";
import { Badge, Button, Modal, Table } from "../../ui/index.ts";
import type { BadgeTone, Column } from "../../ui/index.ts";
import { KeyValue } from "../common/format.tsx";
import { englishAside } from "../common/jira-english.ts";
import { deadStatusEntries, statusSummary } from "../common/status-map.ts";
import { gatePointsOfMap } from "./draft.ts";
import { shortAccount, type FlowType, type ListeningRule } from "./types.ts";

const FLOW_TONE: Readonly<Record<FlowType, BadgeTone>> = {
  analiz: "blue",
  duzeltme: "amber",
  gelistirme: "green",
};

export interface RuleTableProps {
  readonly rules: readonly ListeningRule[];
  readonly canWrite: boolean;
  readonly onEdit: (rule: ListeningRule) => void;
  readonly onDelete: (rule: ListeningRule) => void;
  readonly deleting: boolean;
}

/**
 * Bir statü/konu türü değeri ID biçiminde mi saklanmış?
 *
 * Takım yönetimli ("next-gen") bir projede kural, JQL'in tek kabul ettiği şeyi
 * saklar: id (gerekçe `RuleForm`daki `MatchValuePicker`da, canlı ölçümle). Bu
 * tablo bütün projelerin kurallarını yan yana gösterir, dolayısıyla elinde tek
 * bir projenin ad↔id listesi yoktur ve id'yi ADA çeviremez — başka projenin
 * listesiyle çevirmek yanlış ad yazmak olurdu, ham id'den kötü.
 *
 * Yapabileceği ve yapması gereken şey: o değerin bir AD OLMADIĞINI söylemek.
 * Ayırt etme kuralı `jira-discovery.ts`'in JQL'i kurarken kullandığıyla aynı:
 * yalnız rakamdan ibaret bir statü/tip ADI yoktur.
 */
function isIdValue(rule: ListeningRule): boolean {
  return (
    (rule.matchKind === "status" || rule.matchKind === "issuetype") &&
    /^[0-9]+$/u.test(rule.matchValue.trim())
  );
}

/** Tetikleyici, tek satırda: tür · değer · (İngilizce adı). */
function TriggerCell({ rule }: { readonly rule: ListeningRule }): ReactNode {
  const t = useT();
  // `*` bir saklama ayrıntısı; basılırsa operatör "*" adlı statü arar.
  if (rule.matchKind === "assigned") return <b>{t("listening.match.assigned")}</b>;
  // Etiket için İngilizce ek YOK: tablo Jira'nın kendi statü/tip adlarını
  // bilir, bir etiket ise operatörün uydurduğu serbest metindir.
  const english = rule.matchKind === "label" ? null : englishAside(rule.matchValue);
  return (
    <>
      <span className="scr-hint">{t(`listening.match.${rule.matchKind}`)}</span> <b>{rule.matchValue}</b>
      {isIdValue(rule) && <span className="scr-hint"> {t("listening.match.id_aside")}</span>}
      {english !== null && <span className="scr-hint"> {t("jira.english.aside", { english })}</span>}
    </>
  );
}

/**
 * KURAL LİSTESİ — altı sütun, gerisi satır açılınca.
 *
 * Sütunlar operatörün ilk bakışta sorduğu şeyler: hangi proje, ne tetikler,
 * hangi statüde, ne yapar, kural açık mı ve ticket'ı taşıyor mu. Kapılar, bot
 * hesabı, öncelik ve ölü değerler ikinci sorudur; satıra tıklanınca gelir.
 */
export function RuleTable({ rules, canWrite, onEdit, onDelete, deleting }: RuleTableProps): ReactNode {
  const t = useT();
  const [openId, setOpenId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ListeningRule | null>(null);
  const open = rules.find((r) => r.ruleId === openId) ?? null;

  const columns: readonly Column<ListeningRule>[] = [
    {
      key: "projectKey",
      header: t("listening.col.project"),
      cell: (r) => <b className="scr-mono">{r.projectKey}</b>,
    },
    { key: "trigger", header: t("listening.col.trigger"), cell: (r) => <TriggerCell rule={r} /> },
    {
      key: "allowedStatuses",
      header: t("listening.col.allowed_statuses"),
      // Bu sütunun işi EKSİK olanı göstermek: "her ticket'ı alan" kural burada ele verir.
      cell: (r) => {
        const allowed = r.allowedStatuses ?? [];
        return allowed.length === 0 ? (
          <span className="scr-hint" style={{ color: "var(--amber)", fontWeight: 600 }}>
            {t("listening.status_gate.none")}
          </span>
        ) : (
          <span className="scr-hint">{allowed.join(", ")}</span>
        );
      },
    },
    {
      key: "flow",
      header: t("listening.col.flow"),
      cell: (r) => (
        <>
          <Badge tone={FLOW_TONE[r.flowType]}>{t(`listening.flow.${r.flowType}`)}</Badge>
          {/* Ajan seçilmişse söylenir; seçilmemişse sessiz — "varsayılan" her satırda gürültü. */}
          {(r.analystVariantId || r.engineerVariantId) && (
            <div className="scr-hint">
              {[r.analystVariantId, r.engineerVariantId].filter(Boolean).join(" · ")}
            </div>
          )}
        </>
      ),
    },
    {
      key: "state",
      header: t("listening.col.state"),
      // Kural açık mı, ve ticket'ı TAŞIYOR mu — ikisi de listeden okunmalı,
      // her kuralı açarak keşfedilecek şeyler değil.
      cell: (r) => {
        const steps = statusSummary(r.statusMap, r.flowType);
        const dead = deadStatusEntries(r.statusMap, r.flowType);
        const walk = steps.length > 0 ? steps.join(" → ") : t("listening.status.comment_only_short");
        return (
          <>
            {!r.enabled && <Badge tone="gray">{t("listening.state.disabled")}</Badge>}{" "}
            <span className="scr-hint" title={walk}>
              {walk}
            </span>
            {dead.length > 0 && (
              <span className="scr-hint">
                {" · "}
                {t("listening.status.dead_cell", { values: dead.map((e) => e.value).join(", ") })}
              </span>
            )}
          </>
        );
      },
    },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (r) =>
        canWrite ? (
          <span className="scr-row" style={{ justifyContent: "flex-end", flexWrap: "nowrap" }}>
            {/* Satır tıklaması ayrıntıyı açar; hücredeki düğme kendi işini yapar, satıra kabarmaz. */}
            <Button
              size="sm"
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation();
                onEdit(r);
              }}
            >
              {t("listening.action.edit")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation();
                setPendingDelete(r);
              }}
            >
              {t("listening.action.delete")}
            </Button>
          </span>
        ) : null,
    },
  ];

  return (
    <>
      <Table
        columns={columns}
        rows={rules}
        rowKey={(r) => r.ruleId}
        onRowClick={(r) => setOpenId((prev) => (prev === r.ruleId ? null : r.ruleId))}
        emptyLabel={t("listening.empty")}
        caption={t("listening.table.caption")}
      />
      {open !== null && <RuleDetail rule={open} onClose={() => setOpenId(null)} />}
      <Modal
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title={t("listening.confirm.delete_title")}
        closeLabel={t("action.close")}
        footer={
          <>
            <Button onClick={() => setPendingDelete(null)}>{t("action.cancel")}</Button>
            <Button
              variant="danger"
              busy={deleting}
              onClick={() => {
                if (pendingDelete === null) return;
                onDelete(pendingDelete);
                setPendingDelete(null);
              }}
            >
              {t("listening.action.delete")}
            </Button>
          </>
        }
      >
        {pendingDelete !== null && (
          <p className="scr-prose">
            {t("listening.confirm.delete_desc", {
              project: pendingDelete.projectKey,
              trigger:
                pendingDelete.matchKind === "assigned"
                  ? t("listening.match.assigned")
                  : pendingDelete.matchValue,
            })}
          </p>
        )}
      </Modal>
    </>
  );
}

/** Satır açılınca: listeye sığmayan ikinci soruların cevabı. */
function RuleDetail({ rule, onClose }: { readonly rule: ListeningRule; readonly onClose: () => void }): ReactNode {
  const t = useT();
  const gates = rule.gateSteps ?? null;
  const gateText =
    gates === null
      ? t("listening.gates.default")
      : gates.steps.length === 0
        ? t("listening.gates.none_selected")
        : SELECTABLE_GATES.filter((g) => gates.steps.includes(g.step))
            .map((g) => t(g.titleKey))
            .join(" · ") + (gates.ownerless === true ? ` · ${t("listening.gates.ownerless")}` : "");
  const map = rule.statusMap ?? null;
  return (
    <div className="scr-note" style={{ margin: 10 }} role="region" aria-label={t("listening.detail.label")}>
      <div className="scr-row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
        <b>
          {rule.projectKey} · {rule.matchKind === "assigned" ? t("listening.match.assigned") : rule.matchValue}
        </b>
        <Button size="sm" variant="ghost" onClick={onClose}>
          {t("action.close")}
        </Button>
      </div>
      <KeyValue
        entries={[
          {
            label: t("listening.col.assignee"),
            value: (
              <span className="scr-mono" title={rule.assigneeAccountId}>
                {shortAccount(rule.assigneeAccountId)}
              </span>
            ),
          },
          {
            label: t("listening.agent.analyst"),
            value: rule.analystVariantId ?? t("listening.agent.default"),
          },
          {
            label: t("listening.agent.engineer"),
            value: rule.engineerVariantId ?? t("listening.agent.default"),
          },
          { label: t("listening.gates.title"), value: gateText },
          {
            label: t("listening.detail.gate_status"),
            // Sunucunun okuyacağı iki kenar, aynı geri düşüş sırasıyla
            // (`gatePointsOfMap`) — formdaki aynayla aynı kaynak.
            value: (() => {
              if (rule.flowType === "duzeltme") return t("listening.gate_status.no_gate_flow");
              const points = gatePointsOfMap(map);
              if (points.approve === "" && points.return === "") {
                return t("listening.status.comment_only_short");
              }
              return t("listening.detail.gate_status_value", {
                approve: points.approve === "" ? t("listening.gate_status.derived_none") : points.approve,
                back: points.return === "" ? t("listening.gate_status.derived_none") : points.return,
              });
            })(),
          },
          { label: t("listening.form.priority"), value: String(rule.priority) },
          {
            label: t("listening.col.state"),
            value: rule.enabled ? t("listening.state.enabled") : t("listening.state.disabled"),
          },
        ]}
      />
    </div>
  );
}
