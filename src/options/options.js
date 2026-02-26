/*
 * OpenStealth — Options Page Controller
 */

// ─── DOM Refs ────────────────────────────────────────────────────────────────
const fields = {
  apiKey: document.getElementById('apiKey'),
  model: document.getElementById('model'),
  visionModel: document.getElementById('visionModel'),
  maxTokens: document.getElementById('maxTokens'),
  temperature: document.getElementById('temperature'),
  customModel: document.getElementById('customModel'),
  autoDetect: document.getElementById('autoDetect'),
  changeThreshold: document.getElementById('changeThreshold'),
  debounceMs: document.getElementById('debounceMs'),
  autopilotEnabled: document.getElementById('autopilotEnabled'),
  autopilotIntervalSec: document.getElementById('autopilotIntervalSec'),
  typingSpeed: document.getElementById('typingSpeed'),
  typingWPM: document.getElementById('typingWPM'),
  typoRate: document.getElementById('typoRate'),
  mouseJitter: document.getElementById('mouseJitter'),
  mouseSpeed: document.getElementById('mouseSpeed'),
  enableToolCalls: document.getElementById('enableToolCalls'),
  enableBrowserControl: document.getElementById('enableBrowserControl'),
  enableMCP: document.getElementById('enableMCP'),
  mcpServers: document.getElementById('mcpServers'),
  stealthLevel: document.getElementById('stealthLevel'),
  systemPrompt: document.getElementById('systemPrompt'),
};

const btnSave = document.getElementById('btnSave');
const btnReset = document.getElementById('btnReset');
const btnTest = document.getElementById('btnTest');
const toggleKey = document.getElementById('toggleKey');
const saveBanner = document.getElementById('save-banner');
const testResult = document.getElementById('testResult');
const customSpeedFields = document.getElementById('customSpeedFields');
const mcpConfig = document.getElementById('mcpConfig');

// Range display values
const tempValue = document.getElementById('tempValue');
const thresholdValue = document.getElementById('thresholdValue');
const typoValue = document.getElementById('typoValue');
const jitterValue = document.getElementById('jitterValue');

// ─── Load Settings ──────────────────────────────────────────────────────────
async function loadSettings() {
  const settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
  if (!settings) return;

  fields.apiKey.value = settings.apiKey || '';
  
  // Handle custom model
  if (settings.model && !Array.from(fields.model.options).some(o => o.value === settings.model)) {
    fields.customModel.value = settings.model;
  } else {
    fields.model.value = settings.model || 'google/gemini-2.0-flash-001';
  }
  
  if (settings.visionModel && !Array.from(fields.visionModel.options).some(o => o.value === settings.visionModel)) {
    // Custom vision model — set first option and put in custom field
  } else {
    fields.visionModel.value = settings.visionModel || 'google/gemini-2.0-flash-001';
  }

  fields.maxTokens.value = settings.maxTokens || 4096;
  fields.temperature.value = settings.temperature ?? 0.7;
  fields.autoDetect.checked = settings.autoDetect !== false;
  fields.changeThreshold.value = settings.changeThreshold || 0.3;
  fields.debounceMs.value = settings.debounceMs || 2000;
  fields.autopilotEnabled.checked = !!settings.autopilotEnabled;
  fields.autopilotIntervalSec.value = settings.autopilotIntervalSec || 30;
  fields.typingSpeed.value = settings.typingSpeed || 'medium';
  fields.typingWPM.value = settings.typingWPM || 45;
  fields.typoRate.value = settings.typoRate || 0.04;
  fields.mouseJitter.value = settings.mouseJitter || 3;
  fields.mouseSpeed.value = settings.mouseSpeed || 'medium';
  fields.enableToolCalls.checked = !!settings.enableToolCalls;
  fields.enableBrowserControl.checked = !!settings.enableBrowserControl;
  fields.enableMCP.checked = !!settings.enableMCP;
  fields.mcpServers.value = (settings.mcpServers || []).join('\n');
  fields.stealthLevel.value = settings.stealthLevel || 'high';
  fields.systemPrompt.value = settings.systemPrompt || '';

  updateRangeDisplays();
  updateVisibility();
}

// ─── Save Settings ──────────────────────────────────────────────────────────
async function saveSettings() {
  const model = fields.customModel.value.trim() || fields.model.value;

  const settings = {
    apiKey: fields.apiKey.value.trim(),
    model,
    visionModel: fields.visionModel.value,
    maxTokens: parseInt(fields.maxTokens.value) || 4096,
    temperature: parseFloat(fields.temperature.value) || 0.7,
    autoDetect: fields.autoDetect.checked,
    changeThreshold: parseFloat(fields.changeThreshold.value) || 0.3,
    debounceMs: parseInt(fields.debounceMs.value) || 2000,
    autopilotEnabled: fields.autopilotEnabled.checked,
    autopilotIntervalSec: parseInt(fields.autopilotIntervalSec.value) || 30,
    typingSpeed: fields.typingSpeed.value,
    typingWPM: parseInt(fields.typingWPM.value) || 45,
    typoRate: parseFloat(fields.typoRate.value) || 0.04,
    mouseJitter: parseInt(fields.mouseJitter.value) || 3,
    mouseSpeed: fields.mouseSpeed.value,
    enableToolCalls: fields.enableToolCalls.checked,
    enableBrowserControl: fields.enableBrowserControl.checked,
    enableMCP: fields.enableMCP.checked,
    mcpServers: fields.mcpServers.value.split('\n').map(s => s.trim()).filter(Boolean),
    stealthLevel: fields.stealthLevel.value,
    systemPrompt: fields.systemPrompt.value.trim(),
    maxTokens: parseInt(fields.maxTokens.value) || 4096,
    temperature: parseFloat(fields.temperature.value) || 0.7,
  };

  await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });
  
  saveBanner.classList.remove('hidden');
  setTimeout(() => saveBanner.classList.add('hidden'), 3000);
}

// ─── Test API ───────────────────────────────────────────────────────────────
async function testAPI() {
  const key = fields.apiKey.value.trim();
  if (!key) {
    showTestResult('error', 'Please enter an API key first.');
    return;
  }

  btnTest.disabled = true;
  btnTest.textContent = '⏳ Testing...';

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: fields.customModel.value.trim() || fields.model.value,
        messages: [{ role: 'user', content: 'Say "Connection successful!" in exactly those words.' }],
        max_tokens: 20,
      }),
    });

    if (response.ok) {
      const data = await response.json();
      const reply = data.choices?.[0]?.message?.content || 'No response';
      showTestResult('success', `✅ Connected! Model replied: "${reply}"\nModel: ${data.model}`);
    } else {
      const errText = await response.text();
      showTestResult('error', `❌ API Error (${response.status}): ${errText}`);
    }
  } catch (err) {
    showTestResult('error', `❌ Network error: ${err.message}`);
  } finally {
    btnTest.disabled = false;
    btnTest.textContent = '🧪 Test API Connection';
  }
}

function showTestResult(type, text) {
  testResult.className = `test-result ${type}`;
  testResult.textContent = text;
  testResult.classList.remove('hidden');
}

// ─── UI Updates ─────────────────────────────────────────────────────────────
function updateRangeDisplays() {
  tempValue.textContent = parseFloat(fields.temperature.value).toFixed(1);
  thresholdValue.textContent = Math.round(parseFloat(fields.changeThreshold.value) * 100) + '%';
  typoValue.textContent = Math.round(parseFloat(fields.typoRate.value) * 100) + '%';
  jitterValue.textContent = fields.mouseJitter.value + 'px';
}

function updateVisibility() {
  customSpeedFields.classList.toggle('hidden', fields.typingSpeed.value !== 'custom');
  mcpConfig.classList.toggle('hidden', !fields.enableMCP.checked);
}

// ─── Event Listeners ────────────────────────────────────────────────────────
btnSave.addEventListener('click', saveSettings);
btnReset.addEventListener('click', async () => {
  if (confirm('Reset all settings to defaults?')) {
    await chrome.storage.local.remove('settings');
    location.reload();
  }
});
btnTest.addEventListener('click', testAPI);

toggleKey.addEventListener('click', () => {
  fields.apiKey.type = fields.apiKey.type === 'password' ? 'text' : 'password';
});

fields.temperature.addEventListener('input', updateRangeDisplays);
fields.changeThreshold.addEventListener('input', updateRangeDisplays);
fields.typoRate.addEventListener('input', updateRangeDisplays);
fields.mouseJitter.addEventListener('input', updateRangeDisplays);
fields.typingSpeed.addEventListener('change', updateVisibility);
fields.enableMCP.addEventListener('change', updateVisibility);

// ─── Init ───────────────────────────────────────────────────────────────────
loadSettings();
