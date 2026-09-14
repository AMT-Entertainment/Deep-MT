import { useEffect, useRef, useState } from 'react';
import { apiUrl, getToken } from '../api';

function fmtAge(ms) {
  if (!ms) return '—';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  return `${Math.round(s / 60)}m ago`;
}
const short = (t) => (t && t.length > 48 ? t.slice(0, 48) + '…' : t || '');

/**
 * SysStrip — live engine/activity strip for the chat screen.
 * Reads /api/health for engine state and /api/log/stream (SSE) for the
 * rolling system console, with auto-reconnect and a live pulse.
 */
export default function SysStrip() {
  const [sys, setSys] = useState(null);
  const [events, setEvents] = useState([]); // newest last, capped
  const [live, setLive] = useState(false);
  const retryRef = useRef(null);
  const ctrlRef = useRef(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;

    async function snapshot() {
      try {
        const res = await fetch(apiUrl('/api/health'), { headers: { Authorization: `Bearer ${getToken()}` } });
        if (!res.ok) return;
        const d = await res.json();
        if (!cancelledRef.current) setSys({ engines: d.engines, imagegen: d.imagegen, models: d.models });
      } catch { /* backend down — the SSE loop will keep showing offline */ }
    }
    snapshot();
    const healthTimer = setInterval(snapshot, 20000);

    async function pump(reader, decoder) {
      let since = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        const chunk = since + decoder.decode(value, { stream: true });
        const parts = chunk.split('\n\n');
        since = parts.pop();
        for (const part of parts) {
          if (!part.trim()) continue;
          const line = part.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          let payload;
          try { payload = JSON.parse(line.slice(6)); } catch { continue; }
          if (payload.event) {
            const ev = payload.event;
            if (ev.kind !== 'http') setEvents((prev) => [...prev.slice(-7), ev]);
          } else if (Array.isArray(payload.events)) {
            setEvents(payload.events.filter((e) => e.kind !== 'http').slice(-8));
          }
        }
      }
    }

    async function connect() {
      if (cancelledRef.current) return;
      const ctrl = new AbortController();
      ctrlRef.current = ctrl;
      try {
        const res = await fetch(apiUrl('/api/log/stream'), {
          headers: { Authorization: `Bearer ${getToken()}` },
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) throw new Error('stream failed');
        setLive(true);
        await pump(res.body.getReader(), new TextDecoder());
      } catch { /* stream error or abort */ }
      setLive(false);
      if (!cancelledRef.current) retryRef.current = setTimeout(connect, 3000);
    }
    connect();

    return () => {
      cancelledRef.current = true;
      clearInterval(healthTimer);
      clearTimeout(retryRef.current);
      try { ctrlRef.current?.abort(); } catch { /* noop */ }
    };
  }, []);

  const engines = sys?.engines || {};
  const img = sys?.imagegen;
  const last = events[events.length - 1];

  const Chip = ({ name, ok, title }) => (
    <span className={`syschip${ok ? ' syschip--ok' : ' syschip--off'}`} title={title}>
      <span className="syschip__dot" />
      {name}
    </span>
  );

  return (
    <div className="sysstrip" role="status" aria-live="polite">
      <span
        className={`sysstrip__live${live ? ' is-live' : ''}`}
        title={live ? 'Receiving the live system console' : 'Reconnecting to the system console…'}
      >
        <span className="sysstrip__pulse" />
        {live ? 'LIVE' : '…'}
      </span>
      <Chip
        name="ollama"
        ok={(engines.ollama || engines['ollama-local']) === 'online'}
        title="Ollama host — local models (Lite/Uranus)"
      />
      <Chip name="turbo" ok={engines.turbofieldfare === 'online'} title="TurboFieldfare — Neptune/Jupiter tiers" />
      <Chip
        name="image"
        ok={img?.imagegen === 'online' && !!img.loaded}
        title="Stable Diffusion image engine (Stable Diffusion)"
      />
      <span className="sysstrip__sep" />
      <span className="sysstrip__event" title={last ? `${last.kind}: ${last.message || ''}` : undefined}>
        {last ? `· ${short(last.message || last.kind)}` : 'idle'}
      </span>
      <span className="sysstrip__age">{last ? fmtAge(last.ms) : ''}</span>
    </div>
  );
}