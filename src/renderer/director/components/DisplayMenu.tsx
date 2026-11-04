import { Check, ChevronDown, Monitor } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { DisplaySummary } from "../../../shared/types";

type Props = {
  displays: DisplaySummary[];
  displayId: number | null;
  onSelect: (displayId: number | null) => void;
};

export function DisplayMenu({ displays, displayId, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();

  const primary = displays.find((display) => display.primary) ?? displays[0] ?? null;
  const current =
    (displayId !== null ? displays.find((display) => display.id === displayId) ?? null : null) ?? primary;
  const currentId = current?.id ?? null;
  const single = displays.length <= 1;

  const close = useCallback((focusTrigger = false) => {
    setOpen(false);
    if (focusTrigger) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      const index = Math.max(
        0,
        displays.findIndex((display) => display.id === currentId),
      );
      setActiveIndex(index);
      itemRefs.current[index]?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, currentId, displays]);

  const focusItem = (index: number) => {
    if (displays.length === 0) return;
    const next = (index + displays.length) % displays.length;
    setActiveIndex(next);
    itemRefs.current[next]?.focus();
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      focusItem(activeIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusItem(activeIndex - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusItem(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusItem(displays.length - 1);
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  };

  const select = (id: number) => {
    close(true);
    onSelect(id);
  };

  return (
    <div className="display-menu" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="display-trigger"
        title={current ? `显示器：${current.label}` : "显示器"}
        aria-label={current ? `显示器：${current.label}` : "显示器"}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={single}
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          } else if (event.key === "Escape") {
            close();
          }
        }}
      >
        <Monitor size={15} strokeWidth={1.8} aria-hidden="true" />
        <span className="display-label">{current?.label ?? "显示器"}</span>
        <ChevronDown size={13} strokeWidth={1.8} className="display-chevron" aria-hidden="true" />
      </button>

      {open ? (
        <div id={menuId} className="display-popover" role="menu" aria-label="选择显示器" onKeyDown={onMenuKeyDown}>
          {displays.map((display, index) => {
            const selected = display.id === currentId;
            return (
              <button
                key={display.id}
                ref={(node) => {
                  itemRefs.current[index] = node;
                }}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                tabIndex={index === activeIndex ? 0 : -1}
                className={selected ? "display-option is-selected" : "display-option"}
                onClick={() => select(display.id)}
                onMouseEnter={() => setActiveIndex(index)}
              >
                <span className="display-option-main">
                  <span className="display-option-label">{display.label}</span>
                  <span className="display-option-meta mono">
                    {display.width} × {display.height}
                  </span>
                </span>
                {display.primary ? <span className="display-tag">主屏</span> : null}
                <Check
                  size={14}
                  strokeWidth={2}
                  className={selected ? "display-check is-selected" : "display-check"}
                  aria-hidden="true"
                />
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
