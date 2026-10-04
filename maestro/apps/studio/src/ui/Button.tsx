import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Link } from "react-router";
import type { LinkProps } from "react-router";
import "./Button.css";

/**
 * `ghost`: no border, no background — a quiet action inside a table cell or a
 * card header. `link`: reads as an inline link (blue, underlined) but IS a
 * button, for the "Değiştir" / "bunu kullan" beside a sentence. Both replace
 * the hand-rolled `scr-linkbtn` buttons the screens used to carry.
 */
export type ButtonVariant = "default" | "primary" | "success" | "danger" | "ghost" | "link";
export type ButtonSize = "md" | "sm";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  /** Renders a spinner-ish disabled state; the label stays put to avoid layout jump. */
  readonly busy?: boolean;
  readonly children: ReactNode;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  default: "",
  primary: "ui-btn--primary",
  success: "ui-btn--success",
  danger: "ui-btn--danger",
  ghost: "ui-btn--ghost",
  link: "ui-btn--link",
};

function classesFor(variant: ButtonVariant, size: ButtonSize): string {
  return ["ui-btn", VARIANT_CLASS[variant], size === "sm" ? "ui-btn--sm" : ""]
    .filter((c) => c !== "")
    .join(" ");
}

/**
 * The only button in the Studio. Mirrors `.btn` / `.btn.p` / `.btn.g` / `.btn.d`
 * from the mock. Labels must come from the catalog — pass an already-translated
 * string, never a literal.
 */
export function Button({
  variant = "default",
  size = "md",
  busy = false,
  disabled,
  type = "button",
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className={classesFor(variant, size)}
      disabled={disabled === true || busy}
      aria-busy={busy || undefined}
    >
      {children}
    </button>
  );
}

export interface ButtonLinkProps extends Omit<LinkProps, "className"> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly children: ReactNode;
}

/**
 * A router <Link> dressed as a button — for "go to the wizard" / "open the
 * rules" affordances that navigate rather than mutate. It is a real anchor, so
 * middle-click and "open in new tab" work; screens used to fake this with
 * `<Link className="ui-btn">`, which bypassed the variant/size contract.
 */
export function ButtonLink({ variant = "default", size = "md", children, ...rest }: ButtonLinkProps) {
  return (
    <Link {...rest} className={classesFor(variant, size)}>
      {children}
    </Link>
  );
}
