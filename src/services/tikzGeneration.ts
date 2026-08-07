const TIKZ_BLOCK_PATTERN = /\[TIKZ\]([\s\S]*?)\[\/TIKZ\]/gi;

export type TikzVisualFamily =
  | 'cartesian'
  | 'geometry'
  | 'table'
  | 'chart'
  | 'venn'
  | 'tree'
  | 'number_line'
  | 'model'
  | 'flow'
  | 'timeline'
  | 'schematic';

export interface TikzVisualIntent {
  id: string;
  family: TikzVisualFamily;
  label: string;
  goal: string;
  guidance: string;
}

export interface TikzVisualPlanEntry {
  required: boolean;
  intent?: TikzVisualIntent;
}

export interface TikzRequirementCheck {
  valid: boolean;
  count: number;
  reason?: string;
}

const intent = (
  id: string,
  family: TikzVisualFamily,
  label: string,
  goal: string,
  guidance: string
): TikzVisualIntent => ({ id, family, label, goal, guidance });

const INTENTS = {
  derivative_tangent: intent(
    'derivative_tangent_graph', 'cartesian', 'function graph with tangent line',
    'make the student interpret a derivative as the slope of a tangent',
    'Draw readable x/y axes, one smooth function curve, a marked point, and a tangent line at that point. Keep labels sparse and do not state the derivative value on the diagram.'
  ),
  derivative_critical: intent(
    'derivative_critical_points_graph', 'cartesian', 'curve-behavior graph',
    'make the student reason about increasing/decreasing behavior or a local extremum',
    'Draw readable x/y axes and one smooth curve with a clear turning point or change in monotonic behavior. Mark only locations needed by the question; do not label the answer.'
  ),
  derivative_secant: intent(
    'derivative_secant_graph', 'cartesian', 'function graph with secant line',
    'make the student compare average and instantaneous rates of change',
    'Draw x/y axes, a smooth function curve, two marked points, and a secant line. Keep coordinate labels readable and avoid revealing a computed slope.'
  ),
  function_graph: intent(
    'cartesian_function_graph', 'cartesian', 'Cartesian function graph',
    'make the student read or reason from a plotted function',
    'Draw x/y axes with sensible ticks and one or two clearly distinguishable curves using base TikZ plot/coordinates. Use a grid only when it helps precise reading.'
  ),
  unit_circle: intent(
    'unit_circle', 'geometry', 'unit-circle diagram',
    'make the student reason from an angle or trigonometric coordinate',
    'Draw a circle centered at the origin with axes, one radius, and only the angle/point labels needed by the question.'
  ),
  triangle: intent(
    'labeled_triangle', 'geometry', 'labeled triangle diagram',
    'make the student reason from side, angle, or trigonometric relationships',
    'Draw a clean triangle with readable vertex/side/angle labels. Do not draw it misleadingly to scale when the values do not imply that shape.'
  ),
  geometry: intent(
    'labeled_geometry_diagram', 'geometry', 'labeled geometric figure',
    'make the student reason from a geometric configuration',
    'Draw only the necessary points, segments, arcs, parallel/right-angle marks, circles, or polygons. Keep labels outside crowded intersections and never reveal the target value.'
  ),
  coordinate_geometry: intent(
    'coordinate_geometry_diagram', 'cartesian', 'coordinate-geometry diagram',
    'make the student reason from points, lines, or shapes on a coordinate plane',
    'Draw x/y axes, sensible ticks, labeled points, and the required segments/shape. Use a light grid only when coordinates must be read.'
  ),
  probability_tree: intent(
    'probability_tree', 'tree', 'probability tree',
    'make the student combine sequential outcomes or conditional probabilities',
    'Draw a left-to-right branching tree with compact outcome/probability labels. Use arrows or branches consistently and do not annotate the final answer.'
  ),
  venn: intent(
    'venn_diagram', 'venn', 'Venn diagram',
    'make the student reason about sets, overlap, or inclusion-exclusion',
    'Draw two or three overlapping circles inside a universe rectangle when appropriate. Label sets clearly and place counts/elements in unambiguous regions.'
  ),
  sample_table: intent(
    'sample_space_table', 'table', 'sample-space table',
    'make the student read a finite sample space or two-way outcomes',
    'Draw a compact TikZ table using rectangles/lines and nodes, with clear row and column headers. Keep it small enough to read on a quiz screen.'
  ),
  data_table: intent(
    'data_table', 'table', 'data table',
    'make the student use organized values rather than a decorative picture',
    'Draw a compact table with clear headers and aligned cell values using basic TikZ lines/rectangles/nodes. Prefer 2-5 columns and 2-6 data rows.'
  ),
  bar_chart: intent(
    'bar_chart', 'chart', 'bar chart',
    'make the student compare categorical quantities',
    'Draw axes, readable category labels, and at least three bars with sensible scale/ticks. Use plain filled rectangles; do not print the conclusion/answer.'
  ),
  scatter: intent(
    'scatter_plot', 'chart', 'scatter plot',
    'make the student interpret association, trend, or an outlier',
    'Draw x/y axes with labels and several clearly visible points. Do not draw a best-fit line unless the question specifically requires one.'
  ),
  histogram: intent(
    'frequency_chart', 'chart', 'frequency chart',
    'make the student interpret frequencies or grouped data',
    'Draw a clear frequency-style chart with adjacent bars when intervals are continuous, readable ticks, and concise axis labels.'
  ),
  fraction_model: intent(
    'fraction_area_model', 'model', 'fraction area model',
    'make the student reason visually about a fraction or fraction operation',
    'Draw a rectangle or circle partitioned into equal parts with a subset shaded. Ensure every part is equal and the shading does not reveal a different fraction than the question.'
  ),
  number_line: intent(
    'number_line', 'number_line', 'number line',
    'make the student compare, locate, or operate on numbers',
    'Draw one horizontal number line with arrowheads/ticks and only the labels needed by the question. Space tick marks consistently.'
  ),
  double_number_line: intent(
    'double_number_line', 'number_line', 'double number line',
    'make the student reason about proportional quantities',
    'Draw two aligned horizontal number lines with matching tick positions and labels for the two quantities. Do not fill in the unknown answer.'
  ),
  ratio_table: intent(
    'ratio_table', 'table', 'ratio table',
    'make the student reason about equivalent ratios or rates',
    'Draw a two-row or two-column table with corresponding quantities aligned. Leave the target entry unknown if that is what the student must find.'
  ),
  bar_model: intent(
    'bar_model', 'model', 'bar model',
    'make the student reason about parts, ratios, or comparison quantities',
    'Draw aligned segmented bars with equal-width units where appropriate. Label known quantities outside the bars and leave the unknown as a symbol/question mark.'
  ),
  pattern: intent(
    'visual_sequence_pattern', 'model', 'visual sequence pattern',
    'make the student infer a pattern or nth-term relationship',
    'Draw three or four successive compact figures using simple shapes, with stage labels. Keep the rule discoverable but do not draw the requested future stage if that would reveal the answer.'
  ),
  motion_graph: intent(
    'motion_graph', 'cartesian', 'motion graph',
    'make the student interpret displacement, velocity, or acceleration over time',
    'Draw labeled time and motion axes with a clear piecewise/smooth graph and readable key points. Units must match the question.'
  ),
  free_body: intent(
    'free_body_diagram', 'schematic', 'free-body diagram',
    'make the student reason about forces and direction',
    'Draw a simple object as a box/point with directional arrows and concise force labels. Arrow directions and relative meaning must be physically consistent.'
  ),
  ray: intent(
    'ray_diagram', 'schematic', 'ray diagram',
    'make the student reason about reflection/refraction or image formation',
    'Draw the relevant surface/lens/mirror, normal or principal axis, and only the necessary rays with arrowheads. Keep angles and labels legible.'
  ),
  particle: intent(
    'particle_diagram', 'schematic', 'particle diagram',
    'make the student reason about particle arrangement, composition, or change',
    'Use simple circles/nodes to represent particles with a clear legend when more than one species appears. Keep counts and arrangements chemically consistent.'
  ),
  apparatus: intent(
    'apparatus_schematic', 'schematic', 'scientific apparatus schematic',
    'make the student interpret an experimental setup or measurement arrangement',
    'Draw a simplified apparatus with only essential components and labels. Use basic TikZ shapes/lines rather than decorative realism.'
  ),
  process: intent(
    'process_diagram', 'flow', 'process/flow diagram',
    'make the student reason about stages, sequence, or cause/effect',
    'Draw 3-6 labeled nodes connected by arrows in a clear direction. Avoid crossing arrows and do not mark one node as the correct answer.'
  ),
  labeled_schematic: intent(
    'labeled_schematic', 'schematic', 'labeled schematic',
    'make the student identify or reason from a simplified structure',
    'Draw a clean simplified structure using basic shapes/lines and a small number of readable labels or lettered callouts.'
  ),
  supply_demand: intent(
    'supply_demand_graph', 'cartesian', 'supply-and-demand graph',
    'make the student reason about equilibrium or a curve shift',
    'Draw Price and Quantity axes plus clearly labeled upward/downward curves. Mark equilibrium only when needed and do not label the requested answer.'
  ),
  flow: intent(
    'flow_diagram', 'flow', 'flow diagram',
    'make the student reason about a process, algorithm, or dependency',
    'Draw 3-6 compact nodes with arrows and clear labels. Keep paths unambiguous and avoid decorative branches unrelated to the question.'
  ),
  tree: intent(
    'tree_diagram', 'tree', 'tree diagram',
    'make the student reason about hierarchy, recursion, or branching structure',
    'Draw a small rooted tree with 2-4 levels, readable node labels, and non-crossing edges.'
  ),
  state: intent(
    'state_diagram', 'flow', 'state diagram',
    'make the student reason about transitions between states',
    'Draw a small set of circular/rounded state nodes with directed transition arrows and concise transition labels.'
  ),
  timeline: intent(
    'timeline', 'timeline', 'timeline',
    'make the student reason about chronology, sequence, or elapsed time',
    'Draw a horizontal timeline with 3-6 clearly spaced events/dates and concise labels. Do not highlight the correct choice.'
  ),
  sentence_tree: intent(
    'sentence_structure_diagram', 'tree', 'sentence-structure diagram',
    'make the student reason about grammatical structure or relationships',
    'Draw a small hierarchy/tree with phrase/word labels and clean branching. Preserve the exact supplied words and punctuation.'
  )
} as const;

function normalized(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[_/\\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function includesAny(value: string, terms: readonly string[]): boolean {
  return terms.some(term => value.includes(term));
}

export function inferTikzVisualIntents(subject: unknown, topic: unknown): TikzVisualIntent[] {
  const subjectText = normalized(subject);
  const topicText = normalized(topic);
  const combined = `${subjectText} ${topicText}`.trim();

  // Topic-specific rules come first so a broad subject such as Mathematics or
  // Science does not erase the most useful representation for the lesson.
  if (includesAny(combined, ['derivative', 'differentiation', 'tangent slope', 'instantaneous rate'])) {
    return [INTENTS.derivative_tangent, INTENTS.derivative_critical, INTENTS.derivative_secant];
  }
  if (includesAny(combined, ['integral', 'integration', 'area under', 'accumulation'])) {
    return [
      { ...INTENTS.function_graph, id: 'area_under_curve_graph', label: 'area-under-curve graph', goal: 'make the student reason about definite integral or accumulated area', guidance: `${INTENTS.function_graph.guidance} Shade only the region relevant to the question without writing its area.` },
      INTENTS.data_table,
      INTENTS.function_graph
    ];
  }
  if (includesAny(combined, ['trigonometry', 'trigonometric', 'sine', 'cosine', 'unit circle'])) {
    return [INTENTS.triangle, INTENTS.unit_circle, INTENTS.function_graph];
  }
  if (includesAny(combined, ['probability', 'sample space', 'conditional probability', 'independent events'])) {
    return [INTENTS.probability_tree, INTENTS.venn, INTENTS.sample_table];
  }
  if (includesAny(combined, ['statistics', 'scatter', 'correlation', 'data analysis', 'frequency', 'histogram'])) {
    return [INTENTS.bar_chart, INTENTS.scatter, INTENTS.data_table, INTENTS.histogram];
  }
  if (includesAny(combined, ['fraction', 'mixed number'])) {
    return [INTENTS.fraction_model, INTENTS.number_line, INTENTS.data_table];
  }
  if (includesAny(combined, ['ratio', 'proportion', 'rate', 'percent'])) {
    return [INTENTS.double_number_line, INTENTS.ratio_table, INTENTS.bar_model];
  }
  if (includesAny(combined, ['set theory', 'sets', 'venn', 'inclusion exclusion'])) {
    return [INTENTS.venn, INTENTS.sample_table];
  }
  if (includesAny(combined, ['sequence', 'pattern', 'nth term', 'arithmetic progression', 'geometric progression'])) {
    return [INTENTS.pattern, INTENTS.data_table, INTENTS.number_line];
  }
  if (includesAny(combined, ['coordinate geometry', 'analytic geometry', 'coordinate plane'])) {
    return [INTENTS.coordinate_geometry, INTENTS.geometry, INTENTS.data_table];
  }
  if (includesAny(combined, ['geometry', 'triangle', 'quadrilateral', 'polygon', 'circle theorem', 'angle'])) {
    return [INTENTS.geometry, INTENTS.coordinate_geometry, INTENTS.data_table];
  }
  if (includesAny(combined, ['function', 'quadratic', 'polynomial', 'linear equation', 'inequality', 'graph'])) {
    return [INTENTS.function_graph, INTENTS.data_table, INTENTS.coordinate_geometry];
  }

  if (includesAny(combined, ['kinematics', 'velocity', 'acceleration', 'displacement', 'motion'])) {
    return [INTENTS.motion_graph, INTENTS.data_table, INTENTS.free_body];
  }
  if (includesAny(combined, ['force', 'newton', 'mechanics', 'friction'])) {
    return [INTENTS.free_body, INTENTS.motion_graph, INTENTS.data_table];
  }
  if (includesAny(combined, ['optics', 'reflection', 'refraction', 'lens', 'mirror'])) {
    return [INTENTS.ray, INTENTS.geometry, INTENTS.data_table];
  }
  if (includesAny(combined, ['electric', 'circuit', 'current', 'voltage', 'resistance'])) {
    return [INTENTS.labeled_schematic, INTENTS.data_table, INTENTS.flow];
  }
  if (includesAny(combined, ['chemistry', 'chemical', 'molecule', 'atom', 'particle', 'reaction'])) {
    return [INTENTS.particle, INTENTS.apparatus, INTENTS.data_table];
  }
  if (includesAny(combined, ['biology', 'cell', 'organ', 'ecosystem', 'photosynthesis', 'respiration'])) {
    return [INTENTS.labeled_schematic, INTENTS.process, INTENTS.data_table];
  }
  if (includesAny(combined, ['supply', 'demand', 'economics', 'market equilibrium', 'elasticity'])) {
    return [INTENTS.supply_demand, INTENTS.data_table, INTENTS.bar_chart];
  }
  if (includesAny(combined, ['computer science', 'data science', 'programming', 'algorithm', 'software', 'data structure'])) {
    return [INTENTS.flow, INTENTS.tree, INTENTS.state];
  }
  if (includesAny(combined, ['history', 'social studies', 'social science', 'chronology', 'historical'])) {
    return [INTENTS.timeline, INTENTS.data_table, INTENTS.process];
  }
  if (includesAny(combined, ['english', 'grammar', 'literature', 'language arts'])) {
    return [INTENTS.sentence_tree, INTENTS.process, INTENTS.data_table];
  }
  if (includesAny(combined, ['physics', 'physical science', 'science', 'engineering'])) {
    return [INTENTS.data_table, INTENTS.labeled_schematic, INTENTS.function_graph];
  }

  // Subject-only fallbacks keep custom topics useful without pretending that a
  // random Cartesian graph is always the right visual.
  if (includesAny(subjectText, ['math', 'mathematics'])) return [INTENTS.function_graph, INTENTS.geometry, INTENTS.data_table];
  if (includesAny(subjectText, ['science', 'physics', 'chemistry', 'biology'])) return [INTENTS.labeled_schematic, INTENTS.data_table, INTENTS.process];
  if (includesAny(subjectText, ['computer', 'programming', 'ict'])) return [INTENTS.flow, INTENTS.tree, INTENTS.state];
  if (includesAny(subjectText, ['history', 'social', 'geography'])) return [INTENTS.timeline, INTENTS.data_table, INTENTS.process];
  if (includesAny(subjectText, ['english', 'literature', 'language'])) return [INTENTS.sentence_tree, INTENTS.process, INTENTS.data_table];
  return [INTENTS.data_table, INTENTS.flow, INTENTS.bar_chart];
}

export function buildTikzRequirementPlan(totalQuestions: number, requestedDiagrams: number): boolean[] {
  const total = Math.max(0, Math.floor(Number(totalQuestions) || 0));
  const requested = Math.min(total, Math.max(0, Math.floor(Number(requestedDiagrams) || 0)));
  const plan = Array<boolean>(total).fill(false);
  if (requested === 0 || total === 0) return plan;

  // Spread requested diagrams through the quiz instead of front-loading them
  // into the first generation batch. Because total/requested >= 1, these
  // midpoint indices are distinct whenever requested <= total.
  for (let index = 0; index < requested; index += 1) {
    const position = Math.min(total - 1, Math.floor(((index + 0.5) * total) / requested));
    plan[position] = true;
  }
  return plan;
}

export function buildTikzVisualPlan(
  totalQuestions: number,
  requestedDiagrams: number,
  subject: unknown,
  topic: unknown
): TikzVisualPlanEntry[] {
  const requirements = buildTikzRequirementPlan(totalQuestions, requestedDiagrams);
  const candidates = inferTikzVisualIntents(subject, topic);
  let nextIntent = 0;
  return requirements.map(required => {
    if (!required) return { required: false };
    const selected = candidates[nextIntent % candidates.length];
    nextIntent += 1;
    return { required: true, intent: selected };
  });
}

const GENERIC_LABEL_GUIDANCE = 'Keep labels away from curves, lines, points, axes, arrows, vertices, and other labels. For graph/geometry annotations use relative node placement such as above/below/left/right, anchor=..., xshift=..., or yshift=...; path-attached labels with node[pos=...] are preferred for lines/curves. Keep annotation text at normal, small, or footnotesize scale. Table-cell and flow-node text may be centered inside its own cell/node.';

export function formatTikzVisualPlanEntry(entry: TikzVisualPlanEntry): string {
  if (!entry.required || !entry.intent) return 'diagram_required="no"';
  const safe = (value: string) => value.replace(/["\n\r]+/g, ' ').replace(/\s+/g, ' ').trim();
  return [
    'diagram_required="yes"',
    `visual_intent="${safe(entry.intent.id)}"`,
    `visual_goal="${safe(entry.intent.goal)}"`,
    `visual_guidance="${safe(`${entry.intent.guidance} ${GENERIC_LABEL_GUIDANCE}`)}"`
  ].join(', ');
}

export function extractTikzBlocks(value: unknown): string[] {
  const source = String(value ?? '');
  return Array.from(source.matchAll(TIKZ_BLOCK_PATTERN), match => String(match[1] || '').trim());
}

export function hasTikzDiagram(value: unknown): boolean {
  return extractTikzBlocks(value).some(block => block.length > 0);
}

function commandCount(code: string): number {
  return Array.from(code.matchAll(/\\(?:draw|path|node|fill|filldraw|coordinate)\b/gi)).length;
}

function occurrenceCount(code: string, pattern: RegExp): number {
  return Array.from(code.matchAll(pattern)).length;
}

function questionRefersToVisual(value: unknown): boolean {
  const withoutTikz = String(value ?? '').replace(TIKZ_BLOCK_PATTERN, ' ');
  return /\b(?:graph|diagram|figure|table|chart|plot|number line|tree|timeline|model|shown|displayed|below|above|illustration|coordinate plane|schematic)\b/i.test(withoutTikz);
}

function validateVisualFamily(code: string, visual: TikzVisualIntent): string | null {
  const draws = occurrenceCount(code, /\\draw\b/gi);
  const nodes = occurrenceCount(code, /\\node\b/gi);
  const arrows = occurrenceCount(code, /(?:->|<-|<->)/g);
  const circles = occurrenceCount(code, /\bcircle\b/gi);
  const rectangles = occurrenceCount(code, /\brectangle\b/gi);
  const fills = occurrenceCount(code, /\\(?:fill|filldraw)\b/gi);

  switch (visual.family) {
    case 'cartesian':
      if (draws < 2 || !/(?:\bplot\b|coordinates|controls|parabola)/i.test(code)) {
        return `${visual.label} must contain readable axes/geometry plus an actual plotted curve or coordinate series.`;
      }
      return null;
    case 'geometry':
      if (!/(?:\bcircle\b|\brectangle\b|\barc\b|--)/i.test(code) || draws < 1) {
        return `${visual.label} must contain a real geometric construction, not only text labels.`;
      }
      return null;
    case 'table':
      if (nodes < 4 || (!/\b(?:rectangle|grid)\b/i.test(code) && draws < 4)) {
        return `${visual.label} must be drawn as a readable grid/table with several cells and labels.`;
      }
      return null;
    case 'chart':
      if (draws < 2 || (rectangles < 2 && circles < 3 && !/\bplot\b|coordinates/i.test(code))) {
        return `${visual.label} must contain axes/scale plus multiple data marks (bars, points, or plotted coordinates).`;
      }
      return null;
    case 'venn':
      if (circles < 2) return 'A Venn diagram must contain at least two overlapping circles.';
      return null;
    case 'tree':
      if (nodes < 3 || (arrows < 2 && draws < 2 && occurrenceCount(code, /\bchild\b/gi) < 2)) return `${visual.label} must contain several nodes connected by branches/arrows.`;
      return null;
    case 'number_line':
      if (draws < 2 || (nodes < 2 && occurrenceCount(code, /--/g) < 3)) return `${visual.label} must contain a line, multiple ticks, and readable labels.`;
      return null;
    case 'model':
      if ((fills < 1 && visual.id.includes('fraction')) || (rectangles + circles < 1 && draws < 2)) return `${visual.label} must contain actual visual parts/shapes rather than only labels.`;
      return null;
    case 'flow':
      if (nodes < 3 || arrows < 2) return `${visual.label} must contain at least three nodes and directed connections.`;
      return null;
    case 'timeline':
      if (draws < 1 || nodes < 3) return 'A timeline must contain a main line and several clearly labeled events.';
      return null;
    case 'schematic':
      if (commandCount(code) < 3) return `${visual.label} is too sparse to function as a meaningful schematic.`;
      return null;
    default:
      return null;
  }
}


function validateLabelPlacement(code: string, visual: TikzVisualIntent): string | null {
  if (/\\(?:Large|LARGE|huge|Huge|HUGE)\b/.test(code)) {
    return 'TikZ annotations are oversized. Use normal, \\small, or \\footnotesize labels so they do not dominate the visual.';
  }

  // Tables and flow/state diagrams intentionally center text inside cells/nodes,
  // so collision heuristics below are only useful for free-positioned annotations.
  const freeLabelFamilies = new Set<TikzVisualFamily>(['cartesian', 'geometry']);
  if (!freeLabelFamilies.has(visual.family)) return null;

  const nodePattern = /\\node(?:\[([^\]]*)\])?\s+at\s*\([^)]*\)\s*\{([^{}]*)\}/gi;
  for (const match of code.matchAll(nodePattern)) {
    const options = String(match[1] || '').toLowerCase();
    const label = String(match[2] || '').trim();
    if (!label) continue;
    // Numeric tick labels are often intentionally positioned at already-offset
    // coordinates such as (1,-0.3); do not mistake those for curve annotations.
    const compactLabel = label.replace(/\$/g, '').replace(/\\,/g, '').trim();
    if (/^[-+]?\d+(?:\.\d+)?$/.test(compactLabel)) continue;
    const hasPlacement = /(?:\babove\b|\bbelow\b|\bleft\b|\bright\b|anchor\s*=|xshift\s*=|yshift\s*=)/i.test(options);
    if (!hasPlacement) {
      return `Label "${label.slice(0, 40)}" is placed at an exact coordinate without an offset/anchor. Offset graph and geometry labels so they do not sit directly on the referenced object.`;
    }
  }

  // Path-attached nodes are preferred, but when used they still need a side/shift
  // unless they are deliberately placed at an endpoint with an anchor.
  const attachedNodePattern = /\bnode\s*(?:\[([^\]]*)\])?\s*\{([^{}]*)\}/gi;
  for (const match of code.matchAll(attachedNodePattern)) {
    const options = String(match[1] || '').toLowerCase();
    const label = String(match[2] || '').trim();
    if (!label || !/pos\s*=/.test(options)) continue;
    const hasPlacement = /(?:\babove\b|\bbelow\b|\bleft\b|\bright\b|anchor\s*=|xshift\s*=|yshift\s*=)/i.test(options);
    if (!hasPlacement) {
      return `Path label "${label.slice(0, 40)}" needs a side or shift (for example right=4pt or above=3pt) so it does not overlap the path.`;
    }
  }
  return null;
}

export function validateTikzRequirement(
  value: unknown,
  required: boolean,
  visualIntent?: TikzVisualIntent
): TikzRequirementCheck {
  const blocks = extractTikzBlocks(value);
  if (!required) {
    return blocks.length === 0
      ? { valid: true, count: 0 }
      : { valid: false, count: blocks.length, reason: 'This question was not assigned a diagram but contains a [TIKZ] block.' };
  }

  if (blocks.length !== 1) {
    return {
      valid: false,
      count: blocks.length,
      reason: blocks.length === 0
        ? 'This question requires exactly one TikZ diagram, but none was returned.'
        : 'This question requires exactly one TikZ diagram, but multiple [TIKZ] blocks were returned.'
    };
  }

  const code = blocks[0];
  if (!code) return { valid: false, count: 1, reason: 'The required [TIKZ] block is empty.' };
  if (code.length < 70) return { valid: false, count: 1, reason: 'The required TikZ diagram is too sparse to be a useful quiz visual.' };
  if (code.length > 14_000) return { valid: false, count: 1, reason: 'The TikZ diagram is unnecessarily large; simplify it for reliable rendering.' };

  // QuizMoKo renders with the base TikZ package. Keep model output inside a
  // deliberately small, reliable subset so Kroki does not depend on extra
  // packages/libraries or external resources.
  if (/\\begin\s*\{axis\}|\\addplot\b|pgfplots|\\usetikzlibrary\b|\\usepackage\b|\\documentclass\b|\\includegraphics\b|\\input\b|\\write18\b/i.test(code)) {
    return {
      valid: false,
      count: 1,
      reason: 'The TikZ diagram uses unsupported packages, libraries, or external-input commands. Use self-contained base TikZ only.'
    };
  }

  if (!/\\(?:draw|path|node|fill|filldraw|coordinate)\b/i.test(code) || commandCount(code) < 2) {
    return {
      valid: false,
      count: 1,
      reason: 'The TikZ block does not contain enough usable drawing content.'
    };
  }

  if (!questionRefersToVisual(value)) {
    return {
      valid: false,
      count: 1,
      reason: 'A required visual must be integrated into the question; the stem should explicitly refer to the graph, diagram, table, or figure.'
    };
  }

  if (visualIntent) {
    const familyError = validateVisualFamily(code, visualIntent);
    if (familyError) return { valid: false, count: 1, reason: familyError };
    const labelError = validateLabelPlacement(code, visualIntent);
    if (labelError) return { valid: false, count: 1, reason: labelError };
  }

  return { valid: true, count: 1 };
}
