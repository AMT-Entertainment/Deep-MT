import { useLang } from '../i18n';

export default function Teaser({ onSignup }) {
  const { t } = useLang();
  return (
    <section className="section" id="desktop">
      <div className="desktop-teaser reveal">
        <div className="desktop-teaser__left">
          <span className="desktop-teaser__badge">{t('dt_badge')}</span>
          <h2>{t('dt_title')}</h2>
          <p className="desktop-teaser__text">{t('dt_text')}</p>
          <ul className="desktop-teaser__list">
            <li>[MT]</li>
            <li>TAKE OVER</li>
            <li>100% local</li>
          </ul>
        </div>
        <div className="desktop-teaser__right">
          <div className="desktop-teaser__mock" aria-hidden="true">
            <div className="mock__bar">
              <span className="mock__dot" />
              <span className="mock__dot" />
              <span className="mock__dot" />
              <span className="mock__window">DeepMT Desktop</span>
            </div>
            <div className="mock__body">
              <div className="mock__tab mock__tab--active">Chat</div>
              <div className="mock__tab">[MT] Host Agent</div>
              <div className="mock__tab">TAKE OVER</div>
              <div className="mock__bubble mock__bubble--user">open Calculator and add 7 + 9</div>
              <div className="mock__bubble mock__bubble--ai">I&apos;ll take it from here — one moment…</div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}