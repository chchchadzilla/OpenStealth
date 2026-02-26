/*
 * OpenStealth — Human Typer (Content Script)
 * Types highlighted LLM response text into the focused page element with
 * ultra-realistic human-like behavior: variable speed, typos that get
 * backspaced, stutters, pauses, micro-hesitations, and burst typing.
 *
 * Takeover detection: if the user types, clicks, or otherwise interacts
 * while the typer is active, it immediately yields control.
 */

(() => {
  'use strict';

  // ─── Adjacent-key typo map ────────────────────────────────────────────────
  const TYPO_MAP = {
    'a': ['s','q','w','z'],     'b': ['v','n','g','h'],
    'c': ['x','v','d','f'],     'd': ['s','f','e','r','c','x'],
    'e': ['w','r','d','s'],     'f': ['d','g','r','t','v','c'],
    'g': ['f','h','t','y','b','v'], 'h': ['g','j','y','u','n','b'],
    'i': ['u','o','k','j'],     'j': ['h','k','u','i','n','m'],
    'k': ['j','l','i','o','m'], 'l': ['k',';','o','p'],
    'm': ['n',',','j','k'],     'n': ['b','m','h','j'],
    'o': ['i','p','l','k'],     'p': ['o','[',';','l'],
    'q': ['w','a','1','2'],     'r': ['e','t','f','d'],
    's': ['a','d','w','e','x','z'], 't': ['r','y','g','f'],
    'u': ['y','i','j','h'],     'v': ['c','b','f','g'],
    'w': ['q','e','s','a'],     'x': ['z','c','s','d'],
    'y': ['t','u','h','g'],     'z': ['x','a','s'],
    '1': ['2','q'],  '2': ['1','3','w','q'],  '3': ['2','4','e','w'],
    '4': ['3','5','r','e'],  '5': ['4','6','t','r'],  '6': ['5','7','y','t'],
    '7': ['6','8','u','y'],  '8': ['7','9','i','u'],  '9': ['8','0','o','i'],
    '0': ['9','-','p','o'],
  };

  // Common double-type errors (hitting a key twice)
  const DOUBLE_TYPE_CHARS = new Set(['l','s','t','e','o','r','n']);

  // ─── State ────────────────────────────────────────────────────────────────
  let isTyping = false;
  let abortController = null;
  let targetElement = null;
  let expectedValue = ''; // What the value SHOULD be at each step
  let lastFocusedInput = null; // Track the last input the user focused on the PAGE

  // ─── Last-Focused Input Tracker ───────────────────────────────────────────
  // When the user clicks "▶ Start" in the sidebar, browser focus moves to the
  // sidebar panel, so document.activeElement in the page becomes <body>.
  // We pre-record the last legitimate input element the user focused so we
  // can type into it even after the sidebar steals focus.
  function isValidTypingTarget(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return true;
    if (el.isContentEditable) return true;
    return false;
  }

  document.addEventListener('focusin', (e) => {
    if (isValidTypingTarget(e.target)) {
      lastFocusedInput = e.target;
    }
  }, true);

  // ─── Random helpers ───────────────────────────────────────────────────────
  function rand(min, max) {
    return Math.random() * (max - min) + min;
  }

  function randInt(min, max) {
    return Math.floor(rand(min, max + 1));
  }

  // Gaussian-ish random for more natural timing
  function gaussian(mean, stddev) {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    const num = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    return Math.max(0, num * stddev + mean);
  }

  function sleep(ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      if (abortController) {
        abortController.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        });
      }
    });
  }

  function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  // ─── Keyboard Simulation ─────────────────────────────────────────────────
  function fireKey(el, char, isSpecial = false) {
    const keyCode = isSpecial ? { Backspace: 8, Enter: 13, Tab: 9 }[char] || 0
                              : char.charCodeAt(0);
    const opts = {
      key: char,
      code: isSpecial ? char : `Key${char.toUpperCase()}`,
      keyCode,
      which: keyCode,
      bubbles: true,
      cancelable: true,
    };

    el.dispatchEvent(new KeyboardEvent('keydown', opts));

    if (!isSpecial) {
      el.dispatchEvent(new KeyboardEvent('keypress', opts));

      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        const start = el.selectionStart;
        const end = el.selectionEnd;
        el.value = el.value.substring(0, start) + char + el.value.substring(end);
        el.selectionStart = el.selectionEnd = start + 1;
      } else if (el.isContentEditable) {
        document.execCommand('insertText', false, char);
      }

      el.dispatchEvent(new InputEvent('input', {
        bubbles: true, data: char, inputType: 'insertText',
      }));
    } else if (char === 'Backspace') {
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        const start = el.selectionStart;
        if (start > 0) {
          el.value = el.value.substring(0, start - 1) + el.value.substring(start);
          el.selectionStart = el.selectionEnd = start - 1;
        }
      } else if (el.isContentEditable) {
        document.execCommand('delete', false);
      }
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true, inputType: 'deleteContentBackward',
      }));
    } else if (char === 'Enter') {
      if (el.tagName === 'TEXTAREA') {
        const start = el.selectionStart;
        const end = el.selectionEnd;
        el.value = el.value.substring(0, start) + '\n' + el.value.substring(end);
        el.selectionStart = el.selectionEnd = start + 1;
      } else if (el.isContentEditable) {
        document.execCommand('insertLineBreak');
      }
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true, data: '\n', inputType: 'insertLineBreak',
      }));
    }

    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  // ─── Takeover Detection ───────────────────────────────────────────────────
  // If the user types, clicks into a different field, or changes the value
  // in ways we didn't expect, we abort immediately.

  function getCurrentValue(el) {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      return el.value;
    }
    if (el.isContentEditable) {
      return el.innerText;
    }
    return '';
  }

  function setupTakeoverDetection(el) {
    // We listen for real user keyboard events that we DIDN'T dispatch
    const onKeyDown = (e) => {
      if (!isTyping) return;
      // If the event is trusted (real user input, not our synthetic events)
      if (e.isTrusted) {
        abortTyping('user-keydown');
      }
    };

    const onMouseDown = (e) => {
      if (!isTyping) return;
      if (e.isTrusted) {
        // User clicked somewhere — if it's on the same element, maybe repositioning cursor
        // If it's a different element, definitely takeover
        if (e.target !== el && !el.contains(e.target)) {
          abortTyping('user-click-outside');
        } else {
          // Clicking within the element — likely repositioning. Abort to be safe.
          abortTyping('user-click-reposition');
        }
      }
    };

    const onPaste = (e) => {
      if (!isTyping) return;
      if (e.isTrusted) {
        abortTyping('user-paste');
      }
    };

    // Attach to document to catch everything
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('paste', onPaste, true);

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('mousedown', onMouseDown, true);
      document.removeEventListener('paste', onPaste, true);
    };
  }

  function abortTyping(reason) {
    if (abortController) {
      abortController.abort();
    }
    isTyping = false;

    // Notify sidebar
    chrome.runtime.sendMessage({
      type: 'HUMAN_TYPE_STOPPED',
      reason,
    }).catch(() => {});
  }

  // ─── Core Typing Engine ───────────────────────────────────────────────────
  async function typeHumanly(el, text) {
    isTyping = true;
    abortController = new AbortController();
    targetElement = el;

    const cleanup = setupTakeoverDetection(el);

    // Ensure element is focused
    el.focus();

    try {
      // Initial "thinking" pause — like a human positioning fingers
      await sleep(gaussian(400, 150));

      let charIndex = 0;
      let burstLength = 0;  // Characters left in current typing burst
      let burstSpeed = 1.0; // Speed multiplier for current burst

      while (charIndex < text.length) {
        if (!isTyping) break;

        const char = text[charIndex];

        // ── Burst mechanics: humans type in bursts ──
        if (burstLength <= 0) {
          // Start a new burst
          burstLength = randInt(3, 15); // Type 3-15 chars in a burst
          burstSpeed = rand(0.7, 1.4);  // Each burst has slightly different speed

          // Between bursts, sometimes take a longer pause (micro-think)
          if (charIndex > 0 && Math.random() < 0.15) {
            await sleep(gaussian(600, 300));
          }
        }
        burstLength--;

        // ── Decide: typo, double-type, skip, or correct ──
        const typoRoll = Math.random();

        if (typoRoll < 0.035 && TYPO_MAP[char.toLowerCase()]) {
          // ~3.5% chance: adjacent-key typo
          const wrongChar = pick(TYPO_MAP[char.toLowerCase()]);
          const isUpper = char !== char.toLowerCase();

          fireKey(el, isUpper ? wrongChar.toUpperCase() : wrongChar);
          await sleep(gaussian(90, 40)); // Brief moment before noticing

          // Sometimes type 1-2 more chars before noticing the typo
          const extraCharsBeforeNotice = Math.random() < 0.3 ? randInt(1, 2) : 0;
          for (let extra = 0; extra < extraCharsBeforeNotice && charIndex + 1 + extra < text.length; extra++) {
            fireKey(el, text[charIndex + 1 + extra]);
            await sleep(gaussian(60, 20));
          }

          // Pause — noticing the mistake
          await sleep(gaussian(300, 150));

          // Backspace to fix (including any extra chars)
          for (let bs = 0; bs <= extraCharsBeforeNotice; bs++) {
            fireKey(el, 'Backspace', true);
            await sleep(gaussian(55, 20));
          }

          // Small pause after deleting
          await sleep(gaussian(120, 50));

          // Now type the correct character
          fireKey(el, char);

        } else if (typoRoll < 0.05 && DOUBLE_TYPE_CHARS.has(char.toLowerCase())) {
          // ~1.5% chance: double-press a key
          fireKey(el, char);
          await sleep(gaussian(30, 10)); // Very fast double
          fireKey(el, char);
          await sleep(gaussian(200, 80)); // Notice
          fireKey(el, 'Backspace', true);
          await sleep(gaussian(80, 30));

        } else if (typoRoll < 0.055) {
          // ~0.5% chance: type char, immediately backspace, retype (stutter)
          fireKey(el, char);
          await sleep(gaussian(50, 20));
          fireKey(el, 'Backspace', true);
          await sleep(gaussian(150, 60));
          fireKey(el, char);

        } else if (typoRoll < 0.06 && char === ' ' && charIndex > 10) {
          // ~0.5% chance: miss the space bar entirely, then fix
          // Just skip — type next char, then backspace and add space
          if (charIndex + 1 < text.length) {
            fireKey(el, text[charIndex + 1]);
            await sleep(gaussian(180, 70));
            fireKey(el, 'Backspace', true);
            await sleep(gaussian(60, 25));
            fireKey(el, ' ');
            // Don't advance charIndex extra — the next iteration handles charIndex+1
          } else {
            fireKey(el, char);
          }

        } else {
          // Normal correct typing
          fireKey(el, char);
        }

        // ── Inter-key timing (the heart of realism) ──
        let delay;

        if (char === '\n') {
          // New line — longer pause (thinking about next line)
          delay = gaussian(350, 150);
        } else if ('.!?'.includes(char)) {
          // End of sentence — natural pause
          delay = gaussian(250, 120);
        } else if (',;:'.includes(char)) {
          // Clause boundary
          delay = gaussian(150, 60);
        } else if (char === ' ') {
          // Word boundary — slightly slower
          delay = gaussian(100, 40);

          // Occasionally pause longer between words (thinking about next word)
          if (Math.random() < 0.08) {
            delay += gaussian(500, 250);
          }
        } else if (char === '{' || char === '(' || char === '[') {
          // Opening bracket — slight hesitation
          delay = gaussian(120, 50);
        } else if (char === '}' || char === ')' || char === ']') {
          // Closing bracket — often follows quickly
          delay = gaussian(60, 25);
        } else {
          // Regular character — base speed with gaussian variance
          const baseMean = 72; // ~70ms mean = ~55 WPM
          delay = gaussian(baseMean, 28);
        }

        // Apply burst speed multiplier
        delay *= burstSpeed;

        // Very occasional long pause — like re-reading what you typed (2% chance)
        if (Math.random() < 0.02 && charIndex > 5) {
          delay += gaussian(1200, 500);
        }

        // Extremely rare mega-pause — like getting distracted (0.3% chance)
        if (Math.random() < 0.003) {
          delay += gaussian(3000, 1000);
        }

        // Clamp to reasonable range
        delay = Math.max(15, Math.min(delay, 8000));

        await sleep(delay);
        charIndex++;
      }

      // Finished successfully
      if (isTyping) {
        isTyping = false;
        chrome.runtime.sendMessage({
          type: 'HUMAN_TYPE_COMPLETE',
        }).catch(() => {});
      }
    } catch (err) {
      if (err.message !== 'aborted') {
        chrome.runtime.sendMessage({
          type: 'HUMAN_TYPE_ERROR',
          error: err.message,
        }).catch(() => {});
      }
      // 'aborted' means user takeover — already handled
    } finally {
      cleanup();
      isTyping = false;
      abortController = null;
      targetElement = null;
    }
  }

  // ─── Message Listener ─────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

    if (msg.type === 'HUMAN_TYPE_START') {
      // Try activeElement first (if user managed to keep focus on page),
      // then fall back to last tracked input element.
      let el = document.activeElement;
      if (!isValidTypingTarget(el)) {
        el = lastFocusedInput;
      }

      if (!el || !isValidTypingTarget(el)) {
        sendResponse({ error: 'No text input focused. Click into an input field on the page first, then click ▶ Start.' });
        return true;
      }

      if (isTyping) {
        sendResponse({ error: 'Already typing. Wait or take over to stop.' });
        return true;
      }

      sendResponse({ success: true, element: el.tagName });

      // Re-focus the element (it may have lost focus when user clicked the sidebar)
      el.focus();

      // Start asynchronously
      typeHumanly(el, msg.text);
      return true;
    }

    if (msg.type === 'HUMAN_TYPE_STOP') {
      if (isTyping) {
        abortTyping('manual-stop');
      }
      sendResponse({ success: true });
      return true;
    }

    if (msg.type === 'HUMAN_TYPE_STATUS') {
      sendResponse({
        isTyping,
        targetTag: targetElement?.tagName || null,
      });
      return true;
    }
  });

})();
