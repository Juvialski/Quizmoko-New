# QuizMoKo workspace foundations

The shared presentation lives in `public/css/ui-redesign.css`; existing `quizmoko-ui.css` remains the compatibility foundation. Page controllers retain academic state, provider calls and persistence. `views/partials/workspace-header.ejs` composes teacher navigation; `workspace-ui.js` supplies focus, disclosure entry, row labels and local date display.

| Token | Light | Dark |
| --- | --- | --- |
| Canvas | `#f5f6fa` | `#10131c` |
| Card | `#ffffff` | `#191e2b` |
| Soft surface | `#f5f6fa` | `#202636` |
| Main text | `#20283b` | `#f0f3fa` |
| Secondary text | `#596579` | `#aab4c8` |
| Primary action | `#6153cb` | `#7164e8` |
| Link/accent text | `#5747bd` | `#b7adff` |
| Confirmed success | `#15785d` | `#49caa0` |
| Warning | `#966117` | `#efbd65` |
| Destructive/error | `#bb334b` | `#ff9199` |

Spacing uses 4/8/12/16/24/32px increments. Body text uses Inter with system fallbacks; page titles use 25–30px, reading text 15–21px and secondary metadata 11–13px. Forms use 44px controls and 8px corners. Cards use 12–14px corners. Disclosures use 48px headers, keyboard-native expansion and visible focus. Mobile reorder, answer approval and navigation controls retain practical touch targets.

Primary violet identifies creation and saving. Green identifies confirmed state and active classroom entry. Warnings and review-required text remain explicit; color alone never decides correctness. Buttons share hover/focus/disabled treatment and avoid animated geometry. Reduced-motion preferences disable transitions and smooth navigation.

Teacher content uses the available width up to 1440px. Create Quiz uses one heading and method navigation across AI, manual and worksheet inputs. AI/manual forms use a readable 1040px maximum. Desktop worksheet uploads place source files beside their existing options and extraction action; paired question/key inputs share a row, then stack on mobile. Review uses the existing full-width composition. Inactive retained panels must remain hidden even under display-grid rules. Live and results tables become labelled rows below 760px. Mobile quiz questions keep their full reading width, with the existing working canvas below them. Paper exports retain their own physical dimensions and print reset.

No component decides whether an answer is correct, whether a quiz is publishable, or whether a write succeeded. Those decisions continue to use existing server validation and acknowledged saves.
