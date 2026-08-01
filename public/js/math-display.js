(function () {
    'use strict';

    function normalizeLatexText(value) {
        return String(value == null ? '' : value);
    }

    function protectTextNodes() {}

    function typeset(root, attempt) {
        const target = root || document.body;
        const retry = Number.isInteger(attempt) ? attempt : 0;
        if (window.MathJax && typeof window.MathJax.typesetPromise === 'function') {
            return window.MathJax.typesetPromise([target]).catch(function (error) {
                console.error('MathJax rendering failed:', error);
            });
        }
        if (retry < 100) {
            window.setTimeout(function () { typeset(target, retry + 1); }, 50);
        }
        return Promise.resolve();
    }

    window.QuizMoKoMath = {
        normalizeLatexText: normalizeLatexText,
        protectTextNodes: protectTextNodes,
        typeset: typeset
    };
})();
