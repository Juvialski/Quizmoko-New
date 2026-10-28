/* Browser BYOK is optional. The server owns credential fallback and quota checks. */
(() => {
  function browserKey(storage) {
    try { storage = storage || window.localStorage; } catch { return ''; }
    try {
      const keys = JSON.parse(storage.getItem('gemini_api_keys') || '[]');
      if (Array.isArray(keys)) {
        const key = keys.find(value => typeof value === 'string' && value.trim());
        if (key) return key.trim();
      }
    } catch { /* A malformed or inaccessible browser setting must not block server credentials. */ }
    try {
      return String(storage.getItem('gemini_api_key') || '').trim();
    } catch { return ''; }
  }
  window.QuizMoKoAiKeys = { browserKey };
})();
