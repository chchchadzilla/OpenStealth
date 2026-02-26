// Load status
chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }).then(settings => {
  if (settings?.apiKey) {
    document.getElementById('api-dot').classList.replace('inactive', 'active');
    document.getElementById('api-status').textContent = 'Connected';
    document.getElementById('api-status').style.color = 'var(--green)';
  }
  if (settings?.stealthLevel) {
    document.getElementById('stealth-status').textContent =
      settings.stealthLevel.charAt(0).toUpperCase() + settings.stealthLevel.slice(1);
  }
});

document.getElementById('btn-sidebar').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    try {
      await chrome.sidePanel.open({ tabId: tab.id });
    } catch (e) {
      // If opened as standalone window, the tab may not support side panel
    }
  }
  window.close();
});

document.getElementById('btn-settings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});
