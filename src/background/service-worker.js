/*
 * OpenStealth — Background Service Worker
 * Coordinates all extension messaging, API calls, and state management.
 */

import { OpenRouterAPI } from '../api/openrouter.js';
import { PromptBuilder } from '../api/prompt-builder.js';

// ─── State ───────────────────────────────────────────────────────────────────
let apiInstance = null;
let currentSettings = {};
let lastPageContext = null;
let conversationHistory = [];
let isProcessing = false;
let isAutopilotProcessing = false;
let autopilotEnabled = false;
let autopilotHistory = [];  // Separate history for auto-pilot context

// ─── Init ────────────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  // Enable side panel on all tabs
  await chrome.sidePanel.setOptions({
    enabled: true,
  });

  // Set the panel to open when the toolbar icon is clicked
  // This is the most reliable method — no popup, no onClicked race conditions
  if (chrome.sidePanel.setPanelBehavior) {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }

  // Set default settings
  const defaults = {
    apiKey: '',
    model: 'google/gemini-2.0-flash-001',
    visionModel: 'google/gemini-2.0-flash-001',
    autoDetect: true,
    changeThreshold: 0.3,       // 30% change needed to trigger
    debounceMs: 2000,           // 2s debounce on changes
    typingSpeed: 'medium',      // slow, medium, fast, custom
    typingWPM: 45,
    typoRate: 0.04,             // 4% chance of typo per char
    mouseJitter: 3,             // pixels of jitter
    mouseSpeed: 'medium',
    enableToolCalls: false,
    enableBrowserControl: false,
    enableMCP: false,
    mcpServers: [],
    maxTokens: 4096,
    temperature: 0.7,
    systemPrompt: '',
    stealthLevel: 'high',       // low, medium, high, paranoid
    autopilotEnabled: false,
    autopilotIntervalSec: 30,
  };

  const stored = await chrome.storage.local.get('settings');
  if (!stored.settings) {
    await chrome.storage.local.set({ settings: defaults });
  }

  console.log('[OpenStealth] Extension installed/updated');
});

// Fallback: open side panel when action icon is clicked
// (Only fires if setPanelBehavior is not available / not set)
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (err) {
    console.warn('[OpenStealth] sidePanel.open failed:', err.message);
  }
});

// ─── Settings Loader ────────────────────────────────────────────────────────
async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  currentSettings = settings || {};
  if (currentSettings.apiKey) {
    apiInstance = new OpenRouterAPI(currentSettings.apiKey, currentSettings);
  }
  return currentSettings;
}

// ─── Message Router ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch(err => {
    console.error('[OpenStealth] Message handler error:', err);
    sendResponse({ error: err.message });
  });
  return true; // Keep channel open for async
});

async function handleMessage(message, sender) {
  switch (message.type) {

    // ── Settings ──
    case 'GET_SETTINGS':
      return await loadSettings();

    case 'SAVE_SETTINGS':
      await chrome.storage.local.set({ settings: message.settings });
      currentSettings = message.settings;
      if (currentSettings.apiKey) {
        apiInstance = new OpenRouterAPI(currentSettings.apiKey, currentSettings);
      }
      return { success: true };

    // ── Page Context ──
    case 'PAGE_CONTEXT_UPDATE':
      lastPageContext = message.context;
      return { received: true };

    case 'SIGNIFICANT_CHANGE':
      return await handleSignificantChange(message, sender);

    // ── User Interactions ──
    case 'USER_INTERACTION':
      return await handleUserInteraction(message, sender);

    // ── Direct Query from Sidebar ──
    case 'SIDEBAR_QUERY':
      return await handleSidebarQuery(message);

    // ── Get conversation ──
    case 'GET_CONVERSATION':
      return { history: conversationHistory };

    case 'CLEAR_CONVERSATION':
      conversationHistory = [];
      return { success: true };

    // ── Capture visible tab ──
    case 'CAPTURE_TAB':
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab(null, {
          format: 'png',
          quality: 85,
        });
        return { dataUrl };
      } catch (e) {
        return { error: e.message };
      }

    // ── Human simulation commands ──
    case 'EXECUTE_HUMAN_ACTION':
      return await executeHumanAction(message, sender);

    // ── Auto-pilot ──
    case 'AUTOPILOT_TICK':
      return await handleAutopilotTick(message, sender);

    case 'AUTOPILOT_TOGGLE':
      return await toggleAutopilot(message.enabled, message.intervalSec);

    case 'AUTOPILOT_GET_STATUS':
      return { enabled: autopilotEnabled };

    // ── Get active tab info ──
    case 'GET_ACTIVE_TAB':
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return { tab };

    default:
      return { error: `Unknown message type: ${message.type}` };
  }
}

// ─── Significant Change Handler ──────────────────────────────────────────────
async function handleSignificantChange(message, sender) {
  if (isProcessing) return { queued: true };
  if (!apiInstance) return { error: 'No API key configured' };

  isProcessing = true;

  try {
    await loadSettings();

    const context = message.context;
    const promptBuilder = new PromptBuilder(currentSettings);
    const prompt = promptBuilder.buildFromChange(context);

    // If it's a visual change and we have a vision model, capture the tab
    let imageData = null;
    if (context.isVisualChange && currentSettings.visionModel) {
      try {
        const capture = await chrome.tabs.captureVisibleTab(null, {
          format: 'png',
          quality: 80,
        });
        imageData = capture;
      } catch (e) {
        console.warn('[OpenStealth] Could not capture tab:', e);
      }
    }

    const messages = promptBuilder.buildMessages(
      prompt,
      conversationHistory,
      imageData
    );

    // Stream to sidebar
    let fullResponse = '';
    const response = await apiInstance.chat(messages, {
      stream: true,
      onToken: (token) => {
        fullResponse += token;
        broadcastToSidebar({
          type: 'LLM_TOKEN',
          token,
          partial: fullResponse,
        });
      },
    });

    fullResponse = response.content || fullResponse;

    // Store in history
    conversationHistory.push(
      { role: 'user', content: prompt },
      { role: 'assistant', content: fullResponse }
    );

    // Trim history
    if (conversationHistory.length > 40) {
      conversationHistory = conversationHistory.slice(-30);
    }

    broadcastToSidebar({
      type: 'LLM_COMPLETE',
      content: fullResponse,
      toolCalls: response.toolCalls || [],
    });

    return { success: true, content: fullResponse };
  } catch (err) {
    broadcastToSidebar({ type: 'LLM_ERROR', error: err.message });
    return { error: err.message };
  } finally {
    isProcessing = false;
  }
}

// ─── User Interaction Handler ────────────────────────────────────────────────
async function handleUserInteraction(message, sender) {
  // Store the interaction context but don't auto-query unless configured
  lastPageContext = {
    ...lastPageContext,
    lastInteraction: message.interaction,
  };
  return { received: true };
}

// ─── Sidebar Query Handler ──────────────────────────────────────────────────
async function handleSidebarQuery(message) {
  if (!apiInstance) return { error: 'No API key configured. Go to Settings.' };

  await loadSettings();

  isProcessing = true;
  try {
    const promptBuilder = new PromptBuilder(currentSettings);

    let imageData = null;
    if (message.includeScreenshot) {
      try {
        imageData = await chrome.tabs.captureVisibleTab(null, {
          format: 'png',
          quality: 80,
        });
      } catch (e) {
        // Silent fail — screenshot not critical
      }
    }

    // Fetch fresh page context if requested
    let pageContext = lastPageContext;
    if (message.includePageContext) {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) {
          const ctx = await chrome.tabs.sendMessage(tab.id, { type: 'GET_FOCUSED_CONTEXT' });
          if (ctx) pageContext = ctx;
        }
      } catch (e) {
        // Fall back to cached lastPageContext
      }
    }

    const messages = promptBuilder.buildMessages(
      message.query,
      conversationHistory,
      imageData,
      pageContext
    );

    let fullResponse = '';
    const response = await apiInstance.chat(messages, {
      stream: true,
      onToken: (token) => {
        fullResponse += token;
        broadcastToSidebar({
          type: 'LLM_TOKEN',
          token,
          partial: fullResponse,
        });
      },
    });

    fullResponse = response.content || fullResponse;

    conversationHistory.push(
      { role: 'user', content: message.query },
      { role: 'assistant', content: fullResponse }
    );

    if (conversationHistory.length > 40) {
      conversationHistory = conversationHistory.slice(-30);
    }

    broadcastToSidebar({
      type: 'LLM_COMPLETE',
      content: fullResponse,
      toolCalls: response.toolCalls || [],
    });

    return { success: true };
  } catch (err) {
    broadcastToSidebar({ type: 'LLM_ERROR', error: err.message });
    return { error: err.message };
  } finally {
    isProcessing = false;
  }
}

// ─── Human Action Executor ──────────────────────────────────────────────────
async function executeHumanAction(message, sender) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return { error: 'No active tab' };

  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: 'EXECUTE_HUMAN_ACTION',
      action: message.action,
      params: message.params,
      settings: currentSettings,
    });
    return { success: true };
  } catch (e) {
    return { error: e.message };
  }
}

// ─── Auto-Pilot Toggle ──────────────────────────────────────────────────────
async function toggleAutopilot(enabled, intervalSec) {
  autopilotEnabled = enabled;
  await loadSettings();

  // Persist the preference
  currentSettings.autopilotEnabled = enabled;
  if (intervalSec) currentSettings.autopilotIntervalSec = intervalSec;
  await chrome.storage.local.set({ settings: currentSettings });

  // Tell the content script to start/stop
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: enabled ? 'AUTOPILOT_START' : 'AUTOPILOT_STOP',
        intervalSec: intervalSec || currentSettings.autopilotIntervalSec || 30,
      });
    } catch (e) {
      // Content script not ready
    }
  }

  broadcastToSidebar({
    type: 'AUTOPILOT_STATUS_CHANGED',
    enabled,
  });

  return { enabled };
}

// ─── Auto-Pilot Tick Handler ─────────────────────────────────────────────────
async function handleAutopilotTick(message, sender) {
  // Always notify sidebar of the tick for countdown reset
  broadcastToSidebar({
    type: 'AUTOPILOT_TICK_RECEIVED',
    intervalSec: currentSettings.autopilotIntervalSec || 30,
  });

  if (!autopilotEnabled) return { skipped: true, reason: 'disabled' };
  if (isAutopilotProcessing) return { skipped: true, reason: 'already processing' };
  if (!apiInstance) {
    broadcastToSidebar({ type: 'AUTOPILOT_ERROR', error: 'No API key configured. Go to ⚙️ Settings.' });
    return { error: 'No API key configured' };
  }

  const data = message.data;
  if (!data) return { error: 'No data' };

  isAutopilotProcessing = true;

  try {
    await loadSettings();

    // Capture screenshot
    let imageData = null;
    try {
      imageData = await chrome.tabs.captureVisibleTab(null, {
        format: 'png',
        quality: 80,
      });
    } catch (e) {
      // Tab not capturable
    }

    // Build the auto-pilot prompt
    const parts = [];

    parts.push('Please assist with the task at hand.');

    // If user has highlighted text, that's the primary signal
    if (data.recentSelections?.length > 0) {
      parts.push('\n--- User Highlighted Text (most recent = highest priority) ---');
      // Most recent first
      const reversed = [...data.recentSelections].reverse();
      reversed.forEach((sel, i) => {
        parts.push(`\n[Selection ${i + 1}] (${sel.ago}):`);
        parts.push(`"${sel.text}"`);
        if (sel.context) parts.push(`Context: ${sel.context}`);
      });
      parts.push('\n(The user highlighted this text to signal what they need help with. Focus on this.)');
    }

    // Page context
    parts.push(`\n--- Page: ${data.pageTitle || 'Unknown'} ---`);
    parts.push(`URL: ${data.pageUrl || ''}`);
    if (data.pageChanged) {
      parts.push('(Page content has changed since last check)');
    }

    // Include page text (trimmed)
    if (data.pageText) {
      parts.push(`\n--- Visible Page Content ---\n${data.pageText.substring(0, 3000)}`);
    }

    // Instructions
    parts.push('\n--- Instructions ---');
    if (data.recentSelections?.length > 0) {
      parts.push('The user has highlighted specific text on the page. This is their way of telling you what they need help with WITHOUT interacting with the extension directly. Provide a helpful, detailed response focused on the highlighted content. If it looks like a question, answer it. If it looks like a problem or code, solve it. If it looks like content to study, explain it.');
    } else {
      parts.push('If none is obvious, provide information about the screenshot and page content. If there are questions visible, answer them. If there is educational content, summarize key points.');
    }

    const promptBuilder = new PromptBuilder(currentSettings);
    const messages = promptBuilder.buildMessages(
      parts.join('\n'),
      autopilotHistory,
      imageData
    );

    // Notify sidebar that auto-pilot is thinking
    broadcastToSidebar({
      type: 'AUTOPILOT_THINKING',
      selections: data.recentSelections?.length || 0,
      pageTitle: data.pageTitle,
    });

    let fullResponse = '';
    const response = await apiInstance.chat(messages, {
      stream: true,
      onToken: (token) => {
        fullResponse += token;
        broadcastToSidebar({
          type: 'LLM_TOKEN',
          token,
          partial: fullResponse,
          isAutopilot: true,
        });
      },
    });

    fullResponse = response.content || fullResponse;

    // Store in auto-pilot history (separate from main conversation)
    const userSummary = data.recentSelections?.length > 0
      ? `[Auto-pilot] User highlighted: "${data.recentSelections[data.recentSelections.length - 1].text.substring(0, 200)}"`
      : `[Auto-pilot] Page scan: ${data.pageTitle}`;

    autopilotHistory.push(
      { role: 'user', content: userSummary },
      { role: 'assistant', content: fullResponse }
    );

    // Keep auto-pilot history shorter
    if (autopilotHistory.length > 20) {
      autopilotHistory = autopilotHistory.slice(-14);
    }

    broadcastToSidebar({
      type: 'AUTOPILOT_COMPLETE',
      content: fullResponse,
      selections: data.recentSelections?.length || 0,
    });

    return { success: true };
  } catch (err) {
    broadcastToSidebar({ type: 'AUTOPILOT_ERROR', error: err.message });
    return { error: err.message };
  } finally {
    isAutopilotProcessing = false;
  }
}

// ─── Broadcast Helper ────────────────────────────────────────────────────────
function broadcastToSidebar(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    // Sidebar not open, silently ignore
  });
}

// ─── Context Menu ────────────────────────────────────────────────────────────
chrome.contextMenus?.create?.({
  id: 'openstealth-query',
  title: 'Ask OpenStealth about this',
  contexts: ['selection', 'image', 'page'],
}, () => chrome.runtime.lastError); // Suppress duplicate errors

chrome.contextMenus?.create?.({
  id: 'openstealth-settings',
  title: 'OpenStealth Settings',
  contexts: ['action'],
}, () => chrome.runtime.lastError);

chrome.contextMenus?.create?.({
  id: 'openstealth-status',
  title: 'OpenStealth Status',
  contexts: ['action'],
}, () => chrome.runtime.lastError);

chrome.contextMenus?.onClicked?.addListener(async (info, tab) => {
  if (info.menuItemId === 'openstealth-settings') {
    chrome.runtime.openOptionsPage();
    return;
  }

  if (info.menuItemId === 'openstealth-status') {
    // Open the popup as a standalone window for status
    chrome.windows.create({
      url: chrome.runtime.getURL('src/popup/popup.html'),
      type: 'popup',
      width: 360,
      height: 320,
    });
    return;
  }

  if (info.menuItemId === 'openstealth-query') {
    await chrome.sidePanel.open({ tabId: tab.id });

    const query = info.selectionText
      ? `Explain/answer this: "${info.selectionText}"`
      : info.srcUrl
        ? `Describe what's in this image: ${info.srcUrl}`
        : 'Analyze the current page content';

    setTimeout(() => {
      chrome.runtime.sendMessage({
        type: 'CONTEXT_MENU_QUERY',
        query,
      });
    }, 500);
  }
});
