/**
 * DeepMT system console — a small in-memory event log that powers the
 * "terminal" panel. Records process-level events (engine connectivity, chat
 * lifecycle, tool calls, token usage) and live-broadcasts them to any SSE
 * subscribers. Nothing here is persisted; it is a ring buffer.
 */
const { EventEmitter } = require('node:events');

const MAX_EVENTS = 400;
const HISTORY_LIMIT = 250;

const ring = [];
const bus = new EventEmitter();
bus.setMaxListeners(0);

/**
 * Appends an event and wakes waiting SSE clients.
 *   kind — 'system' | 'engines' | 'chat' | 'tool' | 'tokens' | 'errors'
 *   data — { level?, message, ...extra }
 */
function logEvent(kind, data) {
  const event = {
    id: (ring.length ? ring[ring.length - 1].id + 1 : 1),
    t: new Date().toISOString(),
    ms: Date.now(),
    kind,
    ...data,
  };
  ring.push(event);
  if (ring.length > MAX_EVENTS) ring.splice(0, ring.length - MAX_EVENTS);
  bus.emit('event', event);
  return event;
}

/** Snapshot of the most recent events (oldest -> newest). */
function recentEvents(limit = HISTORY_LIMIT) {
  return ring.slice(-limit);
}

/** Subscribes a listener to new events; returns an unsubscribe function. */
function onEvent(listener) {
  bus.on('event', listener);
  return () => bus.off('event', listener);
}

module.exports = { logEvent, recentEvents, onEvent };