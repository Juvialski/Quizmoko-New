/**
 * QuizMoKo Theme Engine
 * Manages dark/light theme persistence, dynamic DOM updates, and icon updates safely.
 */
(function () {
  const STORAGE_KEY = 'theme';
  
  function getSavedTheme() {
    try {
      return localStorage.getItem(STORAGE_KEY) || 'dark';
    } catch (e) {
      return 'dark';
    }
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.classList.remove('theme-dark', 'theme-light');
    document.documentElement.classList.add(theme === 'light' ? 'theme-light' : 'theme-dark');
  }

  // Initial immediate application to prevent flash of unstyled theme
  const initialTheme = getSavedTheme();
  applyTheme(initialTheme);

  function updateToggleUI(theme) {
    const isDark = theme === 'dark';
    const labelText = isDark ? 'Switch to light theme' : 'Switch to dark theme';
    const buttons = document.querySelectorAll('.theme-toggle-btn, [data-theme-toggle]');
    buttons.forEach((btn) => {
      btn.setAttribute('aria-pressed', isDark ? 'true' : 'false');
      btn.setAttribute('aria-label', labelText);
      const icon = btn.querySelector('[data-lucide], i, svg');
      if (icon) {
        icon.setAttribute('data-lucide', isDark ? 'sun' : 'moon');
      }
    });

    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      try {
        window.lucide.createIcons();
      } catch (e) {
        // Safe fallback if Lucide is not ready
      }
    }
  }

  function dispatchThemeChanged(theme) {
    try {
      window.dispatchEvent(
        new CustomEvent('themechanged', {
          detail: { theme: theme }
        })
      );
    } catch (e) {}
  }

  window.toggleTheme = function () {
    const current = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    const next = current === 'light' ? 'dark' : 'light';
    
    applyTheme(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch (e) {}

    updateToggleUI(next);
    dispatchThemeChanged(next);
  };

  window.refreshQuizmokoIcons = function refreshQuizmokoIcons() {
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      try {
        window.lucide.createIcons();
      } catch (e) {}
    }
  };

  document.addEventListener('DOMContentLoaded', function () {
    const activeTheme = getSavedTheme();
    applyTheme(activeTheme);
    updateToggleUI(activeTheme);
    dispatchThemeChanged(activeTheme);
    
    window.refreshQuizmokoIcons();
  });
})();
