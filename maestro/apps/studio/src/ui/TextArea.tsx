import { useId } from "react";
import type { TextareaHTMLAttributes } from "react";
import "./Field.css";

/**
 * Multi-line counterpart to <Input>. Same Field.css furniture and the same
 * id-wiring rules, so label/hint/error behave exactly like <Input> and
 * getByLabelText works in tests. Use it for anything a person writes in
 * sentences — a rejection reason, a clarification answer, a JSON parameter —
 * never a single-line <Input> for those.
 */
export interface TextAreaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "className"> {
  /** Already-translated label text. */
  readonly label?: string;
  /** Already-translated hint shown under the field. */
  readonly hint?: string;
  /** Already-translated error; shows the field in red and sets aria-invalid. */
  readonly error?: string;
}

export function TextArea({ label, hint, error, id, rows = 4, ...rest }: TextAreaProps) {
  const generated = useId();
  const fieldId = id ?? generated;
  const describedBy =
    error !== undefined ? `${fieldId}-err` : hint !== undefined ? `${fieldId}-hint` : undefined;

  return (
    <div className="ui-field">
      {label !== undefined && (
        <label className="ui-field__label" htmlFor={fieldId}>
          {label}
        </label>
      )}
      <textarea
        {...rest}
        id={fieldId}
        rows={rows}
        className={error !== undefined ? "ui-input ui-input--error" : "ui-input"}
        aria-invalid={error !== undefined || undefined}
        aria-describedby={describedBy}
      />
      {error !== undefined ? (
        <p className="ui-field__error" id={`${fieldId}-err`}>
          {error}
        </p>
      ) : (
        hint !== undefined && (
          <p className="ui-field__hint" id={`${fieldId}-hint`}>
            {hint}
          </p>
        )
      )}
    </div>
  );
}
