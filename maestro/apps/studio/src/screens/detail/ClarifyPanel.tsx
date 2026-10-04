import { useState } from "react";
import type { ReactNode } from "react";
import { messageKeyOf } from "../../api/errors.ts";
import { useT } from "../../i18n/I18nProvider.tsx";
import { Button, Card, TextArea, useToast } from "../../ui/index.ts";
import { useClarificationAnswer } from "../shared/signals.ts";

/**
 * Step 2b: intake found the ticket incomplete and is waiting on the reporter.
 *
 * The wait is unbounded by design — no auto-reject, because a timed-out
 * ticket loses the flow context that makes the answer cheap; the reminder
 * ladder is the pressure instead. Answering sends the `clarificationAnswered`
 * SIGNAL, the same channel a Jira comment takes, to THIS ticket: the panel
 * lives on the run's own detail page, so there is no ticket field to mistype.
 */
export function ClarifyPanel({ ticket }: { readonly ticket: string }): ReactNode {
  const t = useT();
  const toast = useToast();
  const answer = useClarificationAnswer();
  const [text, setText] = useState("");
  const [touched, setTouched] = useState(false);

  const missing = text.trim() === "";

  function submit(): void {
    setTouched(true);
    if (missing) return;
    answer.mutate(
      { ticket, text: text.trim() },
      {
        onSuccess: () => {
          toast.show("success", t("detail.clarify.sent", { ticket }));
          setText("");
          setTouched(false);
        },
        onError: (mutationError) => toast.show("error", t(messageKeyOf(mutationError))),
      },
    );
  }

  return (
    <Card title={t("detail.clarify.title")}>
      <p className="scr-hint">{t("detail.clarify.body")}</p>
      <TextArea
        label={t("detail.clarify.field")}
        value={text}
        rows={4}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => setTouched(true)}
        hint={t("detail.clarify.field_hint")}
        {...(touched && missing ? { error: t("detail.clarify.required") } : {})}
      />
      <div className="scr-actions">
        <Button variant="primary" busy={answer.isPending} disabled={missing} onClick={submit}>
          {t("detail.clarify.action")}
        </Button>
      </div>
    </Card>
  );
}
