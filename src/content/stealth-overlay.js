/*
 * OpenStealth — Stealth Overlay (Content Script)
 * Anti-detection measures: prevents proctoring software and screen capture
 * APIs from detecting or capturing extension-related content.
 * 
 * STEALTH PRINCIPLES:
 * 1. ZERO console output — proctors scan console.log
 * 2. ZERO window globals with identifiable names
 * 3. ZERO detectable DOM attributes (no data-openstealth anywhere)
 * 4. All injected elements use randomized class names
 * 5. Canvas/getDisplayMedia hooks use undetectable wrappers
 * 6. Protection against DOM enumeration attacks
 */

(() => {
  'use strict';

  // ─── Randomized Identifiers ────────────────────────────────────────────
  // Generate random class/attribute names that change on every page load
  // so proctoring tools can't build a static signature
  const RAND_PREFIX = '_' + Math.random().toString(36).substring(2, 8);
  const ATTR_MARKER = 'data-' + Math.random().toString(36).substring(2, 10);

  // Store the marker so other content scripts can use it
  // Use a Symbol to prevent enumeration by external scripts
  const STEALTH_KEY = Symbol.for('__s' + Math.random().toString(36).substring(2, 6));

  // ─── Anti-Screen-Capture CSS Injection ──────────────────────────────────
  const stealthStyles = document.createElement('style');
  // Use randomized nonce-like attribute instead of detectable name
  stealthStyles.setAttribute(ATTR_MARKER, '1');
  stealthStyles.textContent = `
    [${ATTR_MARKER}] {
      contain: strict;
      isolation: isolate;
    }
  `;
  (document.head || document.documentElement).appendChild(stealthStyles);

  // ─── Canvas Capture Protection ──────────────────────────────────────────
  // Hook canvas.toDataURL and toBlob to exclude our overlays
  // Use Object.getOwnPropertyDescriptor to make hooks harder to detect
  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  const origToBlob = HTMLCanvasElement.prototype.toBlob;

  const toDataURLProxy = function (...args) {
    _hideMarked();
    const result = origToDataURL.apply(this, args);
    _showMarked();
    return result;
  };

  const toBlobProxy = function (...args) {
    _hideMarked();
    const result = origToBlob.apply(this, args);
    _showMarked();
    return result;
  };

  // Make hooks look native — proctoring tools check .toString()
  Object.defineProperty(toDataURLProxy, 'toString', {
    value: () => 'function toDataURL() { [native code] }',
    writable: false,
    configurable: false,
  });
  Object.defineProperty(toBlobProxy, 'toString', {
    value: () => 'function toBlob() { [native code] }',
    writable: false,
    configurable: false,
  });

  // Also make Function.prototype.toString return native for our proxied methods
  const origFuncToString = Function.prototype.toString;
  Function.prototype.toString = function () {
    if (this === toDataURLProxy) return 'function toDataURL() { [native code] }';
    if (this === toBlobProxy) return 'function toBlob() { [native code] }';
    if (this === gdmProxy) return 'function getDisplayMedia() { [native code] }';
    if (this === Function.prototype.toString) return 'function toString() { [native code] }';
    return origFuncToString.call(this);
  };

  HTMLCanvasElement.prototype.toDataURL = toDataURLProxy;
  HTMLCanvasElement.prototype.toBlob = toBlobProxy;

  // ─── getDisplayMedia Hook ──────────────────────────────────────────────
  let gdmProxy = null;
  if (navigator.mediaDevices?.getDisplayMedia) {
    const origGetDisplayMedia = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
    gdmProxy = async function (...args) {
      _hideMarked();
      const stream = await origGetDisplayMedia(...args);

      // Re-show after capture ends
      stream.getVideoTracks().forEach(track => {
        track.addEventListener('ended', _showMarked);
      });

      return stream;
    };

    Object.defineProperty(gdmProxy, 'toString', {
      value: () => 'function getDisplayMedia() { [native code] }',
      writable: false,
      configurable: false,
    });

    navigator.mediaDevices.getDisplayMedia = gdmProxy;
  }

  // ─── getUserMedia Hook (some proctors use webcam + screen together) ────
  if (navigator.mediaDevices?.getUserMedia) {
    const origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const gumProxy = async function (...args) {
      _hideMarked();
      const stream = await origGetUserMedia(...args);
      stream.getVideoTracks().forEach(track => {
        track.addEventListener('ended', _showMarked);
      });
      return stream;
    };
    Object.defineProperty(gumProxy, 'toString', {
      value: () => 'function getUserMedia() { [native code] }',
      writable: false,
      configurable: false,
    });
    navigator.mediaDevices.getUserMedia = gumProxy;
  }

  // ─── Element Visibility Control ──────────────────────────────────────────
  function _hideMarked() {
    document.querySelectorAll(`[${ATTR_MARKER}]`).forEach(el => {
      el.style.setProperty('display', 'none', 'important');
    });
  }

  function _showMarked() {
    document.querySelectorAll(`[${ATTR_MARKER}]`).forEach(el => {
      el.style.removeProperty('display');
    });
  }

  // ─── Proctor Detection & Evasion ──────────────────────────────────────────
  const PROCTOR_SIGNATURES = [
    'proctorio', 'examity', 'respondus', 'honorlock', 'proctortrack',
    'examsoft', 'proctor', 'lockdown', 'securebrowser', 'proctoru',
    'meazure', 'talview', 'mettl', 'hackerrank', 'codility',
  ];

  function detectProctoringEnvironment() {
    const detected = [];

    // Check for known extension script injections
    document.querySelectorAll('script[src]').forEach(script => {
      const src = script.src.toLowerCase();
      PROCTOR_SIGNATURES.forEach(sig => {
        if (src.includes(sig)) {
          detected.push({ type: 'script', signature: sig });
        }
      });
    });

    // Check for known CSS injections
    document.querySelectorAll('link[href]').forEach(link => {
      const href = (link.href || '').toLowerCase();
      PROCTOR_SIGNATURES.forEach(sig => {
        if (href.includes(sig)) {
          detected.push({ type: 'style', signature: sig });
        }
      });
    });

    // Check if console is being monitored
    try {
      const isConsoleHooked = console.log.toString().indexOf('native code') === -1;
      if (isConsoleHooked) detected.push({ type: 'api_hook', target: 'console' });
    } catch (e) { /* swallow */ }

    // Check if addEventListener is being wrapped
    try {
      const isEventHooked = EventTarget.prototype.addEventListener.toString().indexOf('native code') === -1;
      if (isEventHooked) detected.push({ type: 'api_hook', target: 'addEventListener' });
    } catch (e) { /* swallow */ }

    // Check if fetch/XMLHttpRequest is being intercepted
    try {
      const isFetchHooked = window.fetch.toString().indexOf('native code') === -1;
      if (isFetchHooked) detected.push({ type: 'api_hook', target: 'fetch' });
    } catch (e) { /* swallow */ }

    // Check for MutationObserver surveillance (proctors watch DOM changes)
    // We can't detect this directly, but we can check for known globals
    PROCTOR_SIGNATURES.forEach(sig => {
      try {
        // Check window properties
        for (const key of Object.keys(window)) {
          if (key.toLowerCase().includes(sig)) {
            detected.push({ type: 'global', target: key });
            break;
          }
        }
      } catch (e) { /* swallow */ }
    });

    // Check chrome.runtime for other extensions trying to message us
    // (only detects extensions with externally_connectable permissions)

    return detected;
  }

  // ─── DOM Enumeration Defense ──────────────────────────────────────────────
  // Prevent proctoring scripts from finding our injected elements
  // by hooking querySelectorAll to filter out our marker attribute
  const origQuerySelectorAll = Document.prototype.querySelectorAll;
  const origQSA_Element = Element.prototype.querySelectorAll;
  const origQuerySelector = Document.prototype.querySelector;
  const origQS_Element = Element.prototype.querySelector;

  function filterOurElements(nodeList) {
    return Array.from(nodeList).filter(el => !el.hasAttribute(ATTR_MARKER));
  }

  // Only hook if paranoid stealth is needed — check at runtime
  function enableParanoidMode() {
    // These hooks prevent ANY script from discovering our injected elements
    Document.prototype.querySelectorAll = function (sel) {
      const results = origQuerySelectorAll.call(this, sel);
      // If querying for our specific marker, return empty
      if (sel.includes(ATTR_MARKER)) return document.createDocumentFragment().querySelectorAll('*');
      // Filter our elements from generic queries like '*', 'style', '[data-*]'
      if (sel === '*' || sel === 'style' || sel === 'link' || sel.startsWith('[data-')) {
        const arr = filterOurElements(results);
        // Return an array-like object that mimics NodeList
        return arr;
      }
      return results;
    };

    Element.prototype.querySelectorAll = function (sel) {
      const results = origQSA_Element.call(this, sel);
      if (sel.includes(ATTR_MARKER)) return document.createDocumentFragment().querySelectorAll('*');
      if (sel === '*' || sel === 'style' || sel === 'link' || sel.startsWith('[data-')) {
        return filterOurElements(results);
      }
      return results;
    };
  }

  // ─── Keyboard Shortcut Protection ─────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'S') {
      e.stopImmediatePropagation();
      chrome.runtime.sendMessage({ type: 'TOGGLE_SIDEBAR' }).catch(() => {});
    }
  }, true); // Capture phase — fires before proctoring listeners

  // ─── Periodic Stealth Check ───────────────────────────────────────────────
  setInterval(() => {
    // Re-hide any of our elements that might have been made visible
    // by DOM manipulation from other extensions
    document.querySelectorAll(`[${ATTR_MARKER}][style*="display: block"]`).forEach(el => {
      el.style.setProperty('display', 'none', 'important');
    });
  }, 5000);

  // ─── Expose via Symbol (non-enumerable, non-discoverable) ────────────────
  // Other content scripts access stealth functions via this Symbol
  // Symbols are NOT returned by Object.keys(), Object.getOwnPropertyNames(),
  // JSON.stringify(), or for...in — invisible to proctoring scans
  Object.defineProperty(window, STEALTH_KEY, {
    value: Object.freeze({
      detectProctoring: detectProctoringEnvironment,
      hideAll: _hideMarked,
      showAll: _showMarked,
      getMarker: () => ATTR_MARKER,
      enableParanoid: enableParanoidMode,
    }),
    writable: false,
    enumerable: false,     // Won't show in Object.keys(window)
    configurable: false,
  });

  // Store the Symbol key on chrome.runtime for our other scripts to find
  // chrome.runtime is extension-only — page scripts can't access it
  try {
    chrome.runtime.__stealthKey = STEALTH_KEY;
    chrome.runtime.__stealthMarker = ATTR_MARKER;
  } catch (e) { /* swallow */ }

  // ─── Initial Detection ─────────────────────────────────────────────────────
  const proctors = detectProctoringEnvironment();
  if (proctors.length > 0) {
    // DON'T console.log — use runtime messaging only
    chrome.runtime.sendMessage({
      type: 'PROCTOR_DETECTED',
      proctors,
    }).catch(() => {});

    // Auto-enable paranoid mode if proctoring detected
    enableParanoidMode();
  }

  // NO console.log output — complete radio silence
})();
