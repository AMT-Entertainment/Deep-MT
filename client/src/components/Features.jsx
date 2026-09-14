import { useRef } from 'react';
import { useLang } from '../i18n';

function useTilt(max = 7) {
  const card = useRef(null);
  function onMove(e) {
    const el = card.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width - 0.5;
    const y = (e.clientY - rect.top) / rect.height - 0.5;
    el.style.setProperty('--rx', (y * -max).toFixed(2) + 'deg');
    el.style.setProperty('--ry', (x * max).toFixed(2) + 'deg');
  }
  function onLeave() {
    const el = card.current;
    if (!el) return;
    el.style.setProperty('--rx', '0deg');
    el.style.setProperty('--ry', '0deg');
  }
  return { ref: card, onMove, onLeave };
}

function Icon({ name }) {
  return <span className="material-symbols-outlined" aria-hidden="true">{name}</span>;
}

function TiltCard({ className, children }) {
  const tilt = useTilt(7);
  return (
    <div className={`tilt ${className || ''}`} ref={tilt.ref} onMouseMove={tilt.onMove} onMouseLeave={tilt.onLeave}>
      {children}
    </div>
  );
}

function StatsBand() {
  const { t } = useLang();
  const stats = [
    [t('stat1_value'), t('stat1_label')],
    [t('stat2_value'), t('stat2_label')],
    [t('stat3_value'), t('stat3_label')],
    [t('stat4_value'), t('stat4_label')],
  ];
  return (
    <div className="stats-band reveal">
      {stats.map(([value, label]) => (
        <div className="stats-band__item" key={label}>
          <div className="stats-band__value mono">{value}</div>
          <div className="stats-band__label">{label}</div>
        </div>
      ))}
    </div>
  );
}

export default function Features() {
  const { t } = useLang();

  const features = [
    { icon: 'memory', title: t('feat1_title'), text: t('feat1_text') },
    { icon: 'bolt', title: t('feat2_title'), text: t('feat2_text') },
    { icon: 'verified_user', title: t('feat3_title'), text: t('feat3_text') },
    { icon: 'forum', title: t('feat4_title'), text: t('feat4_text') },
  ];

  const arch = [
    { icon: 'key', num: '01', title: t('arch1_title'), text: t('arch1_text') },
    { icon: 'hub', num: '02', title: t('arch2_title'), text: t('arch2_text') },
    { icon: 'wifi_tethering', num: '03', title: t('arch3_title'), text: t('arch3_text') },
  ];

  return (
    <>
      <StatsBand />

      <section className="section" id="features">
        <div className="section__label reveal">{t('feat_label')}</div>
        <h2 className="reveal">{t('feat_title')}</h2>
        <p className="section__lead reveal">{t('feat_lead')}</p>
        <div className="feature-grid">
          {features.map((f) => (
            <TiltCard className="feature" key={f.title}>
              <div className="feature__icon"><Icon name={f.icon} /></div>
              <h3>{f.title}</h3>
              <p>{f.text}</p>
            </TiltCard>
          ))}
        </div>
      </section>

      <section className="section" id="privacy">
        <div className="section__label reveal">{t('arch_label')}</div>
        <h2 className="reveal">{t('arch_title')}</h2>
        <p className="section__lead reveal">{t('arch_lead')}</p>
        <div className="arch-flow">
          {arch.map((step, i) => (
            <div className="arch-flow__step" key={step.num}>
              {i > 0 && <div className="arch-flow__connector" />}
              <TiltCard className="arch-flow__node">
                <div className="arch-flow__icon"><Icon name={step.icon} /></div>
                <div className="arch-flow__num mono">{step.num}</div>
                <h3>{step.title}</h3>
                <p>{step.text}</p>
              </TiltCard>
            </div>
          ))}
        </div>
      </section>

      <footer className="footer">
        <div className="footer__brand">
          <img className="footer__logo" src="/assets/favicon-sm.png" alt="" />
          DeepMT
        </div>
        <div>{t('footer_parent')}</div>
      </footer>
    </>
  );
}