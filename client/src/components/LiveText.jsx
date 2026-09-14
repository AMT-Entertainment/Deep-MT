import { useEffect, useMemo, useRef, useState } from 'react';

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const SCRAMBLE_LEN = 6;
const SETTLE_FRAMES = 14;

/**
 * Renders a streamed message with a "decipher" effect: the trailing ~6
 * characters stay scrambled while text pours in, then resolve into the real
 * characters once the stream pauses at the end.
 */
export default function LiveText({ text, render }) {
  const wantRef = useRef(text);
  const shownRef = useRef(0);
  const stallRef = useRef(0);
  const lastLenRef = useRef(0);
  const [shown, setShown] = useState(0);
  const [tail, setTail] = useState('');
  const fastRef = useRef(false);

  useEffect(() => {
    // On mobile / coarse pointer or reduced-motion, skip scramble for instant streaming
    try {
      const coarse = window.matchMedia('(pointer: coarse)').matches;
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      fastRef.current = coarse || reduce;
      if (fastRef.current) {
        setShown(text.length);
        setTail('');
      }
    } catch {}
  }, []);

  useEffect(() => {
    wantRef.current = text;
    // In fast mode, reveal instantly without scramble
    if (fastRef.current) {
      setShown(text.length);
      setTail('');
    }
  }, [text]);

  useEffect(() => {
    if (fastRef.current) return; // no RAF loop needed in fast mode
    let raf;
    const tick = () => {
      const want = wantRef.current;
      const len = want.length;
      stallRef.current = len === lastLenRef.current ? stallRef.current + 1 : 0;
      lastLenRef.current = len;

      if (len === 0) {
        shownRef.current = 0;
        setShown(0);
        setTail('');
      } else if (stallRef.current > SETTLE_FRAMES) {
        shownRef.current = len;
        setShown(len);
        setTail('');
      } else {
        const maxReveal = Math.max(0, len - SCRAMBLE_LEN);
        let next = shownRef.current;
        if (next < maxReveal) {
          next = Math.min(maxReveal, next + Math.max(1, Math.round((maxReveal - next) / 8)));
          shownRef.current = next;
        }
        setShown(next);
        let t = '';
        const n = Math.min(SCRAMBLE_LEN, len - next);
        for (let i = 0; i < n; i++) {
          t += CHARS[(Math.random() * CHARS.length) | 0];
        }
        setTail(t);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const revealed = useMemo(() => {
    if (fastRef.current) return text;
    return text.slice(0, Math.min(shown, text.length));
  }, [text, shown]);

  // Fast path: direct render, no tail, zero extra JS work per frame
  if (fastRef.current) {
    return <span className="live-text">{render ? render(text) : text}</span>;
  }

  return (
    <span className="live-text">
      <span className="live-text__md">{render ? render(revealed) : revealed}</span>
      {tail ? <span className="live-text__tail">{tail}</span> : null}
    </span>
  );
}