(function () {
    'use strict';

    function isEscaped(text, index) {
        let count = 0;
        for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) count += 1;
        return count % 2 === 1;
    }

    // Old records sometimes contain a literal backslash+n. Decode only when it
    // is clearly a line separator, never when it begins a LaTeX command such as
    // \neq, \nabla, \not, or \nu.
    function decodeLegacyNewlines(value) {
        return String(value == null ? '' : value)
            .replace(/\\n(?!abla\b|atural\b|e(?:q)?\b|eg\b|i\b|mid\b|ot(?:in)?\b|parallel\b|u\b)/g, '\n');
    }

    function latexDelimitersAreBalanced(value) {
        const text = String(value == null ? '' : value);
        let mode = null;
        let braceDepth = 0;
        for (let index = 0; index < text.length; index += 1) {
            if (text[index] === '$' && !isEscaped(text, index)) {
                const tokenMode = text[index + 1] === '$' ? 'display' : 'inline';
                if (mode === null) {
                    mode = tokenMode;
                    braceDepth = 0;
                } else if (mode === tokenMode) {
                    if (braceDepth !== 0) return false;
                    mode = null;
                } else {
                    return false;
                }
                if (tokenMode === 'display') index += 1;
                continue;
            }
            if (mode !== null && !isEscaped(text, index)) {
                if (text[index] === '{') braceDepth += 1;
                if (text[index] === '}') {
                    braceDepth -= 1;
                    if (braceDepth < 0) return false;
                }
            }
        }
        return mode === null;
    }

    function escapeUnbalancedDollarSigns(value) {
        const text = String(value == null ? '' : value);
        let output = '';
        for (let index = 0; index < text.length; index += 1) {
            if (text[index] === '$' && !isEscaped(text, index)) output += '\\$';
            else output += text[index];
        }
        return output;
    }

    function normalizeLatexText(value) {
        let text = decodeLegacyNewlines(value)
            .replace(/\r\n?/g, '\n')
            .replace(/\\\[([\s\S]*?)\\\]/g, function (_match, body) {
                return '$$' + String(body).trim() + '$$';
            })
            .replace(/\\\(([\s\S]*?)\\\)/g, function (_match, body) {
                return '$' + String(body).trim() + '$';
            });

        // Broken AI output should display safely as text rather than causing the
        // entire MathJax render pass to fail.
        if (!latexDelimitersAreBalanced(text)) text = escapeUnbalancedDollarSigns(text);
        return text;
    }

    function protectTextNodes(root) {
        const target = root || document.body;
        if (!target || typeof document.createTreeWalker !== 'function') return;
        const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        nodes.forEach(function (node) {
            const parent = node.parentElement;
            if (parent && /^(SCRIPT|STYLE|TEXTAREA|CODE|PRE)$/.test(parent.tagName)) return;
            node.nodeValue = normalizeLatexText(node.nodeValue);
        });
    }

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
        decodeLegacyNewlines: decodeLegacyNewlines,
        latexDelimitersAreBalanced: latexDelimitersAreBalanced,
        normalizeLatexText: normalizeLatexText,
        protectTextNodes: protectTextNodes,
        typeset: typeset
    };
})();
