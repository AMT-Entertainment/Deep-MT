import { useCallback, useEffect, useState } from 'react';
import { listApiKeys, createApiKey, revokeApiKey, getApiBase } from '../api';

const Icon = ({ name, className }) => (
  <span className={`material-symbols-outlined${className ? ' ' + className : ''}`} aria-hidden="true">{name}</span>
);

function Example({ plain, base }) {
  const curl = `curl ${base}/v1/chat/completions \\
  -H "Authorization: Bearer ${plain}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "uranus",
    "messages": [{ "role": "user", "content": "Hello DeepMT" }],
    "stream": true
  }'`;

  const node = `const res = await fetch("${base}/v1/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": "Bearer ${plain}",
  },
  body: JSON.stringify({
    model: "uranus",
    messages: [{ role: "user", content: "Hello DeepMT" }],
    stream: true,
  }),
});
for await (const chunk of res.body) {
  process.stdout.write(new TextDecoder().decode(chunk));
}`;

  const [tab, setTab] = useState('curl');

  return (
    <div className="apikeys__example">
      <div className="apikeys__example-tabs">
        <button className={`apikeys__example-tab${tab === 'curl' ? ' is-active' : ''}`} onClick={() => setTab('curl')}>curl</button>
        <button className={`apikeys__example-tab${tab === 'node' ? ' is-active' : ''}`} onClick={() => setTab('node')}>Node fetch</button>
      </div>
      <pre className="apikeys__example-code">{tab === 'curl' ? curl : node}</pre>
    </div>
  );
}

export default function ApiKeys({ onClose }) {
  const [keys, setKeys] = useState(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [fresh, setFresh] = useState(null); // { key, name } — plaintext, shown once
  const [copied, setCopied] = useState(false);
  const base = getApiBase() || window.location.origin;

  const load = useCallback(async () => {
    try {
      setKeys((await listApiKeys()).keys);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function onCreate(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createApiKey(name);
      setFresh({ key: created.key, name: created.name });
      setName('');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  async function onRevoke(id) {
    if (!window.confirm('Revoke this API key? Programs using it will lose access immediately.')) return;
    setError(null);
    try {
      await revokeApiKey(id);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="edit-modal apikeys-modal" role="dialog" aria-modal="true" aria-label="API keys">
      <div className="edit-modal__card apikeys-card">
        <div className="edit-modal__head">
          <Icon name="key" />
          <span>API keys</span>
          <button className="edit-modal__close" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
        </div>

        <div className="apikeys-body">
          <p className="apikeys__intro">
            Generate a key to call DeepMT from your own projects through the OpenAI-compatible
            <code> /v1</code> endpoint — the full tool pipeline runs on the server, and each key
            inherits your account's model limits.
          </p>

          <form className="apikeys__create" onSubmit={onCreate}>
            <input
              className="apikeys__name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name this key (e.g. my-bot)"
              maxLength={60}
            />
            <button className="btn btn-primary" disabled={busy} type="submit">
              {busy ? 'Creating…' : 'Generate key'}
            </button>
          </form>

          {error && <div className="apikeys__err">{error}</div>}

          {fresh && (
            <div className="apikeys__fresh">
              <div className="apikeys__fresh-lbl">
                <Icon name="warning" /> Your new key — copy it now, it is shown only once
              </div>
              <div className="apikeys__fresh-row">
                <code className="apikeys__fresh-key">{fresh.key}</code>
                <button className="btn" onClick={() => copy(fresh.key)}>{copied ? 'Copied' : 'Copy'}</button>
              </div>
              <Example plain={fresh.key} base={base} />
            </div>
          )}

          <div className="apikeys__list">
            {!keys ? (
              <div className="lib-loading">Loading…</div>
            ) : keys.length === 0 ? (
              <div className="apikeys__empty">No keys yet — generate one above.</div>
            ) : (
              keys.map((k) => (
                <div className={`apikeys__row${k.revoked ? ' is-revoked' : ''}`} key={k.id}>
                  <div className="apikeys__row-info">
                    <span className="apikeys__row-name">{k.name}</span>
                    <span className="apikeys__row-meta">
                      {k.revoked ? 'revoked · ' : ''}created {k.created_at} · {k.last_used_at ? `last used ${k.last_used_at}` : 'never used'}
                    </span>
                  </div>
                  <button className="btn btn-ghost" onClick={() => onRevoke(k.id)} disabled={!!k.revoked}>
                    {k.revoked ? 'Revoked' : 'Revoke'}
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}