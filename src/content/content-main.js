/*
 * OpenStealth — Content Main (Content Script)
 * Glues together the page monitor, interaction tracker, stealth overlay,
 * and human simulation engine. Handles messages from the background script.
 */

(() => {
  'use strict';

  // ─── Human Simulation Engine ──────────────────────────────────────────────
  const HumanSim = {
    
    // Speed presets (WPM and characteristics)
    SPEED_PRESETS: {
      slow:   { wpm: 25, pauseRange: [80, 250],  typoRate: 0.06, thinkPause: [500, 3000] },
      medium: { wpm: 45, pauseRange: [40, 150],   typoRate: 0.04, thinkPause: [300, 1500] },
      fast:   { wpm: 70, pauseRange: [20, 80],    typoRate: 0.02, thinkPause: [100, 800]  },
      custom: null, // Filled from settings
    },

    // Common typo maps (adjacent keys)
    TYPO_MAP: {
      'a': ['s', 'q', 'w'], 'b': ['v', 'n', 'g'], 'c': ['x', 'v', 'd'],
      'd': ['s', 'f', 'e'], 'e': ['w', 'r', 'd'], 'f': ['d', 'g', 'r'],
      'g': ['f', 'h', 't'], 'h': ['g', 'j', 'y'], 'i': ['u', 'o', 'k'],
      'j': ['h', 'k', 'u'], 'k': ['j', 'l', 'i'], 'l': ['k', ';', 'o'],
      'm': ['n', ',', 'j'], 'n': ['b', 'm', 'h'], 'o': ['i', 'p', 'l'],
      'p': ['o', '[', ';'], 'q': ['w', 'a', '1'], 'r': ['e', 't', 'f'],
      's': ['a', 'd', 'w'], 't': ['r', 'y', 'g'], 'u': ['y', 'i', 'j'],
      'v': ['c', 'b', 'f'], 'w': ['q', 'e', 's'], 'x': ['z', 'c', 's'],
      'y': ['t', 'u', 'h'], 'z': ['x', 'a', 's'],
    },

    getSpeed(settings) {
      if (settings.typingSpeed === 'custom') {
        return {
          wpm: settings.typingWPM || 45,
          pauseRange: [
            Math.max(10, 60000 / ((settings.typingWPM || 45) * 5) * 0.5),
            Math.max(30, 60000 / ((settings.typingWPM || 45) * 5) * 1.5),
          ],
          typoRate: settings.typoRate || 0.04,
          thinkPause: [200, 1500],
        };
      }
      return this.SPEED_PRESETS[settings.typingSpeed || 'medium'];
    },

    rand(min, max) {
      return Math.random() * (max - min) + min;
    },

    // Gaussian-ish random for more human-like timing
    gaussianRand(mean, stddev) {
      let u = 0, v = 0;
      while (u === 0) u = Math.random();
      while (v === 0) v = Math.random();
      const num = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
      return num * stddev + mean;
    },

    /**
     * Type text into an element with human-like behavior
     */
    async typeText(element, text, settings) {
      const speed = this.getSpeed(settings);
      if (!speed) return;

      element.focus();
      
      // Small initial pause (human thinks before typing)
      await this.sleep(this.rand(...speed.thinkPause));

      for (let i = 0; i < text.length; i++) {
        const char = text[i];

        // Should we make a typo?
        if (Math.random() < speed.typoRate && this.TYPO_MAP[char.toLowerCase()]) {
          const typos = this.TYPO_MAP[char.toLowerCase()];
          const wrongChar = typos[Math.floor(Math.random() * typos.length)];

          // Type wrong character
          await this.simulateKey(element, wrongChar);
          await this.sleep(this.rand(100, 400)); // Realize mistake

          // Backspace
          await this.simulateKey(element, 'Backspace', true);
          await this.sleep(this.rand(50, 200));

          // Type correct character
          await this.simulateKey(element, char);
        } else {
          await this.simulateKey(element, char);
        }

        // Inter-key delay (varies per character)
        let delay;
        if (char === ' ') {
          delay = this.gaussianRand(speed.pauseRange[1], 30); // Slower on spaces
        } else if (char === '\n') {
          delay = this.rand(200, 600); // Pause at line breaks
        } else if ('.!?'.includes(char)) {
          delay = this.rand(100, 500); // Pause at sentence endings
        } else {
          delay = this.gaussianRand(
            (speed.pauseRange[0] + speed.pauseRange[1]) / 2,
            (speed.pauseRange[1] - speed.pauseRange[0]) / 4
          );
        }

        // Occasional longer pauses (thinking)
        if (Math.random() < 0.02) {
          delay += this.rand(...speed.thinkPause);
        }

        await this.sleep(Math.max(10, delay));
      }
    },

    simulateKey(element, char, isSpecial = false) {
      const opts = {
        bubbles: true,
        cancelable: true,
        key: char,
        code: isSpecial ? char : `Key${char.toUpperCase()}`,
      };

      element.dispatchEvent(new KeyboardEvent('keydown', opts));
      
      if (!isSpecial) {
        element.dispatchEvent(new KeyboardEvent('keypress', opts));
        // Actually insert the character
        if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') {
          const start = element.selectionStart;
          const end = element.selectionEnd;
          element.value = element.value.substring(0, start) + char + element.value.substring(end);
          element.selectionStart = element.selectionEnd = start + 1;
        } else if (element.isContentEditable) {
          document.execCommand('insertText', false, char);
        }
        element.dispatchEvent(new InputEvent('input', { bubbles: true, data: char }));
      } else if (char === 'Backspace') {
        if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') {
          const start = element.selectionStart;
          if (start > 0) {
            element.value = element.value.substring(0, start - 1) + element.value.substring(start);
            element.selectionStart = element.selectionEnd = start - 1;
          }
        } else if (element.isContentEditable) {
          document.execCommand('delete', false);
        }
        element.dispatchEvent(new InputEvent('input', { bubbles: true }));
      }

      element.dispatchEvent(new KeyboardEvent('keyup', opts));
    },

    /**
     * Move mouse to target with human-like jittery motion
     */
    async moveMouse(targetX, targetY, settings) {
      const jitter = settings.mouseJitter || 3;
      const steps = Math.floor(this.rand(15, 40)); // Number of intermediate points
      
      // Start from last known position or random
      let currentX = this.lastMouseX || this.rand(100, window.innerWidth - 100);
      let currentY = this.lastMouseY || this.rand(100, window.innerHeight - 100);

      // Generate a Bezier-ish curve with random control points
      const cp1x = currentX + this.rand(-100, 100);
      const cp1y = currentY + this.rand(-100, 100);
      const cp2x = targetX + this.rand(-50, 50);
      const cp2y = targetY + this.rand(-50, 50);

      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        
        // Cubic bezier interpolation
        const x = Math.pow(1-t, 3) * currentX + 
                  3 * Math.pow(1-t, 2) * t * cp1x +
                  3 * (1-t) * Math.pow(t, 2) * cp2x +
                  Math.pow(t, 3) * targetX;
        const y = Math.pow(1-t, 3) * currentY + 
                  3 * Math.pow(1-t, 2) * t * cp1y +
                  3 * (1-t) * Math.pow(t, 2) * cp2y +
                  Math.pow(t, 3) * targetY;

        // Add jitter
        const jx = x + this.gaussianRand(0, jitter);
        const jy = y + this.gaussianRand(0, jitter);

        document.dispatchEvent(new MouseEvent('mousemove', {
          clientX: jx,
          clientY: jy,
          bubbles: true,
        }));

        // Variable speed — slow down near target
        const distToTarget = Math.sqrt(Math.pow(targetX - jx, 2) + Math.pow(targetY - jy, 2));
        const delay = distToTarget < 50 ? this.rand(8, 25) : this.rand(3, 12);
        await this.sleep(delay);
      }

      this.lastMouseX = targetX;
      this.lastMouseY = targetY;
    },

    /**
     * Click on an element with human-like approach
     */
    async clickElement(element, settings) {
      const rect = element.getBoundingClientRect();
      
      // Don't click dead center — humans are imprecise
      const targetX = rect.left + rect.width * this.rand(0.3, 0.7);
      const targetY = rect.top + rect.height * this.rand(0.3, 0.7);

      // Move mouse to element
      await this.moveMouse(targetX, targetY, settings);

      // Small pause before clicking
      await this.sleep(this.rand(50, 200));

      // Click events
      const opts = { clientX: targetX, clientY: targetY, bubbles: true };
      element.dispatchEvent(new MouseEvent('mousedown', opts));
      await this.sleep(this.rand(50, 150)); // Human hold time
      element.dispatchEvent(new MouseEvent('mouseup', opts));
      element.dispatchEvent(new MouseEvent('click', opts));
    },

    lastMouseX: 0,
    lastMouseY: 0,

    sleep(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    },
  };

  // ─── Message Handler ──────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'EXECUTE_HUMAN_ACTION') {
      executeAction(msg.action, msg.params, msg.settings)
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ error: err.message }));
      return true;
    }

    if (msg.type === 'GET_FOCUSED_CONTEXT') {
      const interaction = window.__openstealth_lastInteraction;
      const monitor = window.__openstealth_monitor;
      const snapshot = monitor?.takeSnapshot?.();

      sendResponse({
        interaction,
        pageText: snapshot?.text?.substring(0, 5000),
        images: snapshot?.images?.slice(0, 10),
        meta: snapshot?.meta,
        activeSlide: snapshot?.activeSlide,
      });
      return true;
    }
  });

  async function executeAction(action, params, settings) {
    switch (action) {
      case 'type': {
        const el = findElement(params.selector || params.elementInfo);
        if (!el) return { error: 'Element not found' };
        await HumanSim.typeText(el, params.text, settings);
        return { success: true };
      }
      case 'click': {
        const el = findElement(params.selector || params.elementInfo);
        if (!el) return { error: 'Element not found' };
        await HumanSim.clickElement(el, settings);
        return { success: true };
      }
      case 'moveMouse': {
        await HumanSim.moveMouse(params.x, params.y, settings);
        return { success: true };
      }
      default:
        return { error: `Unknown action: ${action}` };
    }
  }

  function findElement(selectorOrInfo) {
    if (typeof selectorOrInfo === 'string') {
      return document.querySelector(selectorOrInfo);
    }
    if (selectorOrInfo?.id) {
      return document.getElementById(selectorOrInfo.id);
    }
    if (selectorOrInfo?.selector) {
      return document.querySelector(selectorOrInfo.selector);
    }
    return null;
  }

  console.log('[OpenStealth] Content main loaded');
})();
