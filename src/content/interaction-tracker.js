/*
 * OpenStealth — User Interaction Tracker (Content Script)
 * Tracks the user's last meaningful interaction to determine what they want
 * the AI to focus on. Tracks: clicks, selections, cursor position, typing.
 */

(() => {
  'use strict';

  // ─── Context Invalidation Guard ──────────────────────────────────────────
  let contextDead = false;

  function isContextValid() {
    try {
      return !!chrome.runtime?.id;
    } catch (e) {
      return false;
    }
  }

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

  // Event listener references for cleanup
  const listeners = [];
  function addTrackedListener(target, event, handler, opts) {
    target.addEventListener(event, handler, opts);
    listeners.push({ target, event, handler, opts });
  }

  function cleanup() {
    contextDead = true;
    clearTimeout(typingTimer);
    clearTimeout(hoverTimer);
    for (const { target, event, handler, opts } of listeners) {
      try { target.removeEventListener(event, handler, opts); } catch (e) { /* swallow */ }
    }
    listeners.length = 0;
  }

  // ─── Stealth Helper ──────────────────────────────────────────────────────
  // Check if an element belongs to us using the dynamic marker from stealth-overlay
  function isOurElement(el) {
    try {
      const marker = chrome.runtime.__stealthMarker;
      if (marker && el?.closest?.(`[${marker}]`)) return true;
    } catch (e) { /* swallow */ }
    return false;
  }

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
  const onClickCapture = (e) => {
    if (contextDead) return;
    const el = e.target;
    if (isOurElement(el)) return;

    lastInteraction = {
      type: 'click',
      element: el,
      elementInfo: getElementInfo(el),
      text: null,
      timestamp: Date.now(),
      position: { x: e.clientX, y: e.clientY },
    };
    broadcastInteraction();
  };
  addTrackedListener(document, 'click', onClickCapture, true);

  // Text Selection
  const onSelectionChange = () => {
    if (contextDead) return;
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
  };
  addTrackedListener(document, 'selectionchange', onSelectionChange);

  // Focus (entering input fields)
  const onFocusInCapture = (e) => {
    if (contextDead) return;
    const el = e.target;
    if (isOurElement(el)) return;
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
  };
  addTrackedListener(document, 'focusin', onFocusInCapture, true);

  // Typing in inputs
  let typingTimer = null;
  const onInputCapture = (e) => {
    if (contextDead) return;
    const el = e.target;
    if (isOurElement(el)) return;

    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      if (contextDead) return;
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
  };
  addTrackedListener(document, 'input', onInputCapture, true);

  // Mouse hover (for images etc)
  let hoverTimer = null;
  const onMouseOverCapture = (e) => {
    if (contextDead) return;
    const el = e.target;
    if (isOurElement(el)) return;

    // Only track hover on meaningful elements
    const isInteresting = el.tagName === 'IMG' || el.tagName === 'CANVAS' || 
                          el.tagName === 'VIDEO' || el.tagName === 'SVG' ||
                          el.closest?.('[class*="question"]') ||
                          el.closest?.('[class*="slide"]');
    if (!isInteresting) return;

    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      if (contextDead) return;
      lastInteraction = {
        type: 'hover',
        element: el,
        elementInfo: getElementInfo(el),
        text: null,
        timestamp: Date.now(),
        position: { x: e.clientX, y: e.clientY },
      };
      // Store on chrome.runtime only (invisible to page scripts)
      try {
        chrome.runtime.__lastInteraction = serializeInteraction(lastInteraction);
      } catch (e) { /* swallow */ }
    }, 1000); // Only if they hover for 1s
  };
  addTrackedListener(document, 'mouseover', onMouseOverCapture, true);

  // ─── Broadcast ────────────────────────────────────────────────────────────
  function broadcastInteraction() {
    if (contextDead) return;
    const serialized = serializeInteraction(lastInteraction);
    
    // Store on chrome.runtime (extension-only, invisible to page scripts)
    try {
      chrome.runtime.__lastInteraction = serialized;
    } catch (e) { /* swallow */ }

    safeSendMessage({
      type: 'USER_INTERACTION',
      interaction: serialized,
    });
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

  // NO window globals — use chrome.runtime for inter-script communication
  // chrome.runtime is isolated to our extension and invisible to page scripts
  try {
    chrome.runtime.__interactions = {
      getLast: () => serializeInteraction(lastInteraction),
      getLastElement: () => lastInteraction.element,
    };
  } catch (e) { /* swallow */ }

  // NO console.log — complete radio silence
})();
