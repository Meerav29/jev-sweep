const R = 13;
const C = 2 * Math.PI * R;
const COLORS = { archived: '#BDBDBD', filed: '#5D5D5D', kept: '#292929' };

interface Props { archived: number; filed: number; kept: number; total: number }

/** Archived, filed and kept, as segments of the batch. */
export function ProgressRing({ archived, filed, kept, total }: Props) {
  const sorted = archived + filed + kept;
  const denom = Math.max(total, sorted, 1);
  let offset = 0;
  const segs = (['archived', 'filed', 'kept'] as const).map((k) => {
    const v = { archived, filed, kept }[k];
    const frac = v / denom;
    const seg = { k, frac, offset };
    offset += frac;
    return seg;
  });
  return (
    <svg className="ring" viewBox="0 0 34 34" role="img"
      aria-label={`${sorted} of ${total} sorted: ${archived} archived, ${filed} filed, ${kept} kept`}>
      <circle cx="17" cy="17" r={R} stroke="#EDEDED" />
      {segs.map((s) => s.frac > 0 && (
        <circle key={s.k} className="s" cx="17" cy="17" r={R} stroke={COLORS[s.k]} transform="rotate(-90 17 17)"
          style={{ strokeDasharray: `${s.frac * C} ${C}`, strokeDashoffset: -s.offset * C }} />
      ))}
    </svg>
  );
}
