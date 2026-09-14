import { useCallback, useEffect, useRef, useState } from 'react';
import {
  listSessions, createSession, deleteSession, renameSession, pinSession, listMessages, listModels, streamChat,
  fetchLibrary, createVariation, exportSession, fetchTokens,
  listArchives, shareArchive, unshareArchive, getApiBase, resolveFileUrl,
} from '../api';
import ModelSelect from './ModelSelect';
import Markdown from './Markdown';
import LiveText from './LiveText';
import ApiKeys from './ApiKeys';
import SysStrip from './SysStrip';

const SUGGESTIONS = [
  'Draft a weekly engineering update',
  'Explain MoE expert routing like I’m new to ML',
  'Plan a private deployment for 3 users on a Mac Mini',
  'Generate an image of a lighthouse at sunset',
];

const Icon = ({ name, className }) => (
  <span className={`material-symbols-outlined${className ? ' ' + className : ''}`} aria-hidden="true">{name}</span>
);

const fmt = (n) => Number(n || 0).toLocaleString();

export default function Chat({ user, onLogout }) {
  const [sessions, setSessions] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [streaming, setStreaming] = useState(null); // null | 'connecting' | 'thinking' | 'receiving'
  const [streamText, setStreamText] = useState('');
  const [activeTool, setActiveTool] = useState(null);
  const [toolLog, setToolLog] = useState([]); // { id, name, args, status, content }
  const [expandedTool, setExpandedTool] = useState(null);
  const [models, setModels] = useState([]);
  const [modelKey, setModelKey] = useState('lite');
  const [draft, setDraft] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth > 900 && localStorage.getItem('deepmt_sidebar') !== '0';
  });
  const [notice, setNotice] = useState(null);
  const [imgOpen, setImgOpen] = useState(false);
  const [imgPrompt, setImgPrompt] = useState('');
  const [editTarget, setEditTarget] = useState(null); // /tools-output URL of the image being edited
  const [editDraft, setEditDraft] = useState('');
  const [attachments, setAttachments] = useState([]); // pending {id, name, mime, dataUrl} to send
  const [camOpen, setCamOpen] = useState(false);
  const [camError, setCamError] = useState(null);
  const [archiveUrl, setArchiveUrl] = useState(null); // latest make_site URL for the Archives panel
  const [archiveWriting, setArchiveWriting] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archives, setArchives] = useState(null); // { sites, shared } from /api/archives
  const [archivesBusy, setArchivesBusy] = useState(false);
  const [shareSlug, setShareSlug] = useState('');
  const [shareBusy, setShareBusy] = useState(false);
  const [shareMsg, setShareMsg] = useState(null); // { kind: 'ok' | 'err', text }
  const [shareCopied, setShareCopied] = useState(false);
  const [stats, setStats] = useState(null); // live { seconds, tokens } while the engine works
  const [lastStats, setLastStats] = useState(null); // { seconds, tokens } of the finished reply
  const [tokenStats, setTokenStats] = useState(null); // { user: {...}, global: {...} }
  const [searchQ, setSearchQ] = useState('');
  const [renamingId, setRenamingId] = useState(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [libOpen, setLibOpen] = useState(false);
  const [library, setLibrary] = useState(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportLink, setExportLink] = useState(null);
  const [keysOpen, setKeysOpen] = useState(false);
  const [varySrc, setVarySrc] = useState(null);
  const [varyState, setVaryState] = useState(null);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [draftPreview, setDraftPreview] = useState(false);
  const [dragHover, setDragHover] = useState(false);
  const [copiedId, setCopiedId] = useState(null); // msg id just copied
  const [scrolledUp, setScrolledUp] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const noticeTimerRef = useRef(null);
  const statsTimerRef = useRef(null);
  const statsStartedAtRef = useRef(0);
  const lastTokensRef = useRef(0);
  const abortRef = useRef(null);
  const threadRef = useRef(null);
  const inputRef = useRef(null);
  const imgInputRef = useRef(null);
  const editInputRef = useRef(null);
  const fileInputRef = useRef(null);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const streamStartedRef = useRef(false);
  const streamingRef = useRef(false);
  const activeIdRef = useRef(null);
  const streamSessionRef = useRef(null);
  const autoScrollRef = useRef(true);
  const toolSeqRef = useRef(0);
  const rewindRef = useRef(null); // { sessionId, messageId } — user editing a past turn
  const draftTimerRef = useRef(null);
  const pendingTokensRef = useRef('');
  const flushRafRef = useRef(0);

  const scrollToBottom = useCallback((force = false) => {
    const el = threadRef.current;
    if (!el) return;
    if (force || autoScrollRef.current) {
      el.scrollTop = el.scrollHeight;
    }
    if (force) setScrolledUp(false);
  }, []);

  /** Keep autoscroll ON while the user is at the bottom; show a "↓" chip otherwise. */
  const onThreadScroll = useCallback(() => {
    const el = threadRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
    autoScrollRef.current = atBottom;
    setScrolledUp(!atBottom);
  }, []);

  async function copyMessage(m) {
    try {
      await navigator.clipboard.writeText(m.content);
      setCopiedId(m.id);
      setTimeout(() => setCopiedId((cur) => (cur === m.id ? null : cur)), 1600);
    } catch { /* clipboard blocked */ }
  }

  async function refreshTokens() {
    try {
      const d = await fetchTokens();
      setTokenStats(d);
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    (async () => {
      try {
        const [s, modelData] = await Promise.all([
          listSessions(),
          listModels().catch(() => ({ models: [] })),
          refreshTokens(),
        ]);
        setSessions(s.sessions);
        setModels(modelData.models || []);
        const available = (modelData.models || []).filter((m) => m.online && (m.rateLimit === null || m.usedToday < m.rateLimit));
        const preferred = available.find((m) => m.key === 'uranus' || m.key === 'jupiter') || available[0];
        if (preferred) setModelKey(preferred.key);
        if (s.sessions.length > 0) {
          setActiveId((prev) => prev || s.sessions[0].id);
        }
      } catch {
        /* token invalid — handled by App */
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    activeIdRef.current = activeId;
    setExportLink(null);
    (async () => {
      try {
        const { messages: msgs } = await listMessages(activeId);
        if (!cancelled && !streamingRef.current) setMessages(msgs);
      } catch {
        if (!cancelled && !streamingRef.current) setMessages([]);
      }
    })();
    return () => { cancelled = true; };
  }, [activeId]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, streamText, streaming, toolLog, expandedTool, scrollToBottom]);

  useEffect(() => {
    const onWheel = () => {
      const el = threadRef.current;
      if (!el) return;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      autoScrollRef.current = atBottom;
    };
    const el = threadRef.current;
    el?.addEventListener('wheel', onWheel);
    return () => el?.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    const onClick = (e) => {
      const btn = e.target.closest('[data-md-edit], [data-md-vary]');
      if (!btn) return;
      const url = btn.getAttribute('data-md-edit') || btn.getAttribute('data-md-vary');
      if (btn.hasAttribute('data-md-vary')) {
        runVariation(url);
        return;
      }
      setEditTarget(url);
      setEditDraft('');
      setTimeout(() => editInputRef.current?.focus(), 60);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setEditTarget(null);
    };
    el.addEventListener('click', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      el.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  // Drag & drop files onto the conversation.
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    let depth = 0;
    const hasFiles = (e) => (e.dataTransfer?.types || []).includes('Files');
    const depthClass = (d) => el.classList.toggle('is-dragover', d > 0);
    const onDragEnter = (e) => { if (hasFiles(e)) { depth++; depthClass(depth); } };
    const onDragLeave = () => { depth = Math.max(0, depth - 1); depthClass(depth); };
    const onDragOver = (e) => { if (hasFiles(e)) e.preventDefault(); };
    const onDrop = (e) => {
      const files = e.dataTransfer?.files;
      if (files?.length) {
        e.preventDefault();
        addFiles(files);
        el.classList.remove('is-dragover');
        inputRef.current?.focus();
      }
      depth = 0;
    };
    el.addEventListener('dragenter', onDragEnter);
    el.addEventListener('dragleave', onDragLeave);
    el.addEventListener('dragover', onDragOver);
    el.addEventListener('drop', onDrop);
    return () => {
      el.removeEventListener('dragenter', onDragEnter);
      el.removeEventListener('dragleave', onDragLeave);
      el.removeEventListener('dragover', onDragOver);
      el.removeEventListener('drop', onDrop);
    };
  }, [addFiles]);

  useEffect(() => {
    localStorage.setItem('deepmt_sidebar', sidebarOpen ? '1' : '0');
  }, [sidebarOpen]);

  // Draft autosave: keep each session's unfinished message across reloads and
  // session switches (keyed by session id; drafts without a session are dropped).
  useEffect(() => {
    if (!activeId) return;
    clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(() => {
      try {
        if (draft) localStorage.setItem(`deepmt_draft_${activeId}`, draft);
        else localStorage.removeItem(`deepmt_draft_${activeId}`);
      } catch { /* storage full/blocked */ }
    }, 250);
    return () => clearTimeout(draftTimerRef.current);
  }, [draft, activeId]);

  useEffect(() => {
    if (!activeId) return;
    try {
      const saved = localStorage.getItem(`deepmt_draft_${activeId}`);
      if (saved) setDraft(saved);
    } catch { /* ignore */ }
  }, [activeId]);

  const authedUrl = (u) => {
    const t = typeof window !== 'undefined' ? localStorage.getItem('deepmt_token') || '' : '';
    if (!u) return u;
    // Absolutize backend files to the tunnel URL in GitHub Pages mode.
    let out = u.startsWith('/tools-output/') ? resolveFileUrl(u) : u;
    if (!t || !u.startsWith('/tools-output/')) return out;
    return out + (out.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(t);
  };

  const backendOrigin = () => getApiBase() || (typeof window !== 'undefined' ? window.location.origin : '');

  const toast = (msg) => {
    setNotice(msg);
    clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setNotice(null), 6000);
  };

  /* ---- sidebar search ---- */
  const searchTimerRef = useRef(null);
  const handleSearch = (q) => {
    setSearchQ(q);
    clearTimeout(searchTimerRef.current);
    if (!q.trim()) {
      listSessions().then((r) => setSessions(r.sessions)).catch(() => {});
      return;
    }
    searchTimerRef.current = setTimeout(async () => {
      try {
        const r = await listSessions(q.trim());
        setSessions(r.sessions);
      } catch { /* ignore */ }
    }, 250);
  };

  /* ---- inline rename ---- */
  const startRename = (id, title) => {
    setRenamingId(id);
    setRenameDraft(title || '');
  };
  const commitRename = async (id) => {
    const title = renameDraft.trim();
    setRenamingId(null);
    if (!title || !id) return;
    try {
      await renameSession(id, title);
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title } : s)));
    } catch (err) {
      toast(err.message || 'Rename failed');
    }
  };

  /* ---- pin ---- */
  const togglePin = async (id) => {
    const s = sessions.find((x) => x.id === id);
    const pinned = !s?.pinned;
    setSessions((prev) => prev.map((x) => (x.id === id ? { ...x, pinned: pinned ? 1 : 0 } : x)));
    try {
      await pinSession(id, pinned);
      const { sessions: fresh } = await listSessions();
      setSessions(fresh);
    } catch (err) {
      setSessions((prev) => prev.map((x) => (x.id === id ? { ...x, pinned: s?.pinned || 0 } : x)));
      toast(err.message || 'Pin failed');
    }
  };

  /* ---- edit & re-ask (rewind) ---- */
  const startRewind = (messageId) => {
    if (streamingRef.current) return;
    const m = messages.find((x) => x.id === messageId);
    if (!m) return;
    rewindRef.current = { sessionId: activeId, messageId };
    setDraft(m.content);
    inputRef.current?.focus();
    toast('Editing that message — it will replace the original when you send.');
  };
  const cancelRewind = () => {
    rewindRef.current = null;
    setDraft('');
  };

  /* ---- gallery ---- */
  const openLibrary = async () => {
    setLibOpen(true);
    setLibrary(null);
    try {
      const lib = await fetchLibrary();
      setLibrary(lib);
    } catch (err) {
      setLibrary({ error: err.message });
    }
  };
  const insertIntoDraft = (md) => {
    setDraft((prev) => (prev ? `${prev.trimEnd()}\n\n${md}` : md));
    inputRef.current?.focus();
  };

  /* ---- export ---- */
  const doExport = async (format) => {
    setExportOpen(false);
    setExportBusy(true);
    try {
      const r = await exportSession(activeId, format);
      setExportLink(r);
      toast(`Exported as ${format.toUpperCase()} — ${r.name}`);
    } catch (err) {
      toast(err.message || 'Export failed');
    } finally {
      setExportBusy(false);
    }
  };

  /* ---- image variation ---- */
  const runVariation = async (url) => {
    setVarySrc(url);
    setVaryState('busy');
    try {
      const r = await createVariation(url);
      setVaryState({ url: r.url, file: r.file, error: null });
    } catch (err) {
      setVaryState({ url: null, error: err.message || 'Variation failed' });
    }
  };

  function submitEdit() {
    const draft = editDraft.trim();
    if (!draft || !editTarget || streaming) return;
    const target = editTarget;
    setEditTarget(null);
    setEditDraft('');
    send(`Edit this image: ${draft}\nImage to edit: ${target}`, 'jupiter');
  }

  function addFiles(list) {
    const MAX_FILE_BYTES = 15 * 1024 * 1024;
    const files = Array.from(list || []).slice(0, 4);
    let skipped = 0;
    const ok = files.filter((file) => {
      if (file.size > MAX_FILE_BYTES) {
        skipped += 1;
        return false;
      }
      return true;
    });
    if (skipped) toast(`${skipped} file${skipped > 1 ? 's were' : ' was'} skipped — the 15 MB limit applies.`);
    ok.forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        const mime = file.type || 'application/octet-stream';
        setAttachments((prev) => {
          if (prev.length >= 4) return prev;
          return [
            ...prev,
            { id: Date.now() + '-' + Math.random().toString(36).slice(2, 7), name: file.name, mime, dataUrl: reader.result },
          ];
        });
      };
      reader.readAsDataURL(file);
    });
  }

  function openCamera() {
    setCamError(null);
    setCamOpen(true);
    setTimeout(async () => {
      const video = videoRef.current;
      if (!video) return;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1280 } },
          audio: false,
        });
        streamRef.current = stream;
        video.srcObject = stream;
        await video.play();
      } catch {
        setCamError('Camera unavailable — grant permission or upload a file instead.');
      }
    }, 80);
  }

  function capturePhoto() {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
    const name = `photo-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.jpg`;
    setAttachments((prev) => [...prev, { id: Date.now() + '-' + Math.random().toString(36).slice(2, 7), name, mime: 'image/jpeg', dataUrl }]);
    closeCamera();
  }

  function closeCamera() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCamOpen(false);
  }

  function removeAttachment(id) {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }

  function applyUsage(usage) {
    if (!usage) return;
    setModels((prev) => prev.map((m) => ({ ...m, usedToday: usage[m.key] ?? m.usedToday })));
  }

  function flushPendingTokens() {
    if (pendingTokensRef.current) {
      const chunk = pendingTokensRef.current;
      pendingTokensRef.current = '';
      setStreamText((prev) => prev + chunk);
    }
  }
  function finishStreaming(mode = 'done') {
    streamingRef.current = false;
    if (flushRafRef.current) {
      cancelAnimationFrame(flushRafRef.current);
      flushRafRef.current = 0;
      flushPendingTokens();
    }
    setToolLog((prev) =>
      prev.map((t) => (t.status === 'running' ? { ...t, status: mode === 'done' ? 'done' : 'interrupted' } : t)),
    );
    setStreaming(null);
    setStreamText('');
    setActiveTool(null);
    setArchiveWriting(false);
    setNotice(null);
    setStats(null);
    clearInterval(statsTimerRef.current);
    statsTimerRef.current = null;
    abortRef.current = null;
    pendingTokensRef.current = '';
  }

  function handleStreamDone({ messageId, content, model, usage, tokens }) {
    streamingRef.current = false;
    const stillActive = streamSessionRef.current === activeIdRef.current;
    streamSessionRef.current = null;
    if (!stillActive && activeIdRef.current) {
      finishStreaming('done');
      reloadMessages();
      refreshTitles();
      refreshModels();
      refreshTokens();
      return;
    }
    setMessages((prev) => {
      const withoutPlaceholder = prev.filter((m) => m.id !== 'placeholder');
      return [...withoutPlaceholder, { id: messageId, role: 'ai', content, model }];
    });
    finishStreaming('done');
    const seconds = Math.max(1, Math.round((Date.now() - statsStartedAtRef.current) / 1000));
    const count = tokens ? tokens.total_tokens : Math.max(lastTokensRef.current, Math.round(content.length / 3.5));
    setLastStats({ seconds, tokens: count });
    applyUsage(usage);
    refreshTitles();
    refreshModels();
    refreshTokens();
  }

  async function reloadMessages() {
    if (!activeId) return;
    try {
      const { messages: msgs } = await listMessages(activeId);
      setMessages(msgs);
    } catch {
      /* ignore */
    }
  }

  async function handleStreamError(message, code) {
    streamingRef.current = false;
    const stillActive = streamSessionRef.current === activeIdRef.current;
    streamSessionRef.current = null;
    finishStreaming('interrupted');
    if (!stillActive) {
      if (activeIdRef.current) reloadMessages();
      refreshModels();
      refreshTitles();
      return;
    }
    await reloadMessages();
    if (message !== 'Stopped') {
      setMessages((prev) => [
        ...prev,
        { id: 'error-' + Date.now(), role: 'ai', content: `${message}`, error: true },
      ]);
    }
    refreshModels();
    refreshTitles();
    refreshTokens();
  }

  async function refreshTitles() {
    try {
      const { sessions: updated } = await listSessions();
      setSessions(updated);
    } catch {
      /* ignore */
    }
  }

  async function refreshModels() {
    try {
      const { models: updated } = await listModels();
      setModels(updated);
    } catch {
      /* ignore */
    }
  }

  function finishTool(tool) {
    setToolLog((prev) => {
      const idx = prev.length - 1;
      if (idx < 0) return prev;
      const copy = prev.slice();
      copy[idx] = { ...copy[idx], status: tool.ok ? 'done' : 'error', content: tool.content || '' };
      return copy;
    });
  }

  async function send(content = draft, modelOverride) {
    const text = content.trim();
    if ((!text && attachments.length === 0) || streamingRef.current) return;

    let sessionId = activeId;
    if (!sessionId) {
      try {
        const { session } = await createSession();
        sessionId = session.id;
        setSessions((prev) => [{ ...session, title: 'New conversation' }, ...prev]);
        setActiveId(sessionId);
      } catch {
        return;
      }
    }

    const rewind = rewindRef.current; // replying against an edited past turn?
    const willRewind = !!(rewind && rewind.sessionId === sessionId && rewind.messageId);

    setDraft('');
    setAttachments([]);
    streamSessionRef.current = sessionId;
    setMessages((prev) => {
      if (willRewind) {
        const idx = prev.findIndex((m) => m.id === rewind.messageId);
        if (idx === -1) return [...prev, { id: 'user-' + Date.now(), role: 'user', content: text }];
        const copy = prev.slice(0, idx + 1);
        copy[idx] = { ...copy[idx], content: text };
        return copy;
      }
      return [...prev, { id: 'user-' + Date.now(), role: 'user', content: text }];
    });
    setMessages((prev) => [...prev, { id: 'placeholder', role: 'ai', content: '', pending: true }]);
    rewindRef.current = null;
    streamingRef.current = true;
    setStreaming('connecting');
    setStreamText('');
    setActiveTool(null);
    setToolLog([]);
    setExpandedTool(null);
    setNotice(null);
    streamStartedRef.current = false;
    setArchiveWriting(false);

    setStats(null);
    lastTokensRef.current = 0;
    statsStartedAtRef.current = Date.now();
    clearInterval(statsTimerRef.current);
    statsTimerRef.current = setInterval(() => {
      setStats((prev) => ({
        tokens: prev?.tokens ?? 0,
        seconds: Math.round((Date.now() - statsStartedAtRef.current) / 1000),
      }));
    }, 1000);

    abortRef.current = streamChat({
      sessionId,
      content: text,
      model: modelOverride || modelKey,
      attachments: attachments.length ? attachments.map(({ name, mime, dataUrl }) => ({ name, mime, dataUrl })) : undefined,
      rewindMessageId: willRewind ? rewind.messageId : undefined,
      onThinking: () => setStreaming('thinking'),
      onNotice: (message) => {
        setNotice(message);
        clearTimeout(noticeTimerRef.current);
        noticeTimerRef.current = setTimeout(() => setNotice(null), 9000);
      },
      onProgress: (info) => {
        lastTokensRef.current = info.tokens ?? lastTokensRef.current;
        setStats({ seconds: info.seconds, tokens: lastTokensRef.current });
      },
      onTool: (tool) => {
        setStreaming('receiving');
        const id = tool.seq != null ? tool.seq : ++toolSeqRef.current;
        setToolLog((prev) => [...prev, { id, name: tool.name, args: tool.args || {}, status: 'running', content: '' }]);
        setActiveTool(tool);
        setExpandedTool(id);
        if (tool.name === 'make_site') setArchiveWriting(true);
        scrollToBottom(true);
      },
      onToolResult: (tool) => {
        setToolLog((prev) => {
          const id = tool.seq;
          const idx = id != null ? prev.findIndex((t) => t.id === id) : prev.length - 1;
          if (idx < 0) return prev;
          const copy = prev.slice();
          copy[idx] = { ...copy[idx], status: tool.ok ? 'done' : 'error', content: tool.content || '' };
          return copy;
        });
      },
      onToken: (token) => {
        if (!streamStartedRef.current) {
          streamStartedRef.current = true;
          setStreaming('receiving');
        }
        // Batch tokens per animation frame for smoother 60fps on mobile
        pendingTokensRef.current += token;
        if (!flushRafRef.current) {
          flushRafRef.current = requestAnimationFrame(() => {
            flushRafRef.current = 0;
            if (pendingTokensRef.current) {
              const chunk = pendingTokensRef.current;
              pendingTokensRef.current = '';
              setStreamText((prev) => prev + chunk);
              scrollToBottom();
            }
          });
        }
      },
      onArchive: (data) => {
        if (data?.url) {
          setArchiveUrl(data.url);
          setArchiveWriting(false);
          setArchiveOpen(true);
        }
      },
      onDone: handleStreamDone,
      onError: handleStreamError,
    });
  }

  async function newSession() {
    if (streaming && abortRef.current) abortRef.current();
    setActiveId(null);
    setMessages([]);
    setStreaming(null);
    setStreamText('');
    setActiveTool(null);
    setToolLog([]);
    setExpandedTool(null);
    if (window.innerWidth <= 900) setSidebarOpen(false);
    inputRef.current?.focus();
  }

  async function removeSession(id) {
    if (!window.confirm('Delete this conversation?')) return;
    try {
      await deleteSession(id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
      if (activeId === id) newSession();
    } catch {
      /* ignore */
    }
  }

  function stopStreaming() {
    if (abortRef.current) abortRef.current();
  }

  // Load the archive inventory (files + shares) whenever the panel opens.
  useEffect(() => {
    if (!archiveOpen) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await listArchives();
        if (!cancelled) {
          setArchives(data);
          setArchivesBusy(false);
        }
      } catch {
        if (!cancelled) setArchivesBusy('Could not load archives.');
      }
    })();
    return () => { cancelled = true; };
  }, [archiveOpen, archiveUrl]);

  // Close mobile "more" menu when tapping outside
  useEffect(() => {
    if (!moreOpen) return;
    const onDocClick = (e) => {
      if (!e.target.closest('.chat__topbar-right')) setMoreOpen(false);
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [moreOpen]);

  // The file currently previewed, when known.
  const previewFile = archiveUrl?.split('/').pop()?.replace(/%20/g, ' ') || null;

  // The share row that matches the previewed file (or the newest archive).
  const activeShared = (archives?.shared || []).find((s) => s.file === previewFile) || null;
  const activeFiles = archives?.sites || [];

  function pickArchive(site) {
    setArchiveUrl(site.url);
    setShareMsg(null);
    setShareCopied(false);
    setShareSlug(''); // default: auto-name
  }

  async function doShare(customSlug) {
    if (shareBusy) return;
    const file = activeShared?.file || previewFile || activeFiles[0]?.file;
    if (!file) { setShareMsg({ kind: 'err', text: 'No archive to share.' }); return; }

    // Already shared and no new name given? Keep the existing live URL.
    const explicit = typeof customSlug === 'string' && customSlug.trim() ? customSlug.trim() : (shareSlug && shareSlug.trim() ? shareSlug : '');
    if (activeShared && !explicit) {
      setShareMsg({ kind: 'ok', text: activeShared.public_url });
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 1400);
      return;
    }

    setShareBusy(true);
    setShareMsg(null);
    setShareCopied(false);
    try {
      const res = await shareArchive(file, explicit);
      const updated = await listArchives();
      setArchives(updated);
      setShareSlug('');
      setShareMsg(res?.error ? { kind: 'err', text: res.error } : { kind: 'ok', text: res?.shared?.public_url || 'Shared.' });
    } catch (err) {
      setShareMsg({ kind: 'err', text: err.message || 'Share failed.' });
    } finally {
      setShareBusy(false);
    }
  }

  async function doUnshare(slug) {
    try {
      await unshareArchive(slug);
      setArchives(await listArchives());
      setShareMsg(null);
      setShareCopied(false);
    } catch {
      setShareMsg({ kind: 'err', text: 'Could not unshare.' });
    }
  }

  async function copyShare(publicUrl) {
    try {
      await navigator.clipboard.writeText(backendOrigin() + publicUrl);
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 1400);
    } catch {
      setShareMsg({ kind: 'err', text: 'Copy failed — select the link manually.' });
    }
  }

  function handleGenerateImage() {
    const prompt = imgPrompt.trim();
    if (!prompt || streaming) return;
    setImgOpen(false);
    setImgPrompt('');
    send(prompt, 'jupiter');
  }

  function openImagePanel() {
    setImgOpen(true);
    setTimeout(() => imgInputRef.current?.focus(), 50);
  }

  const hasMessages = messages.length > 0;
  const activeModel = models.find((m) => m.key === modelKey);
  const shortModelName = (id) => String(id || '').replace('MT 1.0 ', '');
  const requestsToday = models.reduce((sum, m) => sum + (m.usedToday || 0), 0);
  const userTokens = tokenStats?.user?.all?.total_tokens || 0;
  const globalTokens = tokenStats?.global?.all?.total_tokens || 0;
  const imageRendering = toolLog.some((t) => t.name === 'make_image' && t.status === 'running');

  return (
    <div className="chat">
      <div className={`chat__drawer ${sidebarOpen ? 'is-open' : ''}`} onClick={() => setSidebarOpen(false)} />
      <aside className={`chat__sidebar${sidebarOpen ? ' is-open' : ''}`}>
        <div className="chat__sidebar-head">
          <button className="btn btn-primary chat__new" onClick={newSession}>
            <Icon name="add" /> New conversation
          </button>
          <div className="chat__search">
            <input
              className="chat__search-input"
              type="search"
              placeholder="Search conversations…"
              value={searchQ}
              onChange={(e) => handleSearch(e.target.value)}
            />
          </div>
        </div>
        <div className="chat__list">
          {loading && <div style={{ padding: 12, color: 'var(--text-muted)', fontSize: '0.85rem' }}>Loading conversations…</div>}
          {!loading && sessions.length === 0 && (
            <div style={{ padding: 14, color: 'var(--text-muted)', fontSize: '0.85rem' }}>
              {searchQ ? 'No matches.' : 'No conversations yet.'}
            </div>
          )}
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`chat__item${s.id === activeId ? ' is-active' : ''}`}
              style={{ cursor: 'pointer' }}
              onClick={() => { setActiveId(s.id); if (window.innerWidth <= 900) setSidebarOpen(false); }}
            >
              {renamingId === s.id ? (
                <input
                  className="chat__rename-input"
                  autoFocus
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename(s.id);
                    if (e.key === 'Escape') setRenamingId(null);
                  }}
                  onBlur={() => commitRename(s.id)}
                />
              ) : (
                <span className={`chat__item-title${s.pinned ? ' is-pinned' : ''}`}>{s.title}</span>
              )}
              <button
                className="chat__item-act"
                title="Pin"
                aria-label={s.pinned ? 'Unpin conversation' : 'Pin conversation'}
                onClick={(e) => { e.stopPropagation(); togglePin(s.id); }}
              >
                <Icon name={s.pinned ? 'push_pin' : 'push_pin'} className={s.pinned ? 'chat__pin-on' : 'chat__pin-off'} />
              </button>
              <button
                className="chat__item-act"
                title="Rename"
                aria-label="Rename conversation"
                onClick={(e) => { e.stopPropagation(); startRename(s.id, s.title); }}
              >
                <Icon name="edit" />
              </button>
              <button
                className="chat__item-del"
                onClick={(e) => { e.stopPropagation(); removeSession(s.id); }}
                aria-label="Delete conversation"
              >
                <Icon name="close" />
              </button>
            </div>
          ))}
        </div>
        <div className="chat__sidebar-foot">
          <span className="chat__foot-user">
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{user.username || user.email}</span>
            {tokenStats && (
              <span className="token-chip" title={`Your tokens · overall on this server: ${fmt(globalTokens)}`}>
                <Icon name="data_object" className="token-chip__icon" />
                {fmt(userTokens)}
              </span>
            )}
          </span>
          <button className="btn btn-ghost" style={{ padding: '4px 8px' }} onClick={onLogout} title="Log out" aria-label="Log out">
            <Icon name="logout" />
          </button>
        </div>
      </aside>

      <main className="chat__main">
        {notice && (
          <div className="chat__notice" role="status">
            <span>{notice}</span>
            <button className="chat__notice-x" onClick={() => setNotice(null)} aria-label="Dismiss"><Icon name="close" /></button>
          </div>
        )}
        <div className="chat__topbar">
          <button className="chat__hamburger" onClick={() => setSidebarOpen((v) => !v)} aria-label="Toggle conversations" aria-expanded={sidebarOpen}>
            <span /><span /><span />
          </button>
          <img src="/assets/favicon-sm.png" alt="DeepMT" style={{ height: 26 }} />
          <div className="chat__title">
            {sessions.find((s) => s.id === activeId)?.title || 'New conversation'}
          </div>
          <div className="chat__topbar-right" style={{ position: 'relative' }}>
            {tokenStats && (
              <span className="token-chip token-chip--top" title={`Account → overall: ${fmt(userTokens)} / ${fmt(globalTokens)}`}>
                <Icon name="data_object" className="token-chip__icon" />
                {fmt(userTokens)}<span className="token-chip__sep">/</span><span className="token-chip__overall">{fmt(globalTokens)}</span>
              </span>
            )}
            {archiveWriting && (
              <span className="archives__writing">
                <span className="archives__pulse" />writing site…
              </span>
            )}
            <button className="btn btn-ghost chat__archives-btn" onClick={openLibrary} title="Your generated media">
              <Icon name="photo_library" /> Media
            </button>
            <div className="chat__export">
              <button
                className={`btn btn-ghost chat__archives-btn${exportOpen ? ' is-active' : ''}`}
                onClick={() => setExportOpen((v) => !v)}
                title="Export this conversation"
              >
                <Icon name="download" /> Export
              </button>
              {exportOpen && (
                <div className="chat__export-menu">
                  <button onClick={() => doExport('md')}>Markdown (.md)</button>
                  <button onClick={() => doExport('pdf')}>PDF (styled)</button>
                </div>
              )}
            </div>
            {exportLink && !exportOpen && (
              <a className="chat__export-chip" href={authedUrl(exportLink.url)} download title="Download export">
                {exportBusy ? '…' : `OK ${exportLink.format.toUpperCase()}`}
              </a>
            )}
            <button
              className={`btn btn-ghost chat__archives-btn${archiveOpen ? ' is-active' : ''}`}
              onClick={() => setArchiveOpen((v) => !v)}
              title="Toggle Archives panel"
            >
              <Icon name="history_edu" /> Archives
            </button>
            <button
              className={`btn btn-ghost chat__archives-btn${keysOpen ? ' is-active' : ''}`}
              onClick={() => setKeysOpen((v) => !v)}
              title="API keys — call DeepMT from your projects"
            >
              <Icon name="key" /> API
            </button>
            {/* Mobile overflow: consolidated menu */}
            <button className="chat__more-btn" onClick={() => setMoreOpen((v) => !v)} aria-label="More actions" aria-expanded={moreOpen}>
              <Icon name="more_vert" />
            </button>
            {moreOpen && (
              <div className="chat__more-menu" role="menu" onClick={() => setMoreOpen(false)}>
                <button role="menuitem" onClick={openLibrary}><Icon name="photo_library" /> Media library</button>
                <button role="menuitem" onClick={() => setArchiveOpen((v) => !v)}><Icon name="history_edu" /> {archiveOpen ? 'Hide Archives' : 'Show Archives'}</button>
                <button role="menuitem" onClick={() => setKeysOpen((v) => !v)}><Icon name="key" /> API keys</button>
                <button role="menuitem" onClick={() => setExportOpen((v) => !v)}><Icon name="download" /> Export conversation</button>
                {tokenStats && (
                  <div style={{ padding: '8px 12px', fontSize: '0.8rem', color: 'var(--text-muted)', borderTop: '1px solid var(--border)', marginTop: '4px' }}>
                    Tokens: {fmt(userTokens)} / {fmt(globalTokens)} overall
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <SysStrip />

        <div className="chat__thread" ref={threadRef} onScroll={onThreadScroll}>
          {scrolledUp && (
            <button className="chat__jump" onClick={() => scrollToBottom(true)} title="Back to latest" aria-label="Back to latest">
              <Icon name="keyboard_double_arrow_down" /> Latest
            </button>
          )}
          {!hasMessages && !streaming ? (
            <div className="chat__empty">
              <div className="chat__empty-watermark">
                <img src="/assets/favicon-sm.png" alt="" />
              </div>
              <div className="chat__empty-inner">
                <h2>What shall we explore?</h2>
                <p>
                  Pick a model in the composer — <strong>Lite</strong> streams from the Ollama host,{' '}
                  <strong>Neptune</strong> and <strong>Jupiter</strong> run on TurboFieldfare,
                  <strong> Uranus</strong> is the fastest local flagship with full tool calling.
                </p>
                <div className="chat__suggestions">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      className="chat__suggestion"
                      onClick={() => (s.startsWith('Generate an image') ? (setImgPrompt(s.replace('Generate an image of ', '')), openImagePanel()) : send(s))}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="chat__messages">
              {messages.map((m) => {
                if (m.id === 'placeholder') {
                  return (
                    <div className="msg msg--thinking" key={m.id}>
                      <div className="msg__avatar msg__avatar--ai">
                        <span className="thinking-flower">
                          <img className="thinking-flower-img" src="/assets/favicon-xs.png" alt="DeepMT flower" />
                        </span>
                      </div>
                      <div className="msg__body">
                        <div className="msg__role">
                          DeepMT{activeModel ? ` · ${activeModel.displayName}` : ''}
                        </div>
                        <div className={`status-chip status-chip--${streaming}${thinkingOpen ? ' is-open' : ''}`}>
                          <button
                            className="status-chip__toggle"
                            onClick={() => setThinkingOpen((v) => !v)}
                            aria-expanded={thinkingOpen}
                            aria-label={thinkingOpen ? 'Hide thought details' : 'Show thought details'}
                          >
                            <Icon name="chevron_right" className="status-chip__chev" />
                            <span className="status-chip__label">
                              {streaming === 'connecting' ? 'Connecting' : streaming === 'thinking' ? 'Thinking' : 'Live'}
                            </span>
                            <span className="status-chip__dots" aria-hidden="true">
                              <span className="status-chip__dot" />
                              <span className="status-chip__dot" />
                              <span className="status-chip__dot" />
                            </span>
                            {streaming === 'receiving' && (
                              <span className="status-chip__live">streaming each token</span>
                            )}
                            {stats?.seconds ? (
                              <span className="status-chip__count">
                                {stats.seconds}s{stats.tokens ? ` · ~${stats.tokens.toLocaleString()} tokens` : ''}
                                {stats.seconds > 1 && (stats.tokens ?? 0) > 0
                                  ? ` · ${Math.round((stats.tokens ?? 0) / stats.seconds).toLocaleString()} tok/s`
                                  : ''}
                              </span>
                            ) : null}
                          </button>
                          {thinkingOpen && (
                            <div className="status-chip__panel">
                              <div className="thinking-meta-row">
                                {activeModel && <span>model <strong>{activeModel.displayName}</strong></span>}
                                {activeModel?.provider && <span>engine <strong>{activeModel.provider}</strong></span>}
                                <span>timeout <strong>300s</strong></span>
                                {notice && <span>{notice}</span>}
                              </div>
                            </div>
                          )}
                        </div>
                        {streaming === 'receiving' && (
                          <div className="msg__content">
                            {toolLog.length > 0 && (
                              <div className="tool-log">
                                {toolLog.map((t) => (
                                  <div className={`tool-card tool-card--${t.status}`} key={t.id}>
                                    <button
                                      className="tool-card__head"
                                      onClick={() => setExpandedTool((prev) => (prev === t.id ? null : t.id))}
                                      aria-expanded={expandedTool === t.id}
                                    >
                                      <Icon name={t.status === 'running' ? 'sync' : t.status === 'error' ? 'error' : 'check_circle'} className={`tool-card__ico tool-card__ico--${t.status}`} />
                                      <span className="tool-card__name">{t.name}</span>
                                      {t.status === 'running' ? (
                                        <span className="tool-card__spinner" />
                                      ) : (
                                        <span className={`tool-card__status tool-card__status--${t.status}`}>{t.status}</span>
                                      )}
                                      <Icon name="expand_more" className={`tool-card__expand${expandedTool === t.id ? ' is-open' : ''}`} />
                                    </button>
                                    {expandedTool === t.id && (
                                      <div className="tool-card__body">
                                        {t.args && Object.keys(t.args).length > 0 && (
                                          <div className="tool-card__args">
                                            <div className="tool-card__label">Args</div>
                                            <pre>{JSON.stringify(t.args, null, 2)}</pre>
                                          </div>
                                        )}
                                        {t.content && (
                                          <div className="tool-card__content">
                                            <div className="tool-card__label">{t.status === 'error' ? 'Failed' : 'Result'}</div>
                                            <pre>{t.content}</pre>
                                          </div>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}
                            {imageRendering && (
                              <div className="img-gen">
                                <div className="img-gen__shimmer" />
                                <div className="img-gen__inner">
                                  <img className="img-gen__flower" src="/assets/favicon-xs.png" alt="" />
                                  <span>Rendering with Stable Diffusion…</span>
                                </div>
                              </div>
                            )}
                            <div className="typing-indicator">
                              {streamText ? (
                                <LiveText text={streamText} render={(t) => <Markdown text={t} />} />
                              ) : (
                                <span className="typing-caret" />
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                }
                return (
                  <div className={`msg${m.error ? ' msg--error' : ''}`} key={m.id}>
                    <div className={`msg__avatar ${m.role === 'ai' ? 'msg__avatar--ai' : 'msg__avatar--user'}`}>
                      {m.role === 'ai'
                        ? <Icon name="auto_awesome" className="msg__avatar-ico" />
                        : <Icon name="person" className="msg__avatar-ico" />}
                    </div>
                    <div className="msg__body">
                      <div className="msg__role">
                        {m.role === 'ai' ? `DeepMT${m.model ? ` · ${shortModelName(m.model)}` : ''}` : 'You'}
                        {m.created_at && (
                          <time className="msg__time" title={new Date(m.created_at).toLocaleString()}>
                            {new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </time>
                        )}
                        {m.role === 'ai' && !m.error && (
                          <button
                            className={`msg__copy${copiedId === m.id ? ' is-copied' : ''}`}
                            title={copiedId === m.id ? 'Copied to clipboard' : 'Copy this reply'}
                            aria-label="Copy this reply"
                            onClick={() => copyMessage(m)}
                          >
                            <Icon name={copiedId === m.id ? 'check' : 'content_copy'} />
                          </button>
                        )}
                        {m.role === 'user' && !streaming && (
                          <button
                            className="msg__edit"
                            title="Edit & re-ask from this message"
                            aria-label="Edit this message"
                            onClick={() => startRewind(m.id)}
                          >
                            <Icon name="edit_note" />
                          </button>
                        )}
                      </div>
                      <div className="msg__content">
                        {m.role === 'ai'
                          ? <Markdown text={m.content} />
                          : m.content}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="chat__composer">
          <div className="chat__composer-inner">
            <div className="chat__composer-row">
              <button
                className={`img-toggle${imgOpen ? ' is-active' : ''}`}
                onClick={() => setImgOpen((v) => !v)}
                aria-expanded={imgOpen}
                title="Ask Jupiter to generate an image"
              >
                <Icon name="image" /> <span>Image</span>
              </button>
              <button
                className="img-toggle chat__apply-preview"
                onClick={() => { if (draft.trim()) setDraftPreview((v) => !v); }}
                title={draftPreview ? 'Back to editing' : 'Preview as markdown'}
                aria-label="Preview draft as markdown"
                aria-pressed={draftPreview}
                disabled={!draft.trim()}
              >
                <Icon name={draftPreview ? 'visibility_off' : 'visibility'} /> <span>{draftPreview ? 'Edit' : 'Preview'}</span>
              </button>
            </div>

            {imgOpen && (
              <div className="imgpanel">
                <div className="imgpanel__prompt">
                  <textarea
                    ref={imgInputRef}
                    className="chat__input"
                    rows={1}
                    placeholder="Describe the image… e.g. a fox in a snowy forest, golden hour, photorealistic"
                    value={imgPrompt}
                    onChange={(e) => { setImgPrompt(e.target.value); e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'; }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleGenerateImage();
                      }
                    }}
                  />
                  <button
                    className="chat__send"
                    onClick={handleGenerateImage}
                    disabled={!imgPrompt.trim() || !!streaming}
                    title="Ask Jupiter to generate (Enter)"
                  >
                    <Icon name="auto_awesome" />
                  </button>
                </div>
                <div className="imgpanel__hint">
                  Jupiter picks the best size (up to 1024 on the longest edge) — edits keep your photo’s aspect ratio. PNGs appear here in the conversation.
                </div>
              </div>
            )}

            {attachments.length > 0 && (
              <div className="attach-row">
                {attachments.map((a) => {
                  const isImg = a.mime.startsWith('image/');
                  return (
                    <div className="attach-chip" key={a.id}>
                      {isImg
                        ? <img className="attach-chip__thumb" src={a.dataUrl} alt={a.name} />
                        : <span className="attach-chip__icon"><Icon name="description" /></span>}
                      <span className="attach-chip__name" title={a.name}>{a.name}</span>
                      <button className="attach-chip__x" onClick={() => removeAttachment(a.id)} aria-label="Remove attachment"><Icon name="close" /></button>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="chat__input-wrap">
              {rewindRef.current && (
                <button className="chat__rewind" onClick={cancelRewind} title="Cancel editing">
                  <Icon name="undo" /> Editing past message — send to rewrite, or cancel
                </button>
              )}
              <button
                className="chat__attach"
                onClick={() => { fileInputRef.current?.click(); }}
                title="Attach a file or photo"
                aria-label="Attach a file or photo"
              >
                <Icon name="attach_file" />
              </button>
              <button
                className="chat__attach"
                onClick={openCamera}
                title="Take a photo with your camera"
                aria-label="Take a photo with your camera"
              >
                <Icon name="photo_camera" />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,.pdf,.md,.txt,.csv,.json"
                style={{ display: 'none' }}
                onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
              />
              {draftPreview ? (
                <div className="chat__preview">
                  {draft.trim() ? (
                    <Markdown text={draft} />
                  ) : (
                    <span className="chat__preview-empty">Nothing to preview — start typing.</span>
                  )}
                  <button className="chat__preview-edit" onClick={() => setDraftPreview(false)} title="Back to editing">
                    <Icon name="edit" /> edit
                  </button>
                </div>
              ) : (
                <textarea
                  ref={inputRef}
                  className="chat__input"
                  rows={1}
                  placeholder={streaming ? 'Generating…' : 'Ask DeepMT anything…'}
                  value={draft}
                  onChange={(e) => { setDraft(e.target.value); e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px'; }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  disabled={!!streaming}
                />
              )}
              <ModelSelect models={models} active={modelKey} onSelect={setModelKey} disabled={!!streaming} />
              {streaming ? (
                <button className="chat__send" onClick={stopStreaming} title="Stop generating" aria-label="Stop">
                  <Icon name="stop" />
                </button>
              ) : (
                <button className="chat__send" onClick={() => send()} title="Send (Enter)" aria-label="Send" disabled={!draft.trim() && attachments.length === 0}>
                  <Icon name="send" />
                </button>
              )}
            </div>
            <div className="chat__hint">
              <div>Enter to send · Shift+Enter for a new line</div>
              <div className="chat__hint-stats">
                {streaming ? (
                  <span className="chat__hint-live">
                    Working on it — {stats?.seconds ?? 0}s · {stats?.tokens?.toLocaleString() ?? 0} tokens
                    {(stats?.seconds ?? 0) > 1 && (stats?.tokens ?? 0) > 0
                      ? ` · ${Math.round((stats.tokens ?? 0) / (stats.seconds ?? 1)).toLocaleString()} tok/s`
                      : ''}
                  </span>
                ) : lastStats ? (
                  <span className="chat__hint-last">
                    Last request: {lastStats.seconds}s · {lastStats.tokens.toLocaleString()} tokens ·{' '}
                    {requestsToday} request{requestsToday === 1 ? '' : 's'} today
                    {tokenStats ? ` · account ${fmt(userTokens)} · overall ${fmt(globalTokens)}` : ''}
                  </span>
                ) : (
                  <span className="chat__hint-default">
                    <Icon name="image" /> Image = ask Jupiter · daily limits:{' '}
                    {models.length > 0
                      ? models.map((m) => `${m.displayName} ${m.rateLimit == null ? '∞' : m.rateLimit}`).join(' · ')
                      : 'Lite ∞ · Neptune 25 · Jupiter 10'}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      </main>

      <section className={`archives${archiveOpen ? ' is-open' : ''}`}>
        <div className="archives__head">
          <span className="archives__title"><Icon name="history_edu" className="archives__title-ico" /> Archives</span>
          {archiveWriting && (
            <span className="archives__writing archives__writing--inline">
              <span className="archives__pulse" />writing code…
            </span>
          )}
          <button className="archives__close" onClick={() => setArchiveOpen(false)} aria-label="Close Archives"><Icon name="close" /></button>
        </div>
        <div className="archives__body">
          {(activeFiles.length > 1) && (
            <div className="archives__files">
              {(activeFiles.slice(0, 8)).map((s) => (
                <button
                  key={s.file}
                  className={`archives__file${previewFile === s.file ? ' is-active' : ''}`}
                  onClick={() => pickArchive(s)}
                  title={s.file}
                >
                  {s.file.replace(/\.html$/i, '')}
                  {s.shared ? ' ●' : ''}
                </button>
              ))}
            </div>
          )}
          {archiveWriting && !archiveUrl ? (
            <div className="archives__loading">
              <div className="archives__spinner" />
              Writing your site… it will appear here.
            </div>
          ) : archiveUrl ? (
            <iframe
              className="archives__frame"
              src={`${archiveUrl}${archiveUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(localStorage.getItem('deepmt_token') || '')}`}
              title="Archives site preview"
            />
          ) : (
            <div className="archives__empty">
              No site yet.
              <br />Ask Jupiter to <em>make a site</em> for you and it will be previewed here.
            </div>
          )}
          {(activeFiles.length > 0) && (
            <div className="archives__share">
              <div className="archives__share-lbl">
                <Icon name="link" /> Public share link{activeShared ? '' : ' — give it a name (optional)'}
              </div>
              <div className="archives__share-row">
                <span className="archives__share-pfx">/u/{encodeURIComponent(user.username || user.email)}/shared/archives/</span>
                <input
                  className="archives__share-input"
                  value={shareSlug}
                  onChange={(e) => setShareSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                  placeholder={activeShared?.slug || 'auto-name'}
                  maxLength={48}
                  disabled={!!activeShared}
                />
                <button className="btn btn-primary archives__share-btn" disabled={shareBusy} onClick={() => doShare()}>
                  {shareBusy ? 'Sharing…' : (activeShared ? 'Re-share' : 'Share')}
                </button>
              </div>
              {activeShared && (
                <div className="archives__share-done">
                  <a className="archives__share-link" href={activeShared.public_url} target="_blank" rel="noreferrer">
                    {backendOrigin() + activeShared.public_url}
                  </a>
                  <button className="btn" onClick={() => copyShare(activeShared.public_url)}>
                    {shareCopied ? 'Copied' : 'Copy'}
                  </button>
                  <button className="btn btn-ghost archives__share-undo" onClick={() => doUnshare(activeShared.slug)}>
                    Unshare
                  </button>
                  <span className="archives__share-live">live · no login needed</span>
                </div>
              )}
              {shareMsg && (
                shareMsg.kind === 'ok' ? (
                  <div className="archives__share-msg">
                    <a className="archives__share-msg-link" href={shareMsg.text} target="_blank" rel="noreferrer">{shareMsg.text}</a>
                  </div>
                ) : (
                  <div className="archives__share-msg archives__share-msg--err">{shareMsg.text}</div>
                )
              )}
            </div>
          )}
        </div>
      </section>

      {libOpen && (
        <div className="edit-modal lib-modal" role="dialog" aria-modal="true" aria-label="Your generated media">
          <div className="edit-modal__card lib-card">
            <div className="edit-modal__head">
              <Icon name="photo_library" />
              <span>Your media</span>
              <button className="edit-modal__close" onClick={() => setLibOpen(false)} aria-label="Close"><Icon name="close" /></button>
            </div>
            <div className="lib-body">
              {!library ? (
                <div className="lib-loading">Loading…</div>
              ) : library.error ? (
                <div className="lib-loading">{library.error}</div>
              ) : library.images.length + library.files.length === 0 ? (
                <div className="lib-loading">
                  Nothing here yet — ask Jupiter for an image, chart, QR code or document and it will show up in this gallery.
                </div>
              ) : (
                <div className="lib-grid">
                  {[...(library.images || []), ...(library.files || [])].map((item, i) => (
                    <div className="lib-tile" key={item.file + i} title={item.file}>
                      {item.isImage ? (
                        <img className="lib-thumb" src={authedUrl(item.url)} alt={item.prompt || item.file} loading="lazy" />
                      ) : (
                        <div className="lib-thumb lib-thumb--file">
                          <Icon name="description" />
                          <span className="lib-ext">{item.kind.toUpperCase()}</span>
                        </div>
                      )}
                      <div className="lib-tile-actions">
                        <button
                          className="lib-tile-btn"
                          title="Insert into message"
                          onClick={() => insertIntoDraft(item.isImage ? `![Image](${item.url})` : `[${item.kind.toUpperCase()} file](${item.url})`)}
                        >
                          <Icon name="add" />
                        </button>
                        <a className="lib-tile-btn" href={authedUrl(item.url)} download title="Download">
                          <Icon name="download" />
                        </a>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {varySrc && (
        <div className="edit-modal" role="dialog" aria-modal="true" aria-label="Creating a variation">
          <div className="edit-modal__card edit-modal__card--vary">
            <div className="edit-modal__head">
              <Icon name="autorenew" />
              <span>Variation</span>
              <button className="edit-modal__close" onClick={() => setVarySrc(null)} aria-label="Close"><Icon name="close" /></button>
            </div>
            {varyState === 'busy' ? (
              <div className="vary-busy">
                <div className="archives__spinner" />
                <span>Rendering a variation…</span>
              </div>
            ) : varyState ? (
              varyState.error ? (
                <div className="vary-result">{varyState.error}</div>
              ) : (
                <div className="vary-result">
                  <img className="vary-preview" src={authedUrl(varyState.url)} alt="Variation" />
                  <div className="vary-actions">
                    <button className="btn" onClick={() => setVarySrc(null)}>Done</button>
                    <button className="btn btn-primary" onClick={() => { insertIntoDraft(`![Variation](${varyState.url})`); setVarySrc(null); }}>
                      Insert into message
                    </button>
                  </div>
                </div>
              )
            ) : null}
          </div>
        </div>
      )}

      {camOpen && (
        <div className="edit-modal" role="dialog" aria-modal="true" aria-label="Take a photo">
          <div className="edit-modal__card edit-modal__card--cam">
            <div className="edit-modal__head">
              <Icon name="photo_camera" />
              <span>Take a photo</span>
              <button className="edit-modal__close" onClick={closeCamera} aria-label="Close"><Icon name="close" /></button>
            </div>
            <div className="cam-feed">
              <video ref={videoRef} playsInline muted autoPlay />
              {camError && <div className="cam-feed__error">{camError}</div>}
            </div>
            <div className="cam-actions">
              <button className="btn" onClick={closeCamera}>Cancel</button>
              <button className="btn btn-primary cam-shutter" onClick={capturePhoto}>Capture</button>
            </div>
          </div>
        </div>
      )}

      {editTarget && (
        <div className="edit-modal" role="dialog" aria-modal="true" aria-label="Edit image with AI">
          <div className="edit-modal__card">
            <div className="edit-modal__head">
              <Icon name="edit" />
              <span>Edit this image with AI</span>
              <button className="edit-modal__close" onClick={() => setEditTarget(null)} aria-label="Close"><Icon name="close" /></button>
            </div>
            <div className="edit-modal__preview">
              <img src={authedUrl(editTarget)} alt="Source image to edit" />
            </div>
            <div className="edit-modal__input">
              <input
                ref={editInputRef}
                className="chat__input"
                value={editDraft}
                onChange={(e) => setEditDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') submitEdit(); }}
                placeholder="Describe the change… e.g. make it snowy, change the sky to purple"
              />
            </div>
            <div className="edit-modal__foot">
              <button className="btn" onClick={() => setEditTarget(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={submitEdit} disabled={!editDraft.trim() || !!streaming}>
                Ask Jupiter to edit
              </button>
            </div>
          </div>
        </div>
      )}

      {keysOpen && <ApiKeys onClose={() => setKeysOpen(false)} />}
    </div>
  );
}