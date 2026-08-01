(function () {
    'use strict';

    function normalizeLatexText(value) {
        let text = String(value == null ? '' : value);
        text = text.replace(
            /\$\\\$\$?([0-9][\d,]*(?:\.\d+)?)/g,
            function (_match, amount) { return '$\\text{\\$' + amount + '}$'; }
        );
        text = text.replace(
            /(^|[\s(])\$(\d[\d,]*(?:\.\d{1,2})?)(?=$|[\s.,;:!?)])/g,
            function (_match, prefix, amount) { return prefix + '$\\text{\\$' + amount + '}$'; }
        );
        text = text.replace(
            /(^|[^\d\\$])(-?\d[\d,]*(?:\.\d+)?)%(?!\s*\$)/g,
            function (_match, prefix, amount) { return prefix + '$' + amount + '\\%$'; }
        );
        return text;
    }

    function protectTextNodes(root) {
        if (!root || !document.createTreeWalker) return;
        const skippedTags = new Set([
            'SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'OPTION', 'CODE', 'PRE', 'MJX-CONTAINER'
        ]);
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const textNodes = [];
        while (walker.nextNode()) textNodes.push(walker.currentNode);
        textNodes.forEach(function (node) {
            const parent = node.parentElement;
            if (!parent || skippedTags.has(parent.tagName) || parent.closest('mjx-container')) return;
            const normalized = normalizeLatexText(node.nodeValue || '');
            if (normalized !== node.nodeValue) node.nodeValue = normalized;
        });
    }

    function typeset(root, attempt) {
        const target = root || document.body;
        const retry = Number.isInteger(attempt) ? attempt : 0;
        protectTextNodes(target);
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
