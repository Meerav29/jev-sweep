import { useEffect, useRef } from 'react';

/** A number that gives a little bump when it changes (not when it first appears). */
export function Bump({ value, tag = 'b' }: { value: number; tag?: 'b' | 'i' }) {
  const ref = useRef<HTMLElement>(null);
  const prev = useRef(value);
  useEffect(() => {
    const el = ref.current;
    if (!el || prev.current === value) return;
    prev.current = value;
    // Restart the animation: drop the class, force a reflow, add it back.
    el.classList.remove('bump');
    void el.offsetWidth;
    el.classList.add('bump');
  }, [value]);
  return tag === 'i' ? <i ref={ref}>{value}</i> : <b ref={ref}>{value}</b>;
}
