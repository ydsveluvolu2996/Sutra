"use client";

import { useCallback, useRef, type KeyboardEvent, type ReactNode } from "react";
import type { FinopsSheetDescriptor, FinopsSheetInventory } from "./finops-foundational-sheets";
import styles from "./finops-foundational.module.css";

/**
 * Sheet navigation shared by the three Foundational dashboards.
 *
 * The tab set is the pinned official definition, so the shell cannot present a
 * sheet AWS does not publish, nor omit one it does. Each sheet carries its own
 * coverage classification and named gaps from the audit, shown above the
 * content, so a sheet with real but incomplete evidence says so instead of
 * looking finished.
 *
 * Implemented as a real ARIA tablist with roving focus and arrow-key movement:
 * with up to nineteen sheets, tabbing through every one to reach the last is not
 * usable.
 */
export interface FinopsSheetShellProps {
  readonly inventory: FinopsSheetInventory;
  readonly activeKey: string;
  readonly onSelectSheet: (key: string) => void;
  /** Stable prefix for tab/panel ids so several shells can coexist on a page. */
  readonly idPrefix: string;
  readonly toolbar?: ReactNode;
  readonly children: ReactNode;
}

function CoverageDisclosure({ sheet }: { readonly sheet: FinopsSheetDescriptor }) {
  return (
    <section className={styles.coverage} data-support={sheet.support} aria-label={`${sheet.name} coverage`}>
      <div className={styles.coverageHead}>
        <strong>{sheet.name}</strong>
        <span className={styles.coverageBadge} data-support={sheet.support}>
          {sheet.supportLabel.replace(/_/gu, " ")}
        </span>
        <span className={styles.coverageMeta}>
          {sheet.visualCount} official {sheet.visualCount === 1 ? "visual" : "visuals"}
          {" · "}
          {sheet.controlCount} {sheet.controlCount === 1 ? "control" : "controls"}
        </span>
      </div>
      {sheet.gaps.length === 0 ? null : (
        <ul className={styles.coverageGaps}>
          {sheet.gaps.map((gap) => <li key={gap}>{gap}</li>)}
        </ul>
      )}
      {sheet.formulaIds.length === 0 ? null : (
        <ul className={styles.formulaList} aria-label={`${sheet.name} governed formulas`}>
          {sheet.formulaIds.map((id) => <li key={id}>{id}</li>)}
        </ul>
      )}
    </section>
  );
}

export function FinopsSheetShell({
  inventory,
  activeKey,
  onSelectSheet,
  idPrefix,
  toolbar,
  children,
}: FinopsSheetShellProps) {
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const active = inventory.sheets.find((sheet) => sheet.key === activeKey) ?? inventory.sheets[0];

  /**
   * Roving tab movement. Home/End jump to the ends, arrows wrap, and focus
   * follows selection so the newly shown panel is announced.
   */
  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();

    const sheets = inventory.sheets;
    const current = sheets.findIndex((sheet) => sheet.key === activeKey);
    const index = current < 0 ? 0 : current;
    const last = sheets.length - 1;
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? last
        : event.key === "ArrowLeft"
          ? (index === 0 ? last : index - 1)
          : (index === last ? 0 : index + 1);

    const target = sheets[next];
    if (target === undefined) return;
    onSelectSheet(target.key);
    tabsRef.current
      ?.querySelector<HTMLButtonElement>(`#${idPrefix}-tab-${CSS.escape(target.key)}`)
      ?.focus();
  }, [activeKey, idPrefix, inventory.sheets, onSelectSheet]);

  if (active === undefined) return null;

  return (
    <div className={styles.shell}>
      <div className={styles.shellHead}>
        <p className={styles.inventory}>
          <span><b>{inventory.totalSheets}</b> official sheets</span>
          <span><b>{inventory.totalVisuals}</b> visuals</span>
          <span><b>{inventory.totalControls}</b> controls</span>
          <span><b>{inventory.supportedSheets}</b> fully covered, <b>{inventory.partialSheets}</b> partial</span>
          <span className={styles.inventoryPin}>
            pinned {inventory.source.sha256.slice(0, 12)}
            {inventory.source.version === null ? "" : ` · ${inventory.source.version}`}
          </span>
        </p>
      </div>

      <div
        aria-label="Official dashboard sheets"
        className={styles.tabs}
        onKeyDown={onKeyDown}
        ref={tabsRef}
        role="tablist"
      >
        {inventory.sheets.map((sheet) => {
          const selected = sheet.key === active.key;
          return (
            <button
              aria-controls={`${idPrefix}-panel-${sheet.key}`}
              aria-selected={selected}
              className={selected
                ? `${styles.tab} ${styles.tabActive}`
                : sheet.support === "PARTIAL" ? `${styles.tab} ${styles.tabPartial}` : styles.tab}
              id={`${idPrefix}-tab-${sheet.key}`}
              key={sheet.key}
              onClick={() => onSelectSheet(sheet.key)}
              role="tab"
              tabIndex={selected ? 0 : -1}
              type="button"
            >
              {sheet.name}
              <span className={styles.tabCount}>{sheet.visualCount}</span>
            </button>
          );
        })}
      </div>

      <div
        aria-labelledby={`${idPrefix}-tab-${active.key}`}
        className={styles.panel}
        id={`${idPrefix}-panel-${active.key}`}
        role="tabpanel"
        tabIndex={0}
      >
        <CoverageDisclosure sheet={active} />
        {toolbar === undefined ? null : <div className={styles.toolbar}>{toolbar}</div>}
        {children}
      </div>
    </div>
  );
}

/** Titled content block inside a sheet panel. */
export function FinopsSheetBlock({
  title,
  description,
  actions,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className={styles.block} aria-label={title}>
      <header className={styles.blockHead}>
        <div>
          <h4>{title}</h4>
          {description === undefined ? null : <p>{description}</p>}
        </div>
        {actions}
      </header>
      {children}
    </section>
  );
}

export { styles as foundationalStyles };
