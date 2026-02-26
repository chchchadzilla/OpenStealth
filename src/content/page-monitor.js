/*
 * OpenStealth — Page Monitor (Content Script)
 * Watches for meaningful DOM changes: slideshow transitions, new content loads,
 * image swaps, and significant text changes.
 * 
 * Avoids firing on trivial changes (CSS animations, scroll positions, tiny text edits).
 */

(() => {
  'use strict';

  // ─── Config ──────────────────────────────────────────────────────────────
  const CONFIG = {
    DEBOUNCE_MS: 2000,
    MIN_TEXT_CHANGE_RATIO: 0.25,       // 25% of visible text must change
    MIN_TEXT_LENGTH: 50,                // Minimum chars to consider "meaningful"
    MUTATION_BATCH_MS: 500,            // Batch mutations for this long
    IGNORE_TAGS: new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK', 'BR', 'HR']),
    SLIDESHOW_SELECTORS: [
      '.slide', '.swiper-slide', '.carousel-item', '.slick-slide',
      '[class*="slide"]', '[class*="carousel"]', '[role="tabpanel"]',
      '.reveal .slides section', // reveal.js
      '.step', '.present',
    ],
    IMAGE_SELECTORS: [
      'img', 'canvas', 'video', 'svg', '[style*="background-image"]',
    ],
  };

  // ─── State ───────────────────────────────────────────────────────────────
  let lastSnapshot = null;
  let debounceTimer = null;
  let mutationBatch = [];
  let batchTimer = null;
  let observer = null;
  let isEnabled = true;

  // ─── Snapshot ────────────────────────────────────────────────────────────
  function takeSnapshot() {
    const body = document.body;
    if (!body) return null;

    // Get visible text content
    const textContent = getVisibleText(body);

    // Get all visible images
    const images = Array.from(document.querySelectorAll('img:not([hidden])')).map(img => ({
      src: img.src || img.dataset?.src || '',
      alt: img.alt || '',
      width: img.naturalWidth,
      height: img.naturalHeight,
    })).filter(img => img.src && img.width > 50 && img.height > 50);

    // Check for active slides
    const activeSlide = findActiveSlide();

    // Get page title and URL
    const meta = {
      title: document.title,
      url: window.location.href,
      timestamp: Date.now(),
    };

    return {
      text: textContent,
      textHash: simpleHash(textContent),
      images,
      imageHashes: images.map(i => i.src).join('|'),
      activeSlide,
      meta,
    };
  }

  function getVisibleText(root) {
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (CONFIG.IGNORE_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
          
          // Check visibility
          const style = window.getComputedStyle(parent);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
            return NodeFilter.FILTER_REJECT;
          }

          const text = node.textContent.trim();
          if (!text) return NodeFilter.FILTER_REJECT;

          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    const parts = [];
    let node;
    while ((node = walker.nextNode())) {
      parts.push(node.textContent.trim());
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  function findActiveSlide() {
    for (const sel of CONFIG.SLIDESHOW_SELECTORS) {
      try {
        // Look for active/current slide
        const activeVariants = [
          `${sel}.active`, `${sel}.current`, `${sel}.present`,
          `${sel}[aria-current="true"]`, `${sel}[aria-selected="true"]`,
          `${sel}:not([aria-hidden="true"])`,
        ];
        for (const variant of activeVariants) {
          const el = document.querySelector(variant);
          if (el) {
            return {
              selector: variant,
              text: getVisibleText(el).substring(0, 500),
              html: el.innerHTML.substring(0, 2000),
              index: Array.from(el.parentElement?.children || []).indexOf(el),
            };
          }
        }
      } catch (e) {
        // Invalid selector, skip
      }
    }
    return null;
  }

  // ─── Change Detection ────────────────────────────────────────────────────
  function detectSignificantChange(oldSnap, newSnap) {
    if (!oldSnap || !newSnap) return null;

    const changes = [];

    // 1. Text content change
    if (oldSnap.textHash !== newSnap.textHash) {
      const ratio = textChangeRatio(oldSnap.text, newSnap.text);
      if (ratio >= CONFIG.MIN_TEXT_CHANGE_RATIO && newSnap.text.length >= CONFIG.MIN_TEXT_LENGTH) {
        changes.push({
          type: 'text_change',
          ratio,
          isVisualChange: false,
          description: `Text content changed (${Math.round(ratio * 100)}% different)`,
        });
      }
    }

    // 2. Image change
    if (oldSnap.imageHashes !== newSnap.imageHashes) {
      const oldSrcs = new Set(oldSnap.images.map(i => i.src));
      const newSrcs = newSnap.images.map(i => i.src);
      const newImages = newSrcs.filter(s => !oldSrcs.has(s));

      if (newImages.length > 0) {
        changes.push({
          type: 'image_change',
          newImages,
          count: newImages.length,
          isVisualChange: true,
          description: `${newImages.length} new image(s) detected`,
        });
      }
    }

    // 3. Slide change
    if (oldSnap.activeSlide && newSnap.activeSlide) {
      if (oldSnap.activeSlide.index !== newSnap.activeSlide.index ||
          oldSnap.activeSlide.text !== newSnap.activeSlide.text) {
        changes.push({
          type: 'slide_change',
          fromIndex: oldSnap.activeSlide.index,
          toIndex: newSnap.activeSlide.index,
          slideContent: newSnap.activeSlide.text,
          isVisualChange: true,
          description: `Slide changed (${oldSnap.activeSlide.index} → ${newSnap.activeSlide.index})`,
        });
      }
    }

    // 4. URL change (SPA navigation)
    if (oldSnap.meta.url !== newSnap.meta.url) {
      changes.push({
        type: 'navigation',
        from: oldSnap.meta.url,
        to: newSnap.meta.url,
        isVisualChange: true,
        description: 'Page navigated',
      });
    }

    return changes.length > 0 ? changes : null;
  }

  function textChangeRatio(oldText, newText) {
    if (!oldText && !newText) return 0;
    if (!oldText || !newText) return 1;

    // Simple character-level change ratio (fast)
    const maxLen = Math.max(oldText.length, newText.length);
    if (maxLen === 0) return 0;

    let same = 0;
    const minLen = Math.min(oldText.length, newText.length);
    for (let i = 0; i < minLen; i++) {
      if (oldText[i] === newText[i]) same++;
    }
    return 1 - (same / maxLen);
  }

  function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash;
  }

  // ─── Mutation Observer ────────────────────────────────────────────────────
  function startObserving() {
    if (observer) observer.disconnect();

    observer = new MutationObserver((mutations) => {
      if (!isEnabled) return;

      // Filter out noise
      const meaningful = mutations.filter(m => {
        // Ignore attribute changes on body/html (scroll etc.)
        if (m.type === 'attributes' && (m.target === document.body || m.target === document.documentElement)) {
          return false;
        }
        // Ignore our own injected elements (uses dynamic marker from stealth-overlay)
        const marker = chrome.runtime?.__stealthMarker;
        if (marker && m.target.closest?.(`[${marker}]`)) return false;
        // Ignore hidden elements
        if (m.target.nodeType === 1) {
          const style = window.getComputedStyle(m.target);
          if (style?.display === 'none') return false;
        }
        return true;
      });

      if (meaningful.length === 0) return;

      // Batch mutations
      mutationBatch.push(...meaningful);
      clearTimeout(batchTimer);
      batchTimer = setTimeout(processMutationBatch, CONFIG.MUTATION_BATCH_MS);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['src', 'class', 'style', 'aria-current', 'aria-selected', 'aria-hidden'],
    });
  }

  function processMutationBatch() {
    const batch = mutationBatch.splice(0);
    if (batch.length < 3) return; // Too few mutations to be meaningful

    // Debounce the actual change detection
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      checkForChanges();
    }, CONFIG.DEBOUNCE_MS);
  }

  function checkForChanges() {
    const newSnapshot = takeSnapshot();
    const changes = detectSignificantChange(lastSnapshot, newSnapshot);

    if (changes) {
      const isVisualChange = changes.some(c => c.isVisualChange);
      const description = changes.map(c => c.description).join('; ');

      // Get page context for the LLM
      const context = {
        changes,
        isVisualChange,
        description,
        pageText: newSnapshot.text.substring(0, 5000),
        activeSlide: newSnapshot.activeSlide,
        images: newSnapshot.images.slice(0, 10),
        meta: newSnapshot.meta,
        userInteraction: chrome.runtime.__lastInteraction || null,
      };

      // Send to background
      chrome.runtime.sendMessage({
        type: 'SIGNIFICANT_CHANGE',
        context,
      }).catch(() => {});

      // Also notify sidebar
      chrome.runtime.sendMessage({
        type: 'AUTO_CHANGE_DETECTED',
        description,
      }).catch(() => {});
    }

    lastSnapshot = newSnapshot;
  }

  // ─── URL Change Detection (SPA) ──────────────────────────────────────────
  let lastUrl = window.location.href;

  function watchUrlChanges() {
    // Override pushState/replaceState
    const origPushState = history.pushState;
    const origReplaceState = history.replaceState;

    history.pushState = function (...args) {
      origPushState.apply(this, args);
      onUrlChange();
    };
    history.replaceState = function (...args) {
      origReplaceState.apply(this, args);
      onUrlChange();
    };

    window.addEventListener('popstate', onUrlChange);
    window.addEventListener('hashchange', onUrlChange);
  }

  function onUrlChange() {
    const newUrl = window.location.href;
    if (newUrl !== lastUrl) {
      lastUrl = newUrl;
      // Delay to let the page render
      setTimeout(checkForChanges, 1500);
    }
  }

  // ─── Message Handler ──────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'GET_PAGE_CONTEXT') {
      const snapshot = takeSnapshot();
      sendResponse({
        text: snapshot?.text?.substring(0, 8000),
        images: snapshot?.images?.slice(0, 10),
        meta: snapshot?.meta,
        activeSlide: snapshot?.activeSlide,
        interaction: chrome.runtime.__lastInteraction || null,
      });
      return true;
    }

    if (msg.type === 'TOGGLE_MONITOR') {
      isEnabled = msg.enabled;
      sendResponse({ enabled: isEnabled });
      return true;
    }
  });

  // ─── Bootstrap ────────────────────────────────────────────────────────────
  function boot() {
    lastSnapshot = takeSnapshot();
    startObserving();
    watchUrlChanges();
    // NO console.log — complete radio silence
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Expose for other content scripts via chrome.runtime (extension-only, invisible to page)
  try {
    chrome.runtime.__pageMonitor = {
      takeSnapshot,
      checkForChanges,
      setEnabled: (v) => { isEnabled = v; },
    };
  } catch (e) { /* swallow */ }

})();
