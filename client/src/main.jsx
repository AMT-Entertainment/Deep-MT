import { createRoot } from 'react-dom/client';
import App from './App';
import { initApiBase } from './api';
import './styles/tokens.css';
import './styles/animations.css';
import './styles/home.css';
import './styles/auth.css';
import './styles/chat.css';

// Resolve the remote backend (GitHub Pages tunnel URL) before first paint.
// Falls back to same-origin immediately if backend.json is missing/slow.
const root = createRoot(document.getElementById('root'));
root.render(<App />);
try {
  await Promise.race([
    initApiBase(),
    new Promise((r) => setTimeout(r, 2500)),
  ]);
  // Re-render once the backend pointer is known so first API calls use it.
  root.render(<App />);
} catch { /* same-origin fallback */ }
