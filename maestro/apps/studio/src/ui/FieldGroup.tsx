import type { ReactNode } from "react";
import "./FieldGroup.css";

export interface FieldGroupProps {
  /** Already-translated group name — rendered as the fieldset legend. */
  readonly legend: string;
  /** Already-translated one-line explanation under the legend. */
  readonly hint?: string;
  /** Field columns on a wide screen; always one column under 760px. */
  readonly columns?: 1 | 2 | 3;
  readonly children: ReactNode;
}

/**
 * Groups related fields under one name — the auth fields of a connection, the
 * address fields, the schedule of a rule. A form of twelve flat inputs reads
 * as a wall; three named groups of four read as a form.
 */
export function FieldGroup({ legend, hint, columns = 1, children }: FieldGroupProps) {
  const grid = columns === 1 ? "ui-fieldgroup__grid" : `ui-fieldgroup__grid ui-fieldgroup__grid--${columns}`;
  return (
    <fieldset className="ui-fieldgroup">
      <legend className="ui-fieldgroup__legend">{legend}</legend>
      {hint !== undefined && <p className="ui-fieldgroup__hint">{hint}</p>}
      <div className={grid}>{children}</div>
    </fieldset>
  );
}
