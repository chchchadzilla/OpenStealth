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

// ─── Init ────────────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  // Enable side panel on all tabs
  await chrome.sidePanel.setOptions({
    enabled: true,
  });

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
  };

  const stored = await chrome.storage.local.get('settings');
  if (!stored.settings) {
    await chrome.storage.local.set({ settings: defaults });
  }

  console.log('[OpenStealth] Extension installed/updated');
});

// Open side panel when action icon is clicked
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ tabId: tab.id });
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
        console.warn('[OpenStealth] Screenshot capture failed:', e);
      }
    }

    const messages = promptBuilder.buildMessages(
      message.query,
      conversationHistory,
      imageData,
      lastPageContext
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

chrome.contextMenus?.onClicked?.addListener(async (info, tab) => {
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
