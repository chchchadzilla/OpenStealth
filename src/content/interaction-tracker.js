/*
 * OpenStealth — User Interaction Tracker (Content Script)
 * Tracks the user's last meaningful interaction to determine what they want
 * the AI to focus on. Tracks: clicks, selections, cursor position, typing.
 */

(() => {
  'use strict';

  // ─── State ───────────────────────────────────────────────────────────────
  let lastInteraction = {
    type: null,
    element: null,
    elementInfo: null,
    text: null,
    timestamp: 0,
    position: { x: 0, y: 0 },
  };

  // ─── Element Info Extractor ──────────────────────────────────────────────
  function getElementInfo(el) {
    if (!el) return null;

    const tag = el.tagName?.toLowerCase();
    const rect = el.getBoundingClientRect?.();
    const computedStyle = window.getComputedStyle?.(el);

    return {
      tag,
      id: el.id || null,
      className: el.className?.toString?.()?.substring(0, 200) || null,
      type: el.type || null,
      role: el.getAttribute?.('role') || null,
      ariaLabel: el.getAttribute?.('aria-label') || null,
      placeholder: el.placeholder || null,
      name: el.name || null,
      value: el.value?.substring?.(0, 500) || null,
      textContent: el.textContent?.trim()?.substring(0, 500) || null,
      innerText: el.innerText?.trim()?.substring(0, 500) || null,
      src: el.src || null,
      alt: el.alt || null,
      href: el.href || null,
      isInput: ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName),
      isEditable: el.isContentEditable || el.tagName === 'TEXTAREA' || 
                  (el.tagName === 'INPUT' && !['hidden', 'submit', 'button'].includes(el.type)),
      rect: rect ? {
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      } : null,
      // Get surrounding context
      parentText: el.parentElement?.textContent?.trim()?.substring(0, 300) || null,
      // For form elements, find the associated label
      label: findLabel(el),
      // Nearby question text
      nearbyQuestion: findNearbyQuestion(el),
    };
  }

  function findLabel(el) {
    // Check for explicit label
    if (el.id) {
      const label = document.querySelector(`label[for="${el.id}"]`);
      if (label) return label.textContent.trim();
    }
    // Check for wrapping label
    const parentLabel = el.closest?.('label');
    if (parentLabel) return parentLabel.textContent.trim();
    // Check for aria-labelledby
    const labelledBy = el.getAttribute?.('aria-labelledby');
    if (labelledBy) {
      const labelEl = document.getElementById(labelledBy);
      if (labelEl) return labelEl.textContent.trim();
    }
    return null;
  }

  function findNearbyQuestion(el) {
    if (!el) return null;

    // Walk up and look for question-like text
    let current = el;
    for (let i = 0; i < 5; i++) {
      current = current.parentElement;
      if (!current || current === document.body) break;

      const text = current.textContent?.trim();
      if (!text) continue;

      // Check if this looks like a question container
      if (text.includes('?') || 
          current.querySelector?.('h1,h2,h3,h4,h5,h6,label,.question,[class*="question"],[class*="prompt"]')) {
        // Find the question text specifically
        const questionEl = current.querySelector?.('h1,h2,h3,h4,h5,h6,label,.question,[class*="question"],[class*="prompt"],p:first-of-type');
        if (questionEl) {
          return questionEl.textContent.trim().substring(0, 500);
        }
        // If the parent itself is small enough, use its text
        if (text.length < 500) {
          return text;
        }
      }
    }
    return null;
  }

  // ─── Event Handlers ──────────────────────────────────────────────────────

  // Click
  document.addEventListener('click', (e) => {
    const el = e.target;
    if (el.closest?.('[data-openstealth]')) return;

    lastInteraction = {
      type: 'click',
      element: el,
      elementInfo: getElementInfo(el),
      text: null,
      timestamp: Date.now(),
      position: { x: e.clientX, y: e.clientY },
    };
    broadcastInteraction();
  }, true);

  // Text Selection
  document.addEventListener('selectionchange', () => {
    const selection = window.getSelection();
    const text = selection?.toString()?.trim();
    if (!text || text.length < 3) return;

    const range = selection.getRangeAt?.(0);
    const el = range?.commonAncestorContainer;
    const element = el?.nodeType === 3 ? el.parentElement : el;

    lastInteraction = {
      type: 'selection',
      element,
      elementInfo: getElementInfo(element),
      text: text.substring(0, 2000),
      timestamp: Date.now(),
      position: { x: 0, y: 0 },
    };
    broadcastInteraction();
  });

  // Focus (entering input fields)
  document.addEventListener('focusin', (e) => {
    const el = e.target;
    if (el.closest?.('[data-openstealth]')) return;
    if (!el.tagName) return;

    const isInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable;
    if (!isInput) return;

    lastInteraction = {
      type: 'focus',
      element: el,
      elementInfo: getElementInfo(el),
      text: el.value || el.textContent || null,
      timestamp: Date.now(),
      position: { x: 0, y: 0 },
    };
    broadcastInteraction();
  }, true);

  // Typing in inputs
  let typingTimer = null;
  document.addEventListener('input', (e) => {
    const el = e.target;
    if (el.closest?.('[data-openstealth]')) return;

    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      lastInteraction = {
        type: 'typing',
        element: el,
        elementInfo: getElementInfo(el),
        text: el.value || el.textContent || null,
        timestamp: Date.now(),
        position: { x: 0, y: 0 },
      };
      broadcastInteraction();
    }, 800); // Debounce typing
  }, true);

  // Mouse hover (for images etc)
  let hoverTimer = null;
  document.addEventListener('mouseover', (e) => {
    const el = e.target;
    if (el.closest?.('[data-openstealth]')) return;

    // Only track hover on meaningful elements
    const isInteresting = el.tagName === 'IMG' || el.tagName === 'CANVAS' || 
                          el.tagName === 'VIDEO' || el.tagName === 'SVG' ||
                          el.closest?.('[class*="question"]') ||
                          el.closest?.('[class*="slide"]');
    if (!isInteresting) return;

    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      lastInteraction = {
        type: 'hover',
        element: el,
        elementInfo: getElementInfo(el),
        text: null,
        timestamp: Date.now(),
        position: { x: e.clientX, y: e.clientY },
      };
      // Don't broadcast hover — only store it
      window.__openstealth_lastInteraction = serializeInteraction(lastInteraction);
    }, 1000); // Only if they hover for 1s
  }, true);

  // ─── Broadcast ────────────────────────────────────────────────────────────
  function broadcastInteraction() {
    const serialized = serializeInteraction(lastInteraction);
    window.__openstealth_lastInteraction = serialized;

    chrome.runtime.sendMessage({
      type: 'USER_INTERACTION',
      interaction: serialized,
    }).catch(() => {});
  }

  function serializeInteraction(interaction) {
    return {
      type: interaction.type,
      elementInfo: interaction.elementInfo,
      text: interaction.text,
      timestamp: interaction.timestamp,
      position: interaction.position,
    };
  }

  // ─── Public API ───────────────────────────────────────────────────────────
  window.__openstealth_interactions = {
    getLast: () => serializeInteraction(lastInteraction),
    getLastElement: () => lastInteraction.element,
  };

  console.log('[OpenStealth] Interaction tracker active');
})();
