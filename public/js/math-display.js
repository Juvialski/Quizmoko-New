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
    function looksLikeLogicalLineBreak(source, index, tokenWidth) {
        const before = source.slice(0, index);
        const after = source.slice(index + tokenWidth);
        const trimmedBefore = before.replace(/[ \t]+$/g, '');
        const trimmedAfter = after.replace(/^[ \t]+/g, '');
        const backticksBefore = (before.match(/`/g) || []).length;
        if (backticksBefore % 2 === 1) return false;
        if (/^(?:\$|<(?:div|img|br)\b|\[TIKZ\]|[•*-][ \t]+|\(?[a-h]\)?[.)]?[ \t]+|\(?i{1,3}\)?[.)]?[ \t]+)/.test(trimmedAfter)) return true;
        if (/^(?:\\(?:d?frac|sqrt|begin|left|boxed|overline|underline)\b)/.test(trimmedAfter)) return true;
        if (/[.?!:;]$/.test(trimmedBefore) && /^[A-Za-z0-9$<"'(\[]/.test(trimmedAfter)) return true;
        if (/[A-Za-z0-9]$/.test(trimmedBefore) && /^[A-Z]/.test(trimmedAfter)) return true;
        return false;
    }

    function decodeLegacyNewlines(value) {
        const source = String(value == null ? '' : value).replace(/\r\n?/g, '\n');
        let output = '';
        for (let index = 0; index < source.length; index += 1) {
            if (source[index] === '\\' && source[index + 1] === 'r' && source[index + 2] === '\\' && source[index + 3] === 'n') {
                if (looksLikeLogicalLineBreak(source, index, 4)) {
                    output += '\n';
                    index += 3;
                    continue;
                }
            }
            if (source[index] === '\\' && source[index + 1] === 'n') {
                const suffix = source.slice(index + 2);
                const latexNCommand = /^(?:abla\b|atural\b|e(?:q)?\b|eg\b|i\b|mid\b|ot(?:in)?\b|parallel\b|u\b)/.test(suffix);
                if (!latexNCommand && looksLikeLogicalLineBreak(source, index, 2)) {
                    output += '\n';
                    index += 1;
                    continue;
                }
            }
            output += source[index];
        }
        return output;
    }

    function normalizeMultipartQuestionLayout(value) {
        let text = String(value == null ? '' : value)
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n[ \t]+/g, '\n')
            .replace(/\n{3,}/g, '\n\n');

        const letterMatches = Array.from(text.matchAll(/(?:^|[ \t])(?:\([a-h]\)|[a-h][.)])(?=[ \t]+)/g));
        const letterLabels = letterMatches.map(match => match[0].trim().replace(/[().]/g, ''));
        const hasLetterPair = letterLabels.some((label, index) => label === 'a' && letterLabels.slice(index + 1).includes('b'));
        if (hasLetterPair) {
            text = text.replace(/([^\n])[ \t]+(\([a-h]\)|[a-h][.)])(?=[ \t]+)/g, '$1\n$2');
        }

        const romanMatches = Array.from(text.matchAll(/(?:^|[ \t])(?:\((i{1,3}|iv|v)\)|(i{1,3}|iv|v)[.)])(?=[ \t]+)/g));
        const romanLabels = romanMatches.map(match => match[1] || match[2] || '');
        const hasRomanPair = romanLabels.some((label, index) => label === 'i' && romanLabels.slice(index + 1).includes('ii'));
        if (hasRomanPair) {
            text = text.replace(/([^\n])[ \t]+(\((?:i{1,3}|iv|v)\)|(?:i{1,3}|iv|v)[.)])(?=[ \t]+)/g, '$1\n$2');
        }
        return text;
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

    function normalizeQuestionLayoutText(value) {
        return normalizeMultipartQuestionLayout(normalizeLatexText(value));
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
        normalizeQuestionLayoutText: normalizeQuestionLayoutText,
        protectTextNodes: protectTextNodes,
        typeset: typeset
    };
})();
