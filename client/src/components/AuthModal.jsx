import { useEffect, useRef, useState } from 'react';
import { useLang } from '../i18n';
import { ApiError, register, login } from '../api';

export default function AuthModal({ mode, onClose, onAuthed }) {
  const { t } = useLang();
  const [formMode, setFormMode] = useState(mode);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const nameRef = useRef(null);

  useEffect(() => {
    setFormMode(mode);
    setError('');
    nameRef.current?.focus();
  }, [mode]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { token, user } = formMode === 'login'
        ? await login(username.trim(), password)
        : await register(username.trim(), password);
      onAuthed(token, user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="auth-modal" role="dialog" aria-modal="true">
        <button className="auth-modal__close" onClick={onClose} aria-label="Close">✕</button>
        <h2>{formMode === 'login' ? t('auth_login_title') : t('auth_register_title')}</h2>
        <p className="auth-modal__sub">
          {formMode === 'login' ? t('auth_login_sub') : t('auth_register_sub')}
        </p>

        {error && <div className="auth-modal__error">{error}</div>}

        <form onSubmit={handleSubmit} noValidate>
          <div className="field">
            <label htmlFor="auth-username">{formMode === 'login' ? t('auth_username_label') : t('auth_register_username_label')}</label>
            <input
              id="auth-username"
              ref={nameRef}
              type="text"
              autoComplete="username"
              placeholder={formMode === 'login' ? t('auth_username_placeholder_login') : t('auth_username_placeholder_register')}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="auth-password">{t('auth_password')}</label>
            <input
              id="auth-password"
              type="password"
              autoComplete={formMode === 'login' ? 'current-password' : 'new-password'}
              placeholder={formMode === 'login' ? t('auth_pwd_placeholder_login') : t('auth_pwd_placeholder_register')}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
            />
          </div>
          <button className="btn btn-primary auth-modal__submit" type="submit" disabled={busy}>
            {busy ? t('auth_please_wait') : formMode === 'login' ? t('auth_login_btn') : t('auth_register_btn')}
          </button>
        </form>

        <p className="auth-modal__switch">
          {formMode === 'login' ? t('auth_new_here') : t('auth_have_account')}
          <button type="button" onClick={() => { setFormMode(formMode === 'login' ? 'register' : 'login'); setError(''); }}>
            {formMode === 'login' ? t('auth_switch_register') : t('auth_switch_login')}
          </button>
        </p>
      </div>
    </div>
  );
}