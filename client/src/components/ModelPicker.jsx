/**
 * Model tier picker. Models are ranked so the flagship (URANUS) leads, then
 * Jupiter, Neptune, Lite. Each row shows the tier name, today's usage, and a
 * short quality/speed hint. Tool-capable tiers get a small "tools" chip.
 */

const RANK = { uranus: 0, jupiter: 1, neptune: 2, lite: 3 };

const HINTS = {
  uranus: { quality: 'best', speed: 'fast', tag: 'new · fast + tools' },
  jupiter: { quality: 'flagship', speed: 'slower', tag: 'flagship · tools' },
  neptune: { quality: 'mid', speed: 'mid', tag: 'mid · no tools' },
  lite: { quality: 'basic', speed: 'fastest', tag: 'fastest · chat only' },
};

export default function ModelPicker({ models, active, onSelect, disabled }) {
  const sorted = [...(models || [])].sort((a, b) => (RANK[a.key] ?? 9) - (RANK[b.key] ?? 9));
  return (
    <div className="chat__models" role="radiogroup" aria-label="Model">
      {sorted.map((m) => {
        const limit = m.rateLimit;
        const atLimit = limit !== null && m.usedToday >= limit;
        const offline = !m.online;
        const locked = atLimit || offline;
        const hint = HINTS[m.key] || {};
        return (
          <button
            key={m.key}
            className={`chat__model${active === m.key ? ' is-active' : ''}${locked ? ' is-locked' : ''}`}
            disabled={disabled || locked}
            onClick={() => onSelect(m.key)}
            role="radio"
            aria-checked={active === m.key}
            title={
              (m.description || m.displayName) +
              (offline
                ? '\n— engine offline'
                : atLimit
                  ? '\n— daily limit reached'
                  : limit
                    ? `\n— ${m.usedToday}/${limit} used today`
                    : '')
            }
          >
            <span className="chat__model-name">
              {m.displayName}
              {hint.tag && <em className="chat__model-hint">{hint.tag}</em>}
            </span>
            <span className="chat__model-usage">
              {limit === null ? '∞' : `${m.usedToday}/${limit}`}
            </span>
          </button>
        );
      })}
    </div>
  );
}
