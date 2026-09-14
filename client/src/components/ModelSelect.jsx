import { useEffect, useRef, useState } from 'react';

/**
 * Compact model selector: a single button showing the active tier that expands
 * a popover (anchored above it) listing every model with its daily usage,
 * capability tag and lock state. Keeps the composer calm — no pill row.
 */

const RANK = { uranus: 0, jupiter: 1, neptune: 2, lite: 3 };

const TAGS = {
  uranus: 'fast + tools',
  jupiter: 'flagship · tools',
  neptune: 'mid · no tools',
  lite: 'fastest · chat only',
};

export default function ModelSelect({ models, active, onSelect, disabled }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const activeModel = (models || []).find((m) => m.key === active);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const sorted = [...(models || [])].sort((a, b) => (RANK[a.key] ?? 9) - (RANK[b.key] ?? 9));

  return (
    <div className="model-select" ref={wrapRef}>
      <button
        type="button"
        className={`model-select__btn${open ? ' is-open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Choose a model"
      >
        <span className="model-select__name">{activeModel?.displayName || active || 'Model'}</span>
        <span className={`model-select__caret${open ? ' is-open' : ''}`} aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className="model-select__menu" role="listbox" aria-label="Models">
          {sorted.map((m) => {
            const limit = m.rateLimit;
            const atLimit = limit !== null && m.usedToday >= limit;
            const offline = !m.online;
            const locked = atLimit || offline;
            return (
              <button
                key={m.key}
                type="button"
                role="option"
                aria-selected={m.key === active}
                className={`model-select__opt${m.key === active ? ' is-active' : ''}${locked ? ' is-locked' : ''}`}
                disabled={locked}
                onClick={() => {
                  onSelect(m.key);
                  setOpen(false);
                }}
              >
                <span className="model-select__opt-head">
                  <span className="model-select__opt-name">{m.displayName}</span>
                  {TAGS[m.key] && <em className="model-select__opt-tag">{TAGS[m.key]}</em>}
                  <span className="model-select__opt-used">
                    {limit === null ? '∞' : `${m.usedToday}/${limit}`}
                  </span>
                  {m.key === active && <span className="model-select__opt-check">✓</span>}
                </span>
                <span className="model-select__opt-desc">
                  {offline ? 'Engine offline' : atLimit ? 'Daily limit reached' : (m.description || '')}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
