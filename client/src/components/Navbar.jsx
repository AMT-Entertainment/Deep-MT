import { useState } from 'react';
import { useLang, LANGUAGES, languageName } from '../i18n';

export default function Navbar({ user, theme, onToggleTheme, onAuthClick, onLogout, onLaunch }) {
  const { t, lang, setLang } = useLang();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  // Close mobile drawer on hash nav
  const closeMobile = () => setMobileOpen(false);

  return (
    <nav className="nav">
      <a className="nav__brand" href="#/" onClick={closeMobile}>
        <img className="nav__logo" src="/assets/favicon-sm.png" alt="DeepMT" />
        DeepMT
      </a>

      {/* Desktop links */}
      <div className="nav__links nav__links--desktop">
        <a className="nav__link" href="#features">{t('nav_platform')}</a>
        <a className="nav__link" href="#privacy">{t('nav_privacy')}</a>

        <select
          className="lang-switch"
          value={lang}
          onChange={(e) => setLang(e.target.value)}
          aria-label="Language / Sprache / Język"
        >
          {LANGUAGES.map((code) => (
            <option key={code} value={code}>{languageName(code)}</option>
          ))}
        </select>

        <button
          className="theme-toggle"
          onClick={onToggleTheme}
          aria-label="Toggle theme"
          title={theme === 'dark' ? t('nav_theme_light') : t('nav_theme_dark')}
        >
          {theme === 'dark' ? '☀' : '☾'}
        </button>

        {user ? (
          <>
            <span className="nav__user">{user.username || user.email}</span>
            <button className="btn btn-primary" onClick={onLaunch}>{t('nav_openChat')}</button>
            <button className="btn btn-ghost" onClick={() => setConfirmOpen(true)}>{t('nav_logout')}</button>
          </>
        ) : (
          <>
            <button className="btn btn-outline" onClick={onAuthClick}>{t('nav_login')}</button>
            <button className="btn btn-primary" onClick={onAuthClick}>{t('nav_getStarted')}</button>
          </>
        )}
      </div>

      {/* Hamburger for mobile */}
      <button
        className={`nav__hamburger${mobileOpen ? ' is-open' : ''}`}
        onClick={() => setMobileOpen((v) => !v)}
        aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
        aria-expanded={mobileOpen}
      >
        <span /><span /><span />
      </button>

      {/* Mobile drawer */}
      <div className={`nav__mobile${mobileOpen ? ' is-open' : ''}`} role="dialog" aria-modal="true">
        <a className="nav__link" href="#features" onClick={closeMobile}>{t('nav_platform')}</a>
        <a className="nav__link" href="#privacy" onClick={closeMobile}>{t('nav_privacy')}</a>
        <select
          className="lang-switch"
          value={lang}
          onChange={(e) => setLang(e.target.value)}
          aria-label="Language / Sprache / Język"
        >
          {LANGUAGES.map((code) => (
            <option key={code} value={code}>{languageName(code)}</option>
          ))}
        </select>
        <button className="theme-toggle" style={{ width: '100%', justifyContent: 'center', border: '1px solid var(--border)', borderRadius: '10px', padding: '10px' }} onClick={onToggleTheme}>
          {theme === 'dark' ? '☀ ' + t('nav_theme_light') : '☾ ' + t('nav_theme_dark')}
        </button>
        <div className="nav__mobile-actions">
          {user ? (
            <>
              <div style={{ fontSize: '0.9rem', color: 'var(--text-muted)', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis' }}>{user.username || user.email}</div>
              <button className="btn btn-primary" onClick={() => { closeMobile(); onLaunch(); }}>{t('nav_openChat')}</button>
              <button className="btn btn-outline" onClick={() => setConfirmOpen(true)}>{t('nav_logout')}</button>
            </>
          ) : (
            <>
              <button className="btn btn-outline" onClick={() => { closeMobile(); onAuthClick(); }}>{t('nav_login')}</button>
              <button className="btn btn-primary" onClick={() => { closeMobile(); onAuthClick(); }}>{t('nav_getStarted')}</button>
            </>
          )}
        </div>
      </div>

      {confirmOpen && (
        <div className="auth-overlay" onClick={() => setConfirmOpen(false)}>
          <div className="auth-modal" style={{ padding: 28, maxWidth: 340 }} onClick={(e) => e.stopPropagation()}>
            <h2 style={{ fontSize: '1.3rem', marginBottom: 10 }}>{t('logout_title')}</h2>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.92rem', marginBottom: 20 }}>
              {t('logout_body')}
            </p>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-outline" style={{ flex: 1 }} onClick={() => setConfirmOpen(false)}>{t('logout_cancel')}</button>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={onLogout}>{t('logout_confirm')}</button>
            </div>
          </div>
        </div>
      )}
    </nav>
  );
}
