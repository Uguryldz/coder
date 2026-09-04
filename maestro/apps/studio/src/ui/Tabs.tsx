import type { KeyboardEvent, ReactNode } from "react";
import "./Tabs.css";

export interface TabItem {
  readonly id: string;
  /** Already-translated tab label. */
  readonly label: string;
  readonly count?: number;
}

export interface TabsProps {
  readonly items: readonly TabItem[];
  readonly active: string;
  readonly onChange: (id: string) => void;
  /** Already-translated accessible name for the tab strip. */
  readonly label: string;
}

/**
 * Mirrors `.tabs` / `.tab` from the mock. Controlled: the screen owns which tab
 * is active, so it can put that in the URL if it wants deep links.
 */
export function Tabs({ items, active, onChange, label }: TabsProps): ReactNode {
  // WAI-ARIA tabs: one tab stop for the strip (roving tabindex), arrows move
  // between tabs, Home/End jump to the ends. Selection follows focus, which is
  // the pattern for tabs whose panels render instantly.
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const index = items.findIndex((item) => item.id === active);
    if (index === -1 || items.length === 0) return;
    let next: number | null = null;
    if (event.key === "ArrowRight") next = (index + 1) % items.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    if (next === null) return;
    event.preventDefault();
    const target = items[next];
    if (target === undefined) return;
    onChange(target.id);
    const strip = event.currentTarget.parentElement;
    const button = strip?.querySelector<HTMLButtonElement>(`#tab-${CSS.escape(target.id)}`);
    button?.focus();
  };

  return (
    <div className="ui-tabs" role="tablist" aria-label={label}>
      {items.map((item) => {
        const selected = item.id === active;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`tab-${item.id}`}
            aria-selected={selected}
            aria-controls={`panel-${item.id}`}
            tabIndex={selected ? 0 : -1}
            className={selected ? "ui-tab ui-tab--active" : "ui-tab"}
            onClick={() => onChange(item.id)}
            onKeyDown={onKeyDown}
          >
            {item.label}
            {item.count !== undefined && <span className="ui-tab__cnt">{item.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

export interface TabPanelProps {
  readonly id: string;
  readonly active: string;
  readonly children: ReactNode;
}

/** Pairs with <Tabs>; renders nothing unless its id is the active one. */
export function TabPanel({ id, active, children }: TabPanelProps): ReactNode {
  if (id !== active) return null;
  return (
    <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`}>
      {children}
    </div>
  );
}
