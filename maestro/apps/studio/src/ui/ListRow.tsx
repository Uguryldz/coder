import type { KeyboardEvent, ReactNode } from "react";
import "./ListRow.css";

export interface ListRowProps {
  /** Leading status — usually a <Badge>. */
  readonly status?: ReactNode;
  /** Already-translated primary text (the entity's name). */
  readonly title: string;
  /** Already-translated secondary text beside the title (its type / kind). */
  readonly kind?: string;
  /** Small facts under the title — "son test 3 dk önce", "varsayılan". */
  readonly meta?: ReactNode;
  /** Right-aligned actions: small / ghost Buttons. */
  readonly actions?: ReactNode;
  readonly onClick?: () => void;
}

/**
 * One entity on one line: status · name · kind · meta · actions. The list
 * layout for connections, users, rules and anything else that used to be a
 * card per item. Wrap rows in `<div className="ui-list">` for the bordered
 * list, or drop them straight into a Card with `padded={false}`.
 *
 * The row is a plain element, not a button: its actions are buttons of their
 * own. `onClick` makes the row itself focusable and Enter/Space-activatable,
 * and ignores keys that came from a control inside it.
 */
export function ListRow({ status, title, kind, meta, actions, onClick }: ListRowProps) {
  const interactive = onClick !== undefined;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!interactive || event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onClick();
    }
  };
  return (
    <div
      className={interactive ? "ui-listrow ui-listrow--click" : "ui-listrow"}
      {...(interactive
        ? {
            tabIndex: 0,
            onClick: (event: React.MouseEvent<HTMLDivElement>) => {
              // A click on a button inside the row is that button's, not the row's.
              if ((event.target as HTMLElement).closest("button, a, input, select") !== null) return;
              onClick();
            },
            onKeyDown,
          }
        : {})}
    >
      <div className="ui-listrow__status">{status}</div>
      <div className="ui-listrow__main">
        <span className="ui-listrow__title">{title}</span>
        {kind !== undefined && <span className="ui-listrow__kind">{kind}</span>}
        {meta !== undefined && <div className="ui-listrow__meta">{meta}</div>}
      </div>
      <div className="ui-listrow__actions">{actions}</div>
    </div>
  );
}
