import { useEffect, useRef, useState } from 'react';
import { apiUrl } from '../api';
import { useLang } from '../i18n';

const DEMO_LINES = [
  { role: 'user', text: 'Summarize our Q3 research notes and draft the Monday update.' },
  {
    role: 'ai',
    text: 'Q3 highlights: routing up 31%, MoE decode steady at 34 tok/s, memory pinned near 2 GB. Drafting the update now — priority items: ship the 64K context build, revisit expert-cache eviction, and schedule the M5 Pro benchmark run.\n\nReply "continue" and I will expand the rollout section.',
  },
  { role: 'user', text: 'What time is it, and can you make a PDF of today’s notes?' },
  { role: 'tool', text: '▶ tool:get_time()  →  2025-08-05T14:32:11Z' },
  { role: 'tool', text: '▶ tool:make_pdf("notes") → /tools-output/notes.pdf (2.1 MB)' },
  {
    role: 'ai',
    text: 'It’s 14:32 UTC. I finished the notes PDF — you can grab it from /tools-output/notes.pdf.',
  },
];

const MODELS = ['uranus', 'jupiter', 'neptune', 'lite'];

export default function Hero({ onAuthClick }) {
  const { t } = useLang();
  const demoRef = useRef(null);
  const heroRef = useRef(null);
  const orbWrap = useRef(null);
  const inputRef = useRef(null);

  // Scripted replay fallback
  const [typed, setTyped] = useState(0);
  const [demoDone, setDemoDone] = useState(false);
  const [replayKey, setReplayKey] = useState(0);
  const [model, setModel] = useState('uranus');
  const started = useRef(false);

  // Live demo chat
  const [msgs, setMsgs] = useState([]); // { role, text }
  const [livePrompt, setLivePrompt] = useState('');
  const [liveBusy, setLiveBusy] = useState(false);
  const [provider, setProvider] = useState(null);
  const [liveErr, setLiveErr] = useState(false);

  // Start the scripted replay once the demo scrolls into view.
  useEffect(() => {
    const el = demoRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !started.current) {
          started.current = true;
          setReplayKey((k) => k + 1);
        }
      },
      { threshold: 0.25 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!replayKey || msgs.length) return;
    let cancelled = false;
    const allText = DEMO_LINES.map((l) => l.text).join('\u0000');
    let i = 0;
    setDemoDone(false);
    setTyped(0);

    const timer = setInterval(() => {
      if (cancelled) return;
      i += 1;
      if (i > allText.length) {
        clearInterval(timer);
        setDemoDone(true);
        return;
      }
      setTyped(i);
    }, 9 + Math.random() * 16);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [replayKey, model, msgs]);

  // Parallax + 3D scene tilt for the orbs (and later the cards).
  useEffect(() => {
    const wrap = orbWrap.current;
    const hero = heroRef.current;
    if (!wrap || !hero) return;
    let raf = 0;
    const onMove = (e) => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const rect = hero.getBoundingClientRect();
        const dx = (e.clientX - rect.left) / rect.width - 0.5;
        const dy = (e.clientY - rect.top) / rect.height - 0.5;
        wrap.style.setProperty('--px', (dx * 46).toFixed(1) + 'px');
        wrap.style.setProperty('--py', (dy * 46).toFixed(1) + 'px');
        wrap.style.setProperty('--rx', (dy * -4).toFixed(2) + 'deg');
        wrap.style.setProperty('--ry', (dx * 5).toFixed(2) + 'deg');
      });
    };
    window.addEventListener('mousemove', onMove);
    return () => {
      window.removeEventListener('mousemove', onMove);
      cancelAnimationFrame(raf);
    };
  }, []);

  function replayRound() {
    setMsgs([]);
    setProvider(null);
    setLiveErr(null);
    setReplayKey((k) => k + 1);
    if (inputRef.current) inputRef.current.focus();
  }

  async function sendLive(e) {
    e && e.preventDefault();
    const p = livePrompt.trim();
    if (!p || liveBusy) return;
    setMsgs((m) => [...m, { role: 'user', text: p }, { role: 'ai', text: '' }]);
    setLivePrompt('');
    setLiveBusy(true);
    setLiveErr(null);

    try {
      const res = await fetch(apiUrl('/api/demo/stream'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: p }),
      });
      if (!res.ok || !res.body) {
        let message = `Live demo failed (${res.status})`;
        try {
          const body = await res.json();
          if (body && body.error) message = body.error;
        } catch {
          /* ignore */
        }
        throw new Error(message);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let currentEvent = 'message';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line.startsWith('event:')) {
            currentEvent = line.slice(6).trim();
            continue;
          }
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          let data;
          try {
            data = JSON.parse(payload);
          } catch {
            continue;
          }
          if (currentEvent === 'meta') {
            setProvider(data.provider);
          } else if (currentEvent === 'token') {
            const tok = data.token || '';
            setMsgs((m) => {
              const next = [...m];
              const ai = next[next.length - 1];
              if (ai && ai.role === 'ai') next[next.length - 1] = { role: 'ai', text: ai.text + tok };
              return next;
            });
          } else if (currentEvent === 'error') {
            throw new Error(data.error || 'Live demo failed');
          }
        }
      }
    } catch (err) {
      setMsgs((m) => [...m.slice(0, -1), { role: 'ai', text: '', error: err.message || 'offline' }]);
      setLiveErr(err.message || 'offline');
    } finally {
      setLiveBusy(false);
    }
  }

  return (
    <header className="hero" ref={heroRef}>
      <div className="hero__orbs" ref={orbWrap}>
        <i className="orb orb--a" />
        <i className="orb orb--b" />
        <i className="orb orb--c" />
      </div>
      <div className="hero__grain" aria-hidden="true" />

      <p className="hero__eyebrow reveal is-visible">{t('hero_eyebrow')}</p>
      <h1 className="reveal is-visible">
        {t('hero_title1')}<br />
        <em>{t('hero_title_em')}</em>
      </h1>
      <p className="hero__sub reveal is-visible">{t('hero_sub')}</p>
      <div className="hero__cta reveal is-visible">
        <button className="btn btn-primary btn-lg" onClick={onAuthClick}>{t('hero_cta')}</button>
        <a className="btn btn-outline btn-lg" href="#features">{t('hero_explore')}</a>
      </div>

      <div className="demo reveal" ref={demoRef}>
        <div className="demo__bar">
          <span className="demo__dots"><span /><span /><span /></span>
          <span className="mono">{msgs.length ? (liveBusy ? 'live …' : 'live') : t('demo_label')}</span>
          {provider && <span className="demo__tier mono">{provider}</span>}
          <div className="demo__models">
            {MODELS.map((m) => (
              <button
                key={m}
                className={`demo__model ${model === m ? 'is-active' : ''} demo__model--${m}`}
                onClick={() => { setModel(m); setReplayKey((k) => k + 1); }}
                title={m}
              >{m[0].toUpperCase()}</button>
            ))}
          </div>
        </div>

        <div className="demo__body">
          {msgs.length ? (
            msgs.map((msg, i) => {
              const isAi = msg.role === 'ai';
              const last = i === msgs.length - 1;
              const streamingThisLine = isAi && last && (liveBusy || (!msg.text && !msg.error));
              return (
                <div className={`demo__msg demo__msg--${msg.error ? 'err' : msg.role}`} key={i}>
                  <div className={`demo__msg-avatar ${msg.error ? 'demo__msg-avatar--err' : isAi ? 'demo__msg-avatar--ai' : 'demo__msg-avatar--user'}`}>
                    {msg.error ? '!' : isAi ? '❁' : '◆'}
                  </div>
                  <div>
                    <div className={`msg__content ${streamingThisLine ? 'typing-indicator' : ''} ${msg.role === 'tool' ? 'mono demo__tool' : ''}`}>
                      {msg.error ? (
                        <span className="demo__err">Engines offline — {msg.error}</span>
                      ) : (
                        msg.text
                      )}
                    </div>
                    {msg.error && i === msgs.length - 1 && (
                      <div className="demo__replay">
                        <button className="mono demo__retry" onClick={replayRound}>↻ {t('demo_replay')}</button>
                        <span> · {t('demo_offline_note')}</span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          ) : (
            <>
              {DEMO_LINES.map((line, idx) => {
                const start = idx === 0 ? 0 : DEMO_LINES.slice(0, idx).reduce((n, l) => n + l.text.length, 0) + idx;
                const progress = Math.max(0, Math.min(typed - start, line.text.length));
                const partial = line.text.slice(0, progress);
                if (idx > 0 && progress === 0 && !demoDone) return null;
                const streamingThisLine = idx === DEMO_LINES.length - 1 && !demoDone;
                return (
                  <div className={`demo__msg demo__msg--${line.role}`} key={idx}>
                    <div className={`demo__msg-avatar ${line.role === 'ai' ? 'demo__msg-avatar--ai' : 'demo__msg-avatar--user'}`}>
                      {line.role === 'ai' ? '❁' : line.role === 'tool' ? '⟶' : '◆'}
                    </div>
                    <div>
                      <div className={`msg__content ${streamingThisLine ? 'typing-indicator' : ''} ${line.role === 'tool' ? 'mono demo__tool' : ''}`}>{partial}</div>
                    </div>
                  </div>
                );
              })}
              {demoDone && (
                <div className="demo__replay">
                  <button className="mono" onClick={replayRound}>↻ {t('demo_replay')}</button>
                </div>
              )}
            </>
          )}
        </div>

        <form className="demo__composer" onSubmit={sendLive}>
          <input
            ref={inputRef}
            className="demo__input"
            value={livePrompt}
            onChange={(e) => setLivePrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendLive(e);
              }
            }}
            placeholder={t('demo_placeholder')}
            disabled={liveBusy}
            maxLength={300}
            aria-label={t('demo_placeholder')}
          />
          <button className="btn btn-primary demo__send" type="submit" disabled={liveBusy || !livePrompt.trim()}>
            {liveBusy ? '…' : '→'}
          </button>
        </form>
      </div>
    </header>
  );
}