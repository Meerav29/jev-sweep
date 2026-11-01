/** True when the person asked their OS for less motion. Safe where matchMedia doesn't exist (tests, old browsers). */
export function reducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Matches the .flyer transition in motion.css, plus a little slack so the chip lands before it goes. */
const FLIGHT_MS = 640;

/**
 * A fixed-position chip that springs from one element to another, then goes away.
 * Resolves at once, without drawing anything, under reduced motion.
 */
export function flyTo(fromEl: Element, toEl: Element, text: string): Promise<void> {
  if (reducedMotion()) return Promise.resolve();
  const from = fromEl.getBoundingClientRect();
  const chip = document.createElement('div');
  chip.className = 'flyer';
  chip.setAttribute('aria-hidden', 'true');
  chip.textContent = text;
  Object.assign(chip.style, { left: `${from.left}px`, top: `${from.top}px`, width: `${Math.max(from.width, 80)}px` });
  document.body.appendChild(chip);
  return new Promise((resolve) => {
    // Two frames: the start position has to be painted before the end one, or there's nothing to transition.
    const go = () => {
      const to = toEl.getBoundingClientRect();
      Object.assign(chip.style, { left: `${to.left + 8}px`, top: `${to.top + 28}px`, width: `${Math.max(to.width - 16, 60)}px` });
    };
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (f: () => void) => setTimeout(f, 16);
    raf(() => raf(go));
    setTimeout(() => { chip.remove(); resolve(); }, FLIGHT_MS);
  });
}
