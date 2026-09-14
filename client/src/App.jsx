import { useEffect, useState } from 'react';
import { LanguageProvider } from './i18n';
import Navbar from './components/Navbar';
import Hero from './components/Hero';
import Features from './components/Features';
import Fleet from './components/Fleet';
import Teaser from './components/Teaser';
import AuthModal from './components/AuthModal';
import Chat from './components/Chat';
import { fetchMe, getToken, setToken } from './api';

function getView() {
  const hash = window.location.hash;
  return hash.startsWith('#/chat') ? 'chat' : 'home';
}

export default function App() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [view, setView] = useState(getView());
  const [authOpen, setAuthOpen] = useState(false);
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem('deepmt_theme');
    if (saved) return saved;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('deepmt_theme', theme);
  }, [theme]);

  // Scroll-triggered fade-ins for every .reveal element.
  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            io.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.15 }
    );
    const scan = () => {
      document.querySelectorAll('.reveal:not(.is-visible)').forEach((el) => io.observe(el));
    };
    scan();
    const mo = new MutationObserver(scan);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => {
      io.disconnect();
      mo.disconnect();
    };
  }, []);

  // Ambient cursor glow — a soft light that trails the pointer.
  useEffect(() => {
    const glow = document.createElement('div');
    glow.className = 'cursor-glow';
    document.body.appendChild(glow);
    let raf = 0;
    let x = -200;
    let y = -200;
    let tx = x;
    let ty = y;
    const onMove = (e) => {
      tx = e.clientX;
      ty = e.clientY;
      if (!raf) {
        const step = () => {
          raf = 0;
          x += (tx - x) * 0.18;
          y += (ty - y) * 0.18;
          glow.style.transform = `translate(${x - 140}px, ${y - 140}px)`;
          if (Math.abs(tx - x) > 0.5 || Math.abs(ty - y) > 0.5) raf = requestAnimationFrame(step);
        };
        raf = requestAnimationFrame(step);
      }
    };
    window.addEventListener('mousemove', onMove);
    return () => {
      window.removeEventListener('mousemove', onMove);
      cancelAnimationFrame(raf);
      glow.remove();
    };
  }, []);

  useEffect(() => {
    const onHash = () => setView(getView());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    (async () => {
      if (!getToken()) {
        setAuthLoading(false);
        return;
      }
      try {
        const { user: me } = await fetchMe();
        setUser(me);
        setView('chat');
      } catch {
        setToken(null);
        setUser(null);
      } finally {
        setAuthLoading(false);
      }
    })();
  }, []);

  function handleAuthed(token, authedUser) {
    setToken(token);
    setUser(authedUser);
    setAuthOpen(false);
    setView('chat');
    window.location.hash = '#/chat';
  }

  function handleLogout() {
    setToken(null);
    setUser(null);
    setAuthOpen(false);
    setView('home');
    window.location.hash = '#/';
  }

  if (authLoading) {
    return <div style={{ display: 'flex', height: '100dvh', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>Loading…</div>;
  }

  if (user && view === 'chat') {
    return <Chat user={user} onLogout={handleLogout} />;
  }

  return (
    <LanguageProvider>
      <Navbar
        user={user}
        theme={theme}
        onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        onAuthClick={() => setAuthOpen(true)}
        onLogout={handleLogout}
        onLaunch={() => { setView('chat'); window.location.hash = '#/chat'; }}
      />
      <Hero onAuthClick={() => setAuthOpen(true)} />
      <Fleet />
      <Teaser onSignup={() => setAuthOpen(true)} />
      <Features />
      {authOpen && (
        <AuthModal mode="login" onClose={() => setAuthOpen(false)} onAuthed={handleAuthed} />
      )}
    </LanguageProvider>
  );
}
