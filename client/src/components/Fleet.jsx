import { useRef } from 'react';
import { useLang } from '../i18n';

function useTilt(max = 10) {
  const card = useRef(null);
  function onMove(e) {
    const el = card.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width - 0.5;
    const y = (e.clientY - rect.top) / rect.height - 0.5;
    el.style.setProperty('--rx', (y * -max).toFixed(2) + 'deg');
    el.style.setProperty('--ry', (x * max).toFixed(2) + 'deg');
    el.style.setProperty('--mx', (x * 100).toFixed(1) + '%');
    el.style.setProperty('--my', (y * 100).toFixed(1) + '%');
  }
  function onLeave() {
    const el = card.current;
    if (!el) return;
    el.style.setProperty('--rx', '0deg');
    el.style.setProperty('--ry', '0deg');
  }
  return { ref: card, onMove, onLeave };
}

function PlanetCard({ cls, ring, tag, name, text, stats, nameKey }) {
  const tilt = useTilt(9);
  return (
    <div className="fleet__card" ref={tilt.ref} onMouseMove={tilt.onMove} onMouseLeave={tilt.onLeave}>
      <div className="fleet__orbit">
        <div className={`planet ${cls}`}>
          {ring && <span className="planet__ring" />}
        </div>
      </div>
      <div className="fleet__tag">{tag}</div>
      <h3>{nameKey}</h3>
      <p>{text}</p>
      <dl className="fleet__stats">
        {stats.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd className="mono">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export default function Fleet() {
  const { t } = useLang();

  return (
    <section className="section" id="fleet">
      <div className="section__label reveal">{t('fleet_label')}</div>
      <h2 className="reveal">{t('fleet_title')}</h2>
      <p className="section__lead reveal">{t('fleet_lead')}</p>
      <div className="fleet__grid">
        <PlanetCard
          cls="planet--lite"
          tag={t('fleet_lite_tag')}
          name={t('fleet_lite_name')}
          nameKey={t('fleet_lite_name')}
          text={t('fleet_lite_text')}
          stats={[
            [t('fleet_lite_stat1'), '∞'],
            [t('fleet_lite_stat2'), t('fleet_lite_stat3')],
          ]}
        />
        <PlanetCard
          cls="planet--neptune"
          ring
          tag={t('fleet_neptune_tag')}
          name={t('fleet_neptune_name')}
          nameKey={t('fleet_neptune_name')}
          text={t('fleet_neptune_text')}
          stats={[
            [t('fleet_neptune_stat1'), '25'],
            [t('fleet_neptune_stat2'), t('fleet_neptune_stat3')],
          ]}
        />
        <PlanetCard
          cls="planet--jupiter"
          ring
          tag={t('fleet_jupiter_tag')}
          name={t('fleet_jupiter_name')}
          nameKey={t('fleet_jupiter_name')}
          text={t('fleet_jupiter_text')}
          stats={[
            [t('fleet_jupiter_stat1'), '10'],
            [t('fleet_jupiter_stat2'), t('fleet_jupiter_stat3')],
          ]}
        />
        <PlanetCard
          cls="planet--uranus"
          ring
          tag={t('fleet_uranus_tag')}
          name={t('fleet_uranus_name')}
          nameKey={t('fleet_uranus_name')}
          text={t('fleet_uranus_text')}
          stats={[
            [t('fleet_uranus_stat1'), '20'],
            [t('fleet_uranus_stat2'), t('fleet_uranus_stat3')],
          ]}
        />
      </div>
      <p className="fleet__hint reveal"><span className="mono">⌖</span> {t('fleet_tilt_hint')} <span className="fleet__hint-sep">·</span> {t('fleet_pick')}</p>
    </section>
  );
}