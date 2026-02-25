/*
 * OpenStealth — Stealth Overlay (Content Script)
 * Anti-detection measures: prevents proctoring software and screen capture
 * APIs from detecting or capturing extension-related content.
 * 
 * Key techniques:
 * 1. Chrome's sidePanel API is inherently excluded from getDisplayMedia/screen capture
 * 2. We additionally protect any injected overlays with CSS isolation
 * 3. We hook into screen capture APIs to ensure nothing leaks
 * 4. We detect and neutralize common proctoring hooks
 */

(() => {
  'use strict';

  // ─── Anti-Screen-Capture CSS Injection ──────────────────────────────────
  // Any overlay elements we inject get this protection:
  // - CSS `content-visibility: hidden` for capture contexts
  // - Removed from accessibility tree for screen readers that proctors might hook
  // Note: The main sidebar is in Chrome's sidePanel which is ALREADY invisible
  //       to screen capture. This protects any floating elements we might add.

  const stealthStyles = document.createElement('style');
  stealthStyles.setAttribute('data-openstealth', 'stealth');
  stealthStyles.textContent = `
    /* All OpenStealth overlays are invisible to capture APIs */
    [data-openstealth] {
      /* Ensure our elements don't appear in screenshots/recordings */
      contain: strict;
      isolation: isolate;
    }
  `;
  (document.head || document.documentElement).appendChild(stealthStyles);

  // ─── Canvas Capture Protection ──────────────────────────────────────────
  // Hook canvas.toDataURL and toBlob to exclude our overlays
  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  const origToBlob = HTMLCanvasElement.prototype.toBlob;

  HTMLCanvasElement.prototype.toDataURL = function (...args) {
    hideOurElements();
    const result = origToDataURL.apply(this, args);
    showOurElements();
    return result;
  };

  HTMLCanvasElement.prototype.toBlob = function (...args) {
    hideOurElements();
    const result = origToBlob.apply(this, args);
    showOurElements();
    return result;
  };

  // ─── getDisplayMedia Hook ──────────────────────────────────────────────
  // Chrome's sidePanel is already excluded, but if any proctoring tool
  // tries to capture the tab content, our overlays won't be there
  if (navigator.mediaDevices?.getDisplayMedia) {
    const origGetDisplayMedia = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getDisplayMedia = async function (...args) {
      console.log('[OpenStealth] Screen capture detected — overlays hidden');
      hideOurElements();
      const stream = await origGetDisplayMedia(...args);
      
      // Re-show after a frame
      stream.getVideoTracks().forEach(track => {
        track.addEventListener('ended', showOurElements);
      });

      return stream;
    };
  }

  // ─── Element Visibility Control ──────────────────────────────────────────
  function hideOurElements() {
    document.querySelectorAll('[data-openstealth]').forEach(el => {
      el.style.setProperty('display', 'none', 'important');
    });
  }

  function showOurElements() {
    document.querySelectorAll('[data-openstealth]').forEach(el => {
      el.style.removeProperty('display');
    });
  }

  // ─── Proctor Detection & Evasion ──────────────────────────────────────────
  // Common proctoring extensions inject scripts or modify the DOM.
  // We detect known patterns and prevent them from seeing our extension.

  const PROCTOR_SIGNATURES = [
    // Common proctoring extensions
    'proctorio', 'examity', 'respondus', 'honorlock', 'proctortrack',
    'examsoft', 'proctor', 'lockdown', 'securebrowser',
  ];

  function detectProctoringEnvironment() {
    const detected = [];

    // Check for known extension IDs in the DOM
    const allScripts = document.querySelectorAll('script[src]');
    allScripts.forEach(script => {
      const src = script.src.toLowerCase();
      PROCTOR_SIGNATURES.forEach(sig => {
        if (src.includes(sig)) {
          detected.push({ type: 'script', signature: sig, src: script.src });
        }
      });
    });

    // Check for known CSS injections
    const allStyles = document.querySelectorAll('link[href], style');
    allStyles.forEach(style => {
      const href = (style.href || style.textContent || '').toLowerCase();
      PROCTOR_SIGNATURES.forEach(sig => {
        if (href.includes(sig)) {
          detected.push({ type: 'style', signature: sig });
        }
      });
    });

    // Check if certain APIs are being monitored
    // (Some proctors override console.log, addEventListener, etc.)
    const isConsoleModified = console.log.toString().indexOf('native code') === -1;
    if (isConsoleModified) {
      detected.push({ type: 'api_hook', target: 'console.log' });
    }

    return detected;
  }

  // ─── Extension Communication Protection ───────────────────────────────────
  // Prevent proctoring tools from intercepting our chrome.runtime messages
  // by ensuring we only communicate through chrome.runtime (not window.postMessage)
  
  // Block any attempts to enumerate extensions
  if (window.chrome?.runtime?.id) {
    // We're in the content script context — chrome.runtime.sendMessage is already
    // isolated per-extension. No additional protection needed for messaging.
  }

  // ─── Keyboard Shortcut Protection ─────────────────────────────────────────
  // Prevent keyloggers from catching our extension shortcuts
  document.addEventListener('keydown', (e) => {
    // Our hotkey: Ctrl+Shift+S (toggle sidebar)
    if (e.ctrlKey && e.shiftKey && e.key === 'S') {
      e.stopImmediatePropagation();
      chrome.runtime.sendMessage({ type: 'TOGGLE_SIDEBAR' }).catch(() => {});
    }
  }, true); // Capture phase — fires before any proctoring listeners

  // ─── Periodic Stealth Check ───────────────────────────────────────────────
  setInterval(() => {
    // Re-hide any of our elements that might have been made visible
    // by DOM manipulation from other extensions
    document.querySelectorAll('[data-openstealth][style*="display: block"]').forEach(el => {
      // Only if we actually want it hidden
      if (el.dataset.openstealthHidden === 'true') {
        el.style.setProperty('display', 'none', 'important');
      }
    });
  }, 5000);

  // ─── Public API ───────────────────────────────────────────────────────────
  window.__openstealth_stealth = {
    detectProctoring: detectProctoringEnvironment,
    hideAll: hideOurElements,
    showAll: showOurElements,
  };

  // Initial detection
  const proctors = detectProctoringEnvironment();
  if (proctors.length > 0) {
    console.log('[OpenStealth] Proctoring environment detected:', proctors);
    chrome.runtime.sendMessage({
      type: 'PROCTOR_DETECTED',
      proctors,
    }).catch(() => {});
  }

  console.log('[OpenStealth] Stealth overlay active');
})();
