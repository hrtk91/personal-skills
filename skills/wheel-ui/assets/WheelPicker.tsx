import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import "./wheel-picker.css";

type WheelOption = { value: string; label: string; detail?: string };
type Props = { options: WheelOption[]; value: string; onChange: (value: string) => void; label: string };

function nearestIndex(list: HTMLDivElement) {
  const center = list.scrollTop + list.clientHeight / 2;
  const rows = Array.from(list.children) as HTMLElement[];
  return rows.reduce((nearest, row, index) =>
    Math.abs(row.offsetTop + row.offsetHeight / 2 - center) < Math.abs(rows[nearest].offsetTop + rows[nearest].offsetHeight / 2 - center) ? index : nearest, 0);
}

function centerRow(list: HTMLDivElement, index: number, smooth = false) {
  const row = list.children[Math.max(0, Math.min(list.children.length - 1, index))] as HTMLElement;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  list.scrollTo({ top: row.offsetTop - (list.clientHeight - row.offsetHeight) / 2, behavior: smooth && !reducedMotion ? "smooth" : "instant" });
}

export function WheelPicker(props: Props) {
  // 候補なしはlistboxを作らず表示側で扱う。値は一意であること。
  if (!props.options.length) return <p>{props.label}: 選択肢がありません</p>;
  return <PopulatedWheelPicker {...props} />;
}

function PopulatedWheelPicker({ options, value, onChange, label }: Props) {
  const id = useId();
  const viewport = useRef<HTMLDivElement>(null);
  const wheelTarget = useRef<number | null>(null);
  const selection = useRef({ value, onChange });
  const [activeValue, setActiveValue] = useState(value);
  const activeIndex = Math.max(0, options.findIndex(option => option.value === activeValue));
  const valuesKey = JSON.stringify(options.map(option => option.value));

  useLayoutEffect(() => { selection.current = { value, onChange }; }, [value, onChange]);

  useLayoutEffect(() => {
    const list = viewport.current;
    if (!list) return;
    const values = JSON.parse(valuesKey) as string[];
    let settleTimer: ReturnType<typeof setTimeout>;
    let touching = false;
    wheelTarget.current = null;

    function settle() {
      clearTimeout(settleTimer);
      if (touching) return;
      if (wheelTarget.current !== null && Math.abs(list!.scrollTop - wheelTarget.current) > 1) return;
      wheelTarget.current = null;
      const index = nearestIndex(list!);
      const row = list!.children[index] as HTMLElement;
      const distance = Math.abs(row.offsetTop + row.offsetHeight / 2 - list!.scrollTop - list!.clientHeight / 2);
      // 慣性移動中の通過点ではなく、中央へ吸い付いて止まった項目を反映する。
      if (distance > 1) return;
      const settledValue = values[index];
      if (settledValue !== selection.current.value) selection.current.onChange(settledValue);
    }
    function scheduleSettle() {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(settle, 160);
    }
    function scroll() {
      setActiveValue(values[nearestIndex(list!)]);
      if (!("onscrollend" in list!)) scheduleSettle();
    }
    function wheel(event: WheelEvent) {
      // ピンチズーム・横スクロールと、細かな連続入力はブラウザへ任せる。
      const mode = event.deltaMode;
      const delta = event.deltaY;
      const rowHeight = (list!.children[0] as HTMLElement).offsetHeight;
      if (event.ctrlKey || Math.abs(event.deltaX) > Math.abs(delta) || !delta || !event.cancelable) return;
      if (mode === WheelEvent.DOM_DELTA_PIXEL && Math.abs(delta) < rowHeight / 2) {
        wheelTarget.current = null;
        return;
      }
      event.preventDefault();
      // 一度の大きな入力は隣の項目まで。連続入力は捨てずに移動先へ加算する。
      const start = wheelTarget.current ?? nearestIndex(list!) * rowHeight;
      wheelTarget.current = Math.max(0, Math.min((list!.children.length - 1) * rowHeight, start + Math.sign(delta) * rowHeight));
      centerRow(list!, Math.round(wheelTarget.current / rowHeight), true);
      scheduleSettle();
    }
    function interruptWheel() { wheelTarget.current = null; }
    function touchStart() { interruptWheel(); touching = true; }
    function touchEnd() { touching = false; if (!("onscrollend" in list!)) scheduleSettle(); }
    list.addEventListener("scroll", scroll, { passive: true });
    list.addEventListener("scrollend", settle);
    list.addEventListener("wheel", wheel, { passive: false });
    list.addEventListener("pointerdown", interruptWheel);
    list.addEventListener("keydown", interruptWheel);
    list.addEventListener("touchstart", touchStart, { passive: true });
    list.addEventListener("touchend", touchEnd, { passive: true });
    list.addEventListener("touchcancel", touchEnd, { passive: true });
    return () => {
      clearTimeout(settleTimer);
      list.removeEventListener("scroll", scroll);
      list.removeEventListener("scrollend", settle);
      list.removeEventListener("wheel", wheel);
      list.removeEventListener("pointerdown", interruptWheel);
      list.removeEventListener("keydown", interruptWheel);
      list.removeEventListener("touchstart", touchStart);
      list.removeEventListener("touchend", touchEnd);
      list.removeEventListener("touchcancel", touchEnd);
    };
  }, [valuesKey]);

  useLayoutEffect(() => {
    const list = viewport.current;
    if (!list) return;
    const values = JSON.parse(valuesKey) as string[];
    wheelTarget.current = null;
    const index = Math.max(0, values.indexOf(value));
    setActiveValue(values[index]);
    const row = list.children[index] as HTMLElement;
    const target = row.offsetTop - (list.clientHeight - row.offsetHeight) / 2;
    if (Math.abs(list.scrollTop - target) > 1) centerRow(list, index);
  }, [valuesKey, value]);

  function moveTo(index: number, smooth = false) {
    wheelTarget.current = null;
    if (viewport.current) centerRow(viewport.current, index, smooth);
  }
  function moveBy(offset: number) {
    if (viewport.current) moveTo(nearestIndex(viewport.current) + offset);
  }
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowDown") moveBy(1);
    else if (event.key === "ArrowUp") moveBy(-1);
    else if (event.key === "Home") moveTo(0);
    else if (event.key === "End") moveTo(options.length - 1);
    else return;
    event.preventDefault();
  }

  return <>
    <div className="wheel-picker-control">
      <div className="wheel-picker-frame">
        <div className="wheel-picker-band" aria-hidden="true" />
        <div ref={viewport} className="wheel-picker" role="listbox" aria-label={label} aria-describedby={`${id}-hint`} aria-activedescendant={`${id}-${activeIndex}`} tabIndex={0} onKeyDown={handleKeyDown}>
          {options.map((option, index) => <div key={option.value} id={`${id}-${index}`} role="option" aria-selected={index === activeIndex} data-value={option.value}
            className="wheel-picker-option" onClick={() => { viewport.current?.focus({ preventScroll: true }); moveTo(index, true); }}>
            <span className="wheel-picker-option-check" aria-hidden="true">✓</span>
            <span className="wheel-picker-option-label"><span>{option.label}</span>{option.detail && <span className="wheel-picker-option-detail">{option.detail}</span>}</span>
          </div>)}
        </div>
      </div>
      <div className="wheel-picker-arrows">
        <button type="button" aria-label={`${label}: 前の項目`} disabled={activeIndex === 0} onClick={() => moveBy(-1)}><span aria-hidden="true">↑</span></button>
        <button type="button" aria-label={`${label}: 次の項目`} disabled={activeIndex === options.length - 1} onClick={() => moveBy(1)}><span aria-hidden="true">↓</span></button>
      </div>
    </div>
    <p id={`${id}-hint`} className="wheel-picker-hint">スクロール・タップ・↑↓キーで選べます</p>
  </>;
}
