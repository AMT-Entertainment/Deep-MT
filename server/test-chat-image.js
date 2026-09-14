const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIyZWQxMmZlOS1jMjBhLTQ2MjctYWQwNS1mZTg0NDNhNDAyNDEiLCJlbWFpbCI6InRlc3R1c2VyQGRlZXBtdC5sb2NhbCIsImlhdCI6MTc4NTk1OTE3MSwiZXhwIjoxNzg2NTYzOTcxfQ.Pp_X-okVpjV2HU_562bmWHH9O7FUs_nJahABzX88hXQ';
const BASE = 'http://localhost:3000';

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  return res;
}

(async () => {
  const created = await (await api('/api/sessions', { method: 'POST', body: '{}' })).json();
  const sid = created.session.id;
  const res = await api('/api/chat/stream', {
    method: 'POST',
    body: JSON.stringify({
      session_id: sid,
      content: 'Generate an image of a lighthouse on a rocky cliff at sunset, photorealistic.',
      model: 'jupiter',
    }),
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const counts = {};
  const tokens = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line.startsWith('event:')) {
        const ev = line.slice(6).trim();
        counts[ev] = (counts[ev] || 0) + 1;
      } else if (line.startsWith('data:')) {
        try {
          const d = JSON.parse(line.slice(5).trim());
          if (d.token) tokens.push(d.token);
          if (d.name) console.log('TOOL CALLED:', d.name, JSON.stringify(d.args));
        } catch {}
      }
    }
  }
  console.log('events:', JSON.stringify(counts));
  console.log('visible inline image link present:', tokens.join('').includes('![Generated image]('));

  const msgs = await (await api(`/api/sessions/${sid}/messages`)).json();
  const ai = msgs.messages.filter((m) => m.role === 'ai').map((m) => m.content);
  console.log('SAVED ai content:\n' + (ai[ai.length - 1] || '').slice(0, 600));
})();