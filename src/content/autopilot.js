/*
 * OpenStealth — Auto-Pilot (Content Script)
 * 
 * Runs a passive monitoring loop every N seconds. Captures:
 *   - Text selections (implicit intent signals — highlight = "help me with this")
 *   - Page context snapshot
 *   - Sends AUTOPILOT_TICK to service worker for LLM processing
 * 
 * ZERO user interaction with the extension required.
 * No clicks, no typing, no mouse movements toward the sidebar.
 * The user just highlights text on the page and the AI responds.
 */

(() => {
  'use strict';

  // ─── Context Invalidation Guard ──────────────────────────────────────────
  let contextDead = false;

  function safeSendMessage(msg) {
    if (contextDead) return Promise.resolve();
    try {
      return chrome.runtime.sendMessage(msg).catch(handleContextError);
    } catch (e) {
      handleContextError(e);
      return Promise.resolve();
    }
  }

  function handleContextError(e) {
    if (e?.message?.includes?.('Extension context invalidated') ||
        e?.message?.includes?.('context invalidated')) {
      contextDead = true;
      cleanup();
    }
  }

  function cleanup() {
    contextDead = true;
    enabled = false;
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
    try { document.removeEventListener('selectionchange', onSelectionChange); } catch (e) { /* swallow */ }
  }

  // ─── State ───────────────────────────────────────────────────────────────
  let enabled = false;
  let intervalId = null;
  let intervalSec = 30;
  let selectionHistory = [];       // Rolling history of text highlights
  let lastSelectionText = '';      // Avoid duplicate selection captures
  let lastPageTextHash = '';       // Track page changes between ticks

  const MAX_SELECTION_HISTORY = 10;

  // ─── Selection Watcher ───────────────────────────────────────────────────
  // Listen for text selections passively — no clicks on our extension needed.
  // When the user highlights text, that's the implicit signal of intent.
  const onSelectionChange = () => {
    if (!enabled || contextDead) return;

    const sel = document.getSelection();
    const text = sel?.toString?.()?.trim();

    // Only capture meaningful selections (not empty, not the same as last)
    if (!text || text.length < 3 || text === lastSelectionText) return;

    lastSelectionText = text;

    // Get context around the selection
    const anchorNode = sel.anchorNode;
    const parentEl = anchorNode?.parentElement;

    const entry = {
      text: text.substring(0, 1000),
      timestamp: Date.now(),
      context: {
        parentTag: parentEl?.tagName?.toLowerCase() || null,
        parentText: parentEl?.textContent?.trim()?.substring(0, 500) || null,
        nearbyQuestion: findNearbyQuestion(parentEl),
      },
    };

    selectionHistory.push(entry);
    if (selectionHistory.length > MAX_SELECTION_HISTORY) {
      selectionHistory.shift();
    }
  };
  document.addEventListener('selectionchange', onSelectionChange, { passive: true });

  // ─── Find nearby question text (reused pattern from interaction-tracker) ─
  function findNearbyQuestion(el) {
    if (!el) return null;

    let current = el;
    for (let i = 0; i < 5; i++) {
      current = current.parentElement;
      if (!current || current === document.body) break;

      const text = current.textContent?.trim();
      if (!text) continue;

      // Look for question patterns
      if (/\?/.test(text) && text.length < 500) {
        return text.substring(0, 300);
      }
      // Look for elements that look like questions
      if (current.matches?.('h1, h2, h3, h4, h5, h6, [class*="question"], [class*="prompt"], label, legend, .problem-statement, .task-description')) {
        return text.substring(0, 300);
      }
    }
    return null;
  }

  // ─── Snapshot helper ─────────────────────────────────────────────────────
  function getVisibleText() {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          const tag = parent.tagName;
          if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK'].includes(tag)) {
            return NodeFilter.FILTER_REJECT;
          }
          const style = window.getComputedStyle(parent);
          if (style.display === 'none' || style.visibility === 'hidden') {
            return NodeFilter.FILTER_REJECT;
          }
          if (!node.textContent.trim()) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    const parts = [];
    let node;
    while ((node = walker.nextNode())) {
      parts.push(node.textContent.trim());
    }
    return parts.join(' ').substring(0, 5000);
  }

  function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const chr = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + chr;
      hash |= 0;
    }
    return hash.toString(36);
  }

  // ─── Tick: The Core Auto-Pilot Loop ──────────────────────────────────────
  function tick() {
    if (!enabled || contextDead) return;

    const pageText = getVisibleText();
    const pageHash = simpleHash(pageText);

    // Build the current selection context
    const recentSelections = selectionHistory
      .filter(s => Date.now() - s.timestamp < 120000) // Last 2 minutes
      .map(s => ({
        text: s.text,
        context: s.context?.nearbyQuestion || s.context?.parentText?.substring(0, 200) || null,
        ago: Math.round((Date.now() - s.timestamp) / 1000) + 's ago',
      }));

    const pageChanged = pageHash !== lastPageTextHash;
    lastPageTextHash = pageHash;

    // Always send the tick — let the service worker decide what to do.
    // The sidebar needs ticks to update the countdown and show responses.
    safeSendMessage({
      type: 'AUTOPILOT_TICK',
      data: {
        pageText: pageText.substring(0, 4000),
        pageTitle: document.title,
        pageUrl: window.location.href,
        pageChanged,
        recentSelections,
        currentSelection: lastSelectionText || null,
        timestamp: Date.now(),
      }
    });
  }

  // ─── Start / Stop ────────────────────────────────────────────────────────
  function start(sec) {
    if (intervalId) clearInterval(intervalId);
    intervalSec = sec || 30;
    enabled = true;
    intervalId = setInterval(tick, intervalSec * 1000);
    // Run first tick after a short delay (let page settle)
    setTimeout(tick, 3000);
  }

  function stop() {
    enabled = false;
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  // ─── Message Listener ────────────────────────────────────────────────────
  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (contextDead) return;
      if (msg.type === 'AUTOPILOT_START') {
        start(msg.intervalSec || 30);
        sendResponse({ enabled: true });
        return true;
      }
      if (msg.type === 'AUTOPILOT_STOP') {
        stop();
        sendResponse({ enabled: false });
        return true;
      }
      if (msg.type === 'AUTOPILOT_STATUS') {
        sendResponse({ enabled, intervalSec, selectionsTracked: selectionHistory.length });
        return true;
      }
    });
  } catch (e) { handleContextError(e); }

  // ─── Auto-start if previously enabled ────────────────────────────────────
  try {
    chrome.storage?.local?.get?.('settings').then(({ settings }) => {
      if (contextDead) return;
      if (settings?.autopilotEnabled) {
        start(settings.autopilotIntervalSec || 30);
      }
    }).catch(() => {});
  } catch (e) { handleContextError(e); }

  // NO console.log — complete radio silence
})();
