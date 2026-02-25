/*
 * OpenStealth — Sidebar Controller
 * Manages the chat UI, message rendering, and communication with background.
 */

// ─── DOM Refs ────────────────────────────────────────────────────────────────
const chatMessages = document.getElementById('chat-messages');
const chatContainer = document.getElementById('chat-container');
const userInput = document.getElementById('user-input');
const btnSend = document.getElementById('btn-send');
const btnSettings = document.getElementById('btn-settings');
const btnClear = document.getElementById('btn-clear');
const btnAutoToggle = document.getElementById('btn-auto-toggle');
const btnScreenshot = document.getElementById('btn-screenshot');
const statusIndicator = document.getElementById('status-indicator');
const statusText = document.getElementById('status-text');
const modelName = document.getElementById('model-name');
const chkScreenshot = document.getElementById('chk-screenshot');
const chkPageContext = document.getElementById('chk-page-context');
const toolPanel = document.getElementById('tool-panel');
const toolContent = document.getElementById('tool-content');
const btnApproveTools = document.getElementById('btn-approve-tools');
const btnDenyTools = document.getElementById('btn-deny-tools');

let currentStreamingEl = null;
let autoDetect = true;
let settings = {};

// ─── Init ────────────────────────────────────────────────────────────────────
async function init() {
  settings = await sendMessage({ type: 'GET_SETTINGS' }) || {};
  
  if (settings.model) {
    modelName.textContent = settings.model.split('/').pop();
  }

  if (!settings.apiKey) {
    setStatus('warning', 'No API key — click ⚙️');
  }

  autoDetect = settings.autoDetect !== false;
  btnAutoToggle.classList.toggle('active', autoDetect);

  // Load conversation history
  const convo = await sendMessage({ type: 'GET_CONVERSATION' });
  if (convo?.history?.length) {
    convo.history.forEach(msg => {
      appendMessage(msg.role, msg.content);
    });
    scrollToBottom();
  }
}

// ─── Message Sending ────────────────────────────────────────────────────────
async function sendQuery() {
  const text = userInput.value.trim();
  if (!text) return;

  userInput.value = '';
  autoResizeInput();
  
  appendMessage('user', text);
  scrollToBottom();

  setStatus('processing', 'Thinking...');
  btnSend.disabled = true;

  // Create streaming placeholder
  currentStreamingEl = appendMessage('assistant', '', true);
  scrollToBottom();

  await sendMessage({
    type: 'SIDEBAR_QUERY',
    query: text,
    includeScreenshot: chkScreenshot.checked,
    includePageContext: chkPageContext.checked,
  });
}

// ─── Message Rendering ──────────────────────────────────────────────────────
function appendMessage(role, content, streaming = false) {
  const msgDiv = document.createElement('div');
  msgDiv.className = `message ${role}`;

  const label = document.createElement('div');
  label.className = 'message-label';
  label.textContent = role === 'user' ? 'You' : role === 'assistant' ? 'AI' : '';

  const contentDiv = document.createElement('div');
  contentDiv.className = 'message-content';
  if (streaming) {
    contentDiv.classList.add('streaming-cursor');
  }
  contentDiv.innerHTML = renderMarkdown(content);

  if (label.textContent) msgDiv.appendChild(label);
  msgDiv.appendChild(contentDiv);
  chatMessages.appendChild(msgDiv);

  return contentDiv;
}

function renderMarkdown(text) {
  if (!text) return '';
  
  return text
    // Code blocks
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="language-$1">$2</code></pre>')
    // Inline code
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // Bold
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // Italic
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Headers
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    // Lists
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>')
    // Line breaks
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>')
    // Wrap in paragraph
    .replace(/^(.+)/, '<p>$1</p>');
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    chatContainer.scrollTop = chatContainer.scrollHeight;
  });
}

// ─── Status ──────────────────────────────────────────────────────────────────
function setStatus(state, text) {
  statusIndicator.className = 'status-dot';
  if (state === 'processing') statusIndicator.classList.add('processing');
  if (state === 'error') statusIndicator.classList.add('error');
  if (state === 'warning') statusIndicator.classList.add('error');
  statusText.textContent = text || 'Ready';
}

// ─── Background Message Listener ────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case 'LLM_TOKEN':
      if (currentStreamingEl) {
        currentStreamingEl.innerHTML = renderMarkdown(message.partial);
        scrollToBottom();
      }
      break;

    case 'LLM_COMPLETE':
      if (currentStreamingEl) {
        currentStreamingEl.classList.remove('streaming-cursor');
        currentStreamingEl.innerHTML = renderMarkdown(message.content);
        currentStreamingEl = null;
      }
      setStatus('ready', 'Ready');
      btnSend.disabled = false;

      // Handle tool calls
      if (message.toolCalls?.length) {
        showToolCalls(message.toolCalls);
      }
      scrollToBottom();
      break;

    case 'LLM_ERROR':
      if (currentStreamingEl) {
        currentStreamingEl.classList.remove('streaming-cursor');
        currentStreamingEl.innerHTML = `<span style="color:var(--red)">Error: ${message.error}</span>`;
        currentStreamingEl = null;
      }
      setStatus('error', 'Error');
      btnSend.disabled = false;
      break;

    case 'CONTEXT_MENU_QUERY':
      userInput.value = message.query;
      sendQuery();
      break;

    case 'AUTO_CHANGE_DETECTED':
      if (autoDetect) {
        appendMessage('system', `🔄 Change detected: ${message.description}`);
        scrollToBottom();
      }
      break;
  }
});

// ─── Tool Calls ──────────────────────────────────────────────────────────────
function showToolCalls(calls) {
  toolPanel.classList.remove('hidden');
  toolContent.innerHTML = calls.map(call => `
    <div class="tool-call">
      <strong>${call.function?.name || 'Unknown'}</strong>
      <pre>${JSON.stringify(call.function?.arguments || {}, null, 2)}</pre>
    </div>
  `).join('');
}

btnApproveTools?.addEventListener('click', async () => {
  toolPanel.classList.add('hidden');
  // Send approval to background for execution
  await sendMessage({ type: 'APPROVE_TOOL_CALLS' });
});

btnDenyTools?.addEventListener('click', () => {
  toolPanel.classList.add('hidden');
  appendMessage('system', '🚫 Tool calls denied.');
});

// ─── Event Handlers ─────────────────────────────────────────────────────────
btnSend.addEventListener('click', sendQuery);

userInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendQuery();
  }
});

userInput.addEventListener('input', autoResizeInput);

function autoResizeInput() {
  userInput.style.height = 'auto';
  userInput.style.height = Math.min(userInput.scrollHeight, 120) + 'px';
}

btnSettings.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

btnClear.addEventListener('click', async () => {
  await sendMessage({ type: 'CLEAR_CONVERSATION' });
  chatMessages.innerHTML = '';
  appendMessage('system', '🗑️ Conversation cleared.');
});

btnAutoToggle.addEventListener('click', () => {
  autoDetect = !autoDetect;
  btnAutoToggle.classList.toggle('active', autoDetect);
  setStatus('ready', autoDetect ? 'Auto-detect ON' : 'Auto-detect OFF');
  
  // Persist
  settings.autoDetect = autoDetect;
  sendMessage({ type: 'SAVE_SETTINGS', settings });
});

// ─── Helper ──────────────────────────────────────────────────────────────────
function sendMessage(msg) {
  return chrome.runtime.sendMessage(msg);
}

// ─── Boot ────────────────────────────────────────────────────────────────────
init();
