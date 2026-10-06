// Preference fragments are inserted after pane scripts run. Listen for the
// native load event on the document: element load never propagates to window.
window.document.addEventListener('load', function initializeOrangeTranslateSettings(event) {
  const root = event.target;
  if (root.id !== 'orange-translate-api-settings') { return; }
  window.document.removeEventListener('load', initializeOrangeTranslateSettings, true);
  try {
    OrangeTranslateLifecycle.mountProviderSettings({ win: window, root, Zotero, Services, Components,
      ChromeUtils, IOUtils, PathUtils });
  }
  catch (error) {
    const message = window.document.createElementNS('http://www.w3.org/1999/xhtml', 'p');
    message.textContent = 'Orange Translate 设置页加载失败，请重启 Zotero 后重试。';
    root.replaceChildren(message);
    Zotero.logError(new Error('Orange Translate preferences initialization failed'));
  }
}, true, true); // Gecko: accept the loader's synthetic event in privileged chrome.
