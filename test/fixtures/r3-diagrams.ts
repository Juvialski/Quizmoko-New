const tikz=(source:string,prose='Use the diagram.')=>`${prose} [TIKZ]${source}[/TIKZ]`;
export const diagramFixtures=[
  {id:'points',question:tikz(String.raw`\coordinate (A) at (2,3); \node at (A) {A}; \draw (0,0)--(2,3);`,'Point A is at $(2,3)$.'),render:true},
  {id:'swapped',question:tikz(String.raw`\coordinate (A) at (3,2); \node at (A) {A};`,'Point A is at $(2,3)$.'),render:true,issue:'contradicts'},
  {id:'missing-label',question:tikz(String.raw`\coordinate (A) at (2,3); \draw (0,0)--(A);`,'Point A is at $(2,3)$.'),render:true,issue:'Missing visible label'},
  {id:'missing-point',question:tikz(String.raw`\coordinate (A) at (2,3); \node at (A) {A};`,'Point A is at $(2,3)$ and B is at $(4,5)$.'),render:true,issue:'Missing visible point B'},
  {id:'right-conflict',question:tikz(String.raw`\coordinate (A) at (0,0); \coordinate (B) at (2,0); \coordinate (C) at (1,2); \draw (A)--(B); \draw (B)--(C); \draw (C)--(A);`,'There is a right angle at A in triangle ABC.'),render:true,issue:'right angle contradicts'},
  {id:'right-triangle',question:tikz(String.raw`\coordinate (A) at (0,0); \coordinate (B) at (2,0); \coordinate (C) at (0,2); \draw (A)--(B); \draw (B)--(C); \draw (C)--(A);`,'There is a right angle at A in triangle ABC.'),render:true},
  {id:'circle',question:tikz(String.raw`\draw (0,0) circle (2); \node at (0,0) {O};`),render:true},
  {id:'grid',question:tikz(String.raw`\draw (-2,-2) grid (2,2);`),render:true},
  {id:'number-line',question:tikz(String.raw`\draw (-3,0)--(3,0); \node at (2,0) {2};`),render:true},
  {id:'bar',question:tikz(String.raw`\draw (0,0) rectangle (1,3); \node at (0.5,3) {3};`),render:true},
  {id:'empty',question:tikz(String.raw`\coordinate (A) at (0,0);`),render:false,issue:'empty'},
  {id:'resource',question:tikz(String.raw`\draw (0,0)--(10000,1);`),render:false,issue:'dimensions'},
  {id:'file-access',question:tikz(String.raw`\input{/etc/passwd}`),render:false,issue:'Unsafe'},
  {id:'obfuscation',question:tikz(String.raw`\csname input\endcsname{file}`),render:false,issue:'Unsafe'},
  {id:'curve',question:tikz(String.raw`\draw plot (\x,{\x*\x});`),render:false,issue:'does not cover'},
  {id:'unequal-scale',question:tikz(String.raw`\begin{tikzpicture}[xscale=2,yscale=1]\draw (0,0)--(2,2);\end{tikzpicture}`),render:false,issue:'does not cover'},
  {id:'invalid',question:tikz(String.raw`\draw (0,0)--(2,2)`),render:false,issue:'does not cover'}
];
