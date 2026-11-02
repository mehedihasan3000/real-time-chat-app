/**
 * Runs before hydration so the document language is correct on first paint.
 * It only reads the approved non-sensitive browser preference and falls back
 * to English when storage is unavailable or holds an unsupported value.
 */
export const localeInitScript = `(function () {
  var locale = "en";
  try {
    var stored = window.localStorage.getItem("chat-ui-locale");
    if (stored === "en" || stored === "bn") {
      locale = stored;
    }
  } catch (error) {
    locale = "en";
  }
  document.documentElement.lang = locale;
})();`;
