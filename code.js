// Draw Flow — draw FigJam-style connector arrows between two selected objects in Figma Design.
//
// Runtime facts (verified 2026-09-15 in the plugin sandbox, editorType "figma"):
//  - `figma.createConnector()` does not exist in Figma Design (FigJam only).
//  - `connector.clone()` throws "Cloning CONNECTOR nodes is not supported in the current editor".
//    (It DOES work in Figma's MCP `use_figma` runtime, which is privileged — not a plugin.)
// Strategy, in order:
//  1. Template mode: a connector loaded as template (stored in figma.root pluginData, or the first
//     connector found in the file) is DUPLICATED via the first strategy that the sandbox allows —
//     direct clone, else clone of a temporary wrapping SECTION — and the duplicate is re-pointed.
//     The template itself is never consumed.
//  2. Re-point mode: if the selection contains a CONNECTOR (not the template) plus two objects,
//     that connector is re-pointed (user duplicated it with ⌘D).
//  3. Static vector arrow with per-end stroke caps — always works in Design.
// Endpoint rules (from in-plugin diagnostics + probes, 2026-09-15):
//  - Any unlocked node works, nested or not: frames, rectangles, instances, FigJam shapes, or {position}.
//  - LOCKED nodes are rejected ("Connecting to this node type is not supported").
//  - Layers INSIDE an instance (ids like "I123:4;5:6") are rejected ("Invalid endpointNodeId").
//    For those we create an invisible unlocked "anchor" rectangle (no fill/stroke) at the same
//    absolute position inside the instance's parent frame, and attach the connector to that.

figma.showUI(__html__, { width: 320, height: 620, themeColors: true });

const SETTINGS_KEY = 'drawflow.settings.v1';
const MAGNETS = ['AUTO', 'TOP', 'LEFT', 'RIGHT', 'BOTTOM', 'CENTER'];
const CAPS = ['NONE', 'ARROW_LINES', 'ARROW_EQUILATERAL', 'TRIANGLE_FILLED', 'DIAMOND_FILLED', 'CIRCLE_FILLED'];
const LINE_TYPES = ['ELBOWED', 'STRAIGHT', 'CURVED'];

const DEFAULTS = {
  startMagnet: 'AUTO',
  endMagnet: 'AUTO',
  startCap: 'NONE',
  endCap: 'ARROW_LINES',
  lineType: 'ELBOWED',
  strokeWeight: 4,
  color: '#757575',
  cornerRadius: 24
};

// ---------- helpers ----------

function pick(list, value, fallback) {
  return list.indexOf(value) >= 0 ? value : fallback;
}

function sanitize(raw) {
  const s = Object.assign({}, DEFAULTS, raw || {});
  s.startMagnet = pick(MAGNETS, s.startMagnet, DEFAULTS.startMagnet);
  s.endMagnet = pick(MAGNETS, s.endMagnet, DEFAULTS.endMagnet);
  s.startCap = pick(CAPS, s.startCap, DEFAULTS.startCap);
  s.endCap = pick(CAPS, s.endCap, DEFAULTS.endCap);
  s.lineType = pick(LINE_TYPES, s.lineType, DEFAULTS.lineType);
  s.strokeWeight = Math.min(100, Math.max(0.1, Number(s.strokeWeight) || DEFAULTS.strokeWeight));
  s.color = /^#[0-9a-fA-F]{6}$/.test(String(s.color)) ? s.color : DEFAULTS.color;
  s.cornerRadius = Math.max(0, Number(s.cornerRadius) || 0);
  return s;
}

function hexToRgb(hex) {
  return {
    r: parseInt(hex.slice(1, 3), 16) / 255,
    g: parseInt(hex.slice(3, 5), 16) / 255,
    b: parseInt(hex.slice(5, 7), 16) / 255
  };
}

// figma.currentPage.selection is in LAYER order, not click order. We reconstruct click order by
// diffing successive selections: nodes that stay keep their rank, newly added nodes go last.
// (A marquee selection adds several at once → falls back to layer order for those.)
let clickOrder = [];

function updateClickOrder() {
  const ids = figma.currentPage.selection.map(function (n) { return n.id; });
  clickOrder = clickOrder.filter(function (id) { return ids.indexOf(id) >= 0; })
    .concat(ids.filter(function (id) { return clickOrder.indexOf(id) < 0; }));
}

// Split the selection into arrow targets (in click order) and (optionally) a connector to re-point.
function selectedTargets() {
  const targets = figma.currentPage.selection.filter(function (n) { return n.type !== 'CONNECTOR'; });
  return targets.slice().sort(function (a, b) { return clickOrder.indexOf(a.id) - clickOrder.indexOf(b.id); });
}
function selectedConnector() {
  const c = figma.currentPage.selection.filter(function (n) { return n.type === 'CONNECTOR'; });
  return c.length ? c[0] : null;
}

// Connector endpoints must be direct children of a PAGE or SECTION.
function topLevelAncestor(node) {
  let n = node;
  while (n.parent && n.parent.type !== 'PAGE' && n.parent.type !== 'SECTION') n = n.parent;
  return n;
}

function selectionSummary() {
  const sel = selectedTargets();
  return {
    type: 'selection',
    count: sel.length,
    hasConnector: !!selectedConnector(),
    nodes: sel.slice(0, 2).map(function (n) {
      const top = topLevelAncestor(n);
      return { id: n.id, name: n.name, type: n.type, inInstance: isInstanceSublayer(n), locked: !!n.locked };
    })
  };
}

// Nearest PAGE/SECTION that contains both nodes — connectors live at page/section level.
function commonContainer(a, b) {
  const containers = [];
  let p = a.parent;
  while (p) {
    if (p.type === 'PAGE' || p.type === 'SECTION') containers.push(p);
    p = p.parent;
  }
  let q = b.parent;
  while (q) {
    if (containers.indexOf(q) >= 0) return q;
    q = q.parent;
  }
  return figma.currentPage;
}

const TEMPLATE_KEY = 'drawflow.template';

async function findFirstConnector() {
  const onPage = figma.currentPage.findAllWithCriteria({ types: ['CONNECTOR'] });
  if (onPage.length) return onPage[0];
  await figma.loadAllPagesAsync();
  for (const page of figma.root.children) {
    const found = page.findAllWithCriteria({ types: ['CONNECTOR'] });
    if (found.length) return found[0];
  }
  return null;
}

// The template connector: explicitly loaded (file-scoped pluginData) or auto-detected.
async function getTemplate() {
  const id = figma.root.getPluginData(TEMPLATE_KEY);
  if (id) {
    const n = await figma.getNodeByIdAsync(id);
    if (n && !n.removed && n.type === 'CONNECTOR') return { node: n, source: 'loaded' };
    figma.root.setPluginData(TEMPLATE_KEY, '');
  }
  const auto = await findFirstConnector();
  return auto ? { node: auto, source: 'auto' } : null;
}

async function templateSummary() {
  const t = await getTemplate();
  return { type: 'template', id: t ? t.node.id : null, name: t ? t.node.name : null, source: t ? t.source : null,
    page: t && t.node.parent ? pageOf(t.node).name : null };
}

function pageOf(node) {
  let n = node;
  while (n && n.type !== 'PAGE') n = n.parent;
  return n || figma.currentPage;
}

// Extract the CONNECTOR from a cloned wrapper, move it to `dest`, remove the wrapper.
function unwrapClone(wrapperClone, dest) {
  const inner = wrapperClone.findAllWithCriteria ? wrapperClone.findAllWithCriteria({ types: ['CONNECTOR'] })[0]
    : wrapperClone.children.filter(function (n) { return n.type === 'CONNECTOR'; })[0];
  if (!inner) { wrapperClone.remove(); throw new Error('wrapper clone contained no connector'); }
  dest.appendChild(inner);
  if (!wrapperClone.removed) wrapperClone.remove();
  return inner;
}

// Duplicate a connector without `clone()` on the connector itself (blocked in Design plugins).
// Every strategy restores the template to its original parent and cleans up its wrappers.
async function duplicateConnector(template) {
  const failures = [];
  const origParent = template.parent;
  const dest = pageOf(template);

  // A. direct clone (blocked as of 2026-09, kept for future builds)
  try { return { node: template.clone(), strategy: 'clone' }; }
  catch (e) { failures.push('clone: ' + e.message); }

  // B. wrap in a temporary SECTION and clone the section (grouping a connector is impossible:
  //    figma.group([connector]) throws "node does not exist", so group/component routes are out).
  try {
    const sec = figma.createSection();
    dest.appendChild(sec);
    sec.name = 'Draw Flow tmp';
    sec.resizeWithoutConstraints(Math.max(1, template.width), Math.max(1, template.height));
    sec.x = template.x; sec.y = template.y;
    let dup = null;
    try { sec.appendChild(template); dup = sec.clone(); }
    finally { origParent.appendChild(template); if (!sec.removed) sec.remove(); }
    return { node: unwrapClone(dup, dest), strategy: 'section-clone' };
  } catch (e) { failures.push('section-clone: ' + e.message); }

  const err = new Error('Could not duplicate the template connector. ' + failures.join(' | '));
  err.failures = failures;
  throw err;
}

function isInstanceSublayer(node) {
  return typeof node.id === 'string' && node.id.charAt(0) === 'I';
}

// The nearest ancestor that is a valid container for the anchor: the first non-sublayer ancestor's parent.
function anchorContainerFor(node) {
  let n = node;
  while (n.parent && isInstanceSublayer(n)) n = n.parent; // n is now the INSTANCE itself
  return n.parent || figma.currentPage;
}

// Invisible, UNLOCKED rectangle covering `node`, placed in `container` at the same absolute position.
// Must stay unlocked: locked nodes are rejected as connector endpoints.
function createAnchor(node, container) {
  const b = node.absoluteBoundingBox;
  const r = figma.createRectangle();
  r.name = 'Anchor · ' + node.name;
  r.resize(Math.max(0.01, b.width), Math.max(0.01, b.height));
  r.fills = [];
  r.strokes = [];
  container.appendChild(r);
  if ('layoutMode' in container && container.layoutMode !== 'NONE') r.layoutPositioning = 'ABSOLUTE';
  const off = container.type === 'PAGE' ? { x: 0, y: 0 }
    : { x: container.absoluteTransform[0][2], y: container.absoluteTransform[1][2] };
  r.x = b.x - off.x;
  r.y = b.y - off.y;
  r.setPluginData('drawflow', 'anchor:' + node.id);
  return r;
}

// Returns a valid connector endpoint node: the node itself unless it lives inside an instance.
function endpointFor(node) {
  if (node.locked) throw new Error('"' + node.name + '" is locked — unlock it (connectors cannot attach to locked layers).');
  return isInstanceSublayer(node) ? createAnchor(node, anchorContainerFor(node)) : node;
}

async function configureConnector(c, start, end, s) {
  const parent = commonContainer(topLevelAncestor(start), topLevelAncestor(end));
  start = endpointFor(start);
  end = endpointFor(end);
  c.connectorStart = { endpointNodeId: start.id, magnet: s.startMagnet };
  c.connectorEnd = { endpointNodeId: end.id, magnet: s.endMagnet };
  if (c.parent !== parent) parent.appendChild(c);

  c.name = 'Connector line';
  c.connectorLineType = s.lineType;
  c.connectorStartStrokeCap = s.startCap;
  c.connectorEndStrokeCap = s.endCap;
  c.strokeWeight = s.strokeWeight;
  c.strokes = [{ type: 'SOLID', color: hexToRgb(s.color) }];
  c.dashPattern = [];
  c.opacity = 1;
  c.visible = true;
  c.locked = false;
  if ('cornerRadius' in c) c.cornerRadius = s.cornerRadius;

  // The seed may carry a label — clear it so the new arrow starts clean.
  try {
    if (c.text && c.text.characters && c.text.characters.length) {
      const fonts = c.text.getRangeAllFontNames(0, c.text.characters.length);
      for (const f of fonts) await figma.loadFontAsync(f);
      c.text.characters = '';
    }
  } catch (e) {
    // Non-fatal: the arrow is still valid, only the inherited label survives.
  }
  return c;
}

// ---------- static vector fallback (no connector in file) ----------

function anchorFor(node, magnet, other) {
  const b = node.absoluteBoundingBox;
  const o = other.absoluteBoundingBox;
  const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
  let m = magnet;
  if (m === 'AUTO' || m === 'CENTER') {
    const ocx = o.x + o.width / 2, ocy = o.y + o.height / 2;
    const dx = ocx - cx, dy = ocy - cy;
    m = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'RIGHT' : 'LEFT') : (dy >= 0 ? 'BOTTOM' : 'TOP');
  }
  switch (m) {
    case 'TOP': return { x: cx, y: b.y, side: m };
    case 'BOTTOM': return { x: cx, y: b.y + b.height, side: m };
    case 'LEFT': return { x: b.x, y: cy, side: m };
    default: return { x: b.x + b.width, y: cy, side: 'RIGHT' };
  }
}

function elbowRoute(a, b) {
  const aH = a.side === 'LEFT' || a.side === 'RIGHT';
  const bH = b.side === 'LEFT' || b.side === 'RIGHT';
  if (aH && bH) {
    const midX = (a.x + b.x) / 2;
    return [a, { x: midX, y: a.y }, { x: midX, y: b.y }, b];
  }
  if (!aH && !bH) {
    const midY = (a.y + b.y) / 2;
    return [a, { x: a.x, y: midY }, { x: b.x, y: midY }, b];
  }
  return aH ? [a, { x: b.x, y: a.y }, b] : [a, { x: a.x, y: b.y }, b];
}

async function createVectorArrow(start, end, s) {
  const a = anchorFor(start, s.startMagnet, end);
  const b = anchorFor(end, s.endMagnet, start);
  const pts = s.lineType === 'ELBOWED' ? elbowRoute(a, b) : [a, b];

  const minX = Math.min.apply(null, pts.map(function (p) { return p.x; }));
  const minY = Math.min.apply(null, pts.map(function (p) { return p.y; }));

  const vertices = pts.map(function (p, i) {
    const v = { x: p.x - minX, y: p.y - minY, strokeCap: 'NONE', strokeJoin: 'ROUND' };
    if (i === 0) v.strokeCap = s.startCap;
    if (i === pts.length - 1) v.strokeCap = s.endCap;
    if (i > 0 && i < pts.length - 1) v.cornerRadius = s.cornerRadius;
    return v;
  });
  const segments = [];
  for (let i = 0; i < vertices.length - 1; i++) segments.push({ start: i, end: i + 1 });

  const vec = figma.createVector();
  vec.name = 'Arrow (static)';
  const parent = commonContainer(start, end);
  parent.appendChild(vec);

  const network = { vertices: vertices, segments: segments, regions: [] };
  if (typeof vec.setVectorNetworkAsync === 'function') await vec.setVectorNetworkAsync(network);
  else vec.vectorNetwork = network;

  vec.strokes = [{ type: 'SOLID', color: hexToRgb(s.color) }];
  vec.strokeWeight = s.strokeWeight;
  vec.strokeJoin = 'ROUND';
  vec.fills = [];

  // Place in parent-relative coordinates.
  const pt = parent.type === 'PAGE' ? { x: 0, y: 0 } : { x: parent.absoluteTransform[0][2], y: parent.absoluteTransform[1][2] };
  vec.x = minX - pt.x;
  vec.y = minY - pt.y;
  return vec;
}

// ---------- main action ----------

async function handleCreate(rawSettings) {
  const s = sanitize(rawSettings);
  await figma.clientStorage.setAsync(SETTINGS_KEY, s);

  const sel = selectedTargets();
  if (sel.length !== 2) {
    figma.notify('Select exactly two objects (currently ' + sel.length + ').');
    return { type: 'result', ok: false, message: 'Select exactly two objects.' };
  }
  let start = sel[0], end = sel[1];
  if (rawSettings && rawSettings.swapped) { const t = start; start = end; end = t; }

  const notes = [];
  const template = await getTemplate();
  const picked = selectedConnector();

  // 1. Template mode: duplicate the template and re-point the duplicate.
  if (template && (!picked || picked.id === template.node.id)) {
    try {
      const dup = await duplicateConnector(template.node);
      try {
        await configureConnector(dup.node, start, end, s);
      } catch (e) { dup.node.remove(); throw e; }
      figma.notify('Arrow created: ' + start.name + ' → ' + end.name);
      return { type: 'result', ok: true, mode: 'connector', id: dup.node.id, start: start.name, end: end.name, strategy: dup.strategy };
    } catch (e) {
      notes.push(e && e.message ? e.message : String(e));
    }
  }

  // 2. Re-point a connector the user selected (duplicate an existing one with ⌘D first).
  if (picked && (!template || picked.id !== template.node.id)) {
    try {
      await configureConnector(picked, start, end, s);
      figma.notify('Connector re-pointed: ' + start.name + ' → ' + end.name);
      return { type: 'result', ok: true, mode: 'repoint', id: picked.id, start: start.name, end: end.name };
    } catch (e) {
      notes.push('Re-point failed: ' + (e && e.message ? e.message : String(e)));
    }
  }

  // 3. Static vector arrow — always available in Design.
  const v = await createVectorArrow(start, end, s);
  const hint = template
    ? 'Drew a static arrow: the template connector could not be duplicated by the plugin. For a live one: ⌘D a connector, select it with the two objects, and run again.'
    : 'Drew a static arrow: no connector in this file yet. Paste one from FigJam, select it and press "Load as template".';
  figma.notify(hint, { timeout: 7000 });
  return { type: 'result', ok: true, mode: 'vector', id: v.id, message: hint, notes: notes };
}

// ---------- diagnostics (plugin-runtime probe; results shown in the UI) ----------

function describe(n) {
  if (!n) return 'null';
  return n.type + ' "' + n.name + '" id=' + n.id + ' parent=' + (n.parent ? n.parent.type : 'none');
}

async function runDiagnostics() {
  const lines = [];
  const tpl = await getTemplate();
  const c = selectedConnector() || (tpl ? tpl.node : null);
  const targets = selectedTargets();
  lines.push('editorType=' + figma.editorType + ' apiVersion=' + (figma.apiVersion || '?'));
  lines.push('template: ' + (tpl ? tpl.source + ' ' + describe(tpl.node) : 'none'));
  lines.push('clickOrder=' + JSON.stringify(clickOrder));
  lines.push('connector: ' + describe(c));
  targets.slice(0, 2).forEach(function (t, i) { lines.push('target' + (i + 1) + ': ' + describe(t)); });
  if (!c) { lines.push('No connector available — load a template or select one.'); return lines; }

  const origStart = c.connectorStart, origEnd = c.connectorEnd;
  lines.push('current start=' + JSON.stringify(origStart) + ' end=' + JSON.stringify(origEnd));

  function attempt(label, fn) {
    try { fn(); lines.push('OK   ' + label + ' -> ' + JSON.stringify(c.connectorStart)); }
    catch (e) { lines.push('FAIL ' + label + ' -> ' + (e && e.message ? e.message : String(e))); }
  }

  // Candidate endpoints on the current page
  const shape = figma.currentPage.findAllWithCriteria({ types: ['SHAPE_WITH_TEXT'] })[0] || null;
  const topFrame = figma.currentPage.children.filter(function (n) { return n.type === 'FRAME'; })[0] || null;
  const rect = figma.currentPage.findAllWithCriteria({ types: ['RECTANGLE'] })[0] || null;
  lines.push('shape: ' + describe(shape));
  lines.push('topFrame: ' + describe(topFrame));

  // Same endpoint as current, re-applied (tests whether the setter works at all)
  if (origStart && origStart.endpointNodeId) {
    attempt('re-apply current start id', function () { c.connectorStart = { endpointNodeId: origStart.endpointNodeId, magnet: origStart.magnet || 'AUTO' }; });
  }
  attempt('position endpoint', function () { c.connectorStart = { position: { x: c.x, y: c.y } }; });
  if (shape) attempt('SHAPE_WITH_TEXT id, AUTO', function () { c.connectorStart = { endpointNodeId: shape.id, magnet: 'AUTO' }; });
  if (topFrame) attempt('top-level FRAME id, AUTO', function () { c.connectorStart = { endpointNodeId: topFrame.id, magnet: 'AUTO' }; });
  if (topFrame) attempt('top-level FRAME id, RIGHT', function () { c.connectorStart = { endpointNodeId: topFrame.id, magnet: 'RIGHT' }; });
  if (rect) attempt('RECTANGLE id, AUTO', function () { c.connectorStart = { endpointNodeId: rect.id, magnet: 'AUTO' }; });
  targets.slice(0, 2).forEach(function (t, i) {
    attempt('selected target' + (i + 1) + ' id, AUTO', function () { c.connectorStart = { endpointNodeId: t.id, magnet: 'AUTO' }; });
  });
  // Does the connector's own container matter? Move to page, retry a target.
  if (targets[0]) {
    const page = figma.currentPage;
    const prevParent = c.parent;
    attempt('move connector to PAGE', function () { page.appendChild(c); });
    attempt('target1 id after move', function () { c.connectorStart = { endpointNodeId: targets[0].id, magnet: 'AUTO' }; });
    // Move target next to the connector's original parent?  (report only)
    lines.push('connector parent now=' + c.parent.type + ' (was ' + (prevParent ? prevParent.type : '?') + ')');
  }
  // Restore original endpoints where possible
  try { c.connectorStart = origStart; } catch (e) { lines.push('restore start failed: ' + e.message); }
  try { c.connectorEnd = origEnd; } catch (e) { lines.push('restore end failed: ' + e.message); }
  // Duplication strategies (the duplicate is removed again)
  try {
    const dup = await duplicateConnector(c);
    lines.push('DUPLICATE OK via ' + dup.strategy + ' -> ' + dup.node.type + ' ' + dup.node.id);
    dup.node.remove();
  } catch (e) {
    lines.push('DUPLICATE FAIL: ' + (e.failures ? e.failures.join(' | ') : e.message));
  }
  return lines;
}

// ---------- messaging ----------

figma.on('selectionchange', function () {
  updateClickOrder();
  figma.ui.postMessage(selectionSummary());
});

async function pushTemplate() {
  figma.ui.postMessage(await templateSummary());
}

figma.ui.onmessage = async function (msg) {
  if (!msg || !msg.type) return;
  switch (msg.type) {
    case 'create': {
      try {
        const res = await handleCreate(msg.settings);
        figma.ui.postMessage(res);
        await pushTemplate();
      } catch (e) {
        figma.notify('Draw Flow: ' + (e && e.message ? e.message : String(e)), { error: true });
        figma.ui.postMessage({ type: 'result', ok: false, message: String(e && e.message ? e.message : e) });
      }
      break;
    }
    case 'load-template': {
      const c = selectedConnector();
      if (!c) { figma.notify('Select a connector on the canvas first.'); break; }
      figma.root.setPluginData(TEMPLATE_KEY, c.id);
      figma.notify('Template loaded: ' + c.name);
      await pushTemplate();
      figma.ui.postMessage(selectionSummary());
      break;
    }
    case 'clear-template': {
      figma.root.setPluginData(TEMPLATE_KEY, '');
      await pushTemplate();
      break;
    }
    case 'diagnose': {
      try {
        const lines = await runDiagnostics();
        figma.ui.postMessage({ type: 'diag', lines: lines });
      } catch (e) {
        figma.ui.postMessage({ type: 'diag', lines: ['Diagnostics crashed: ' + (e && e.message ? e.message : String(e))] });
      }
      break;
    }
    case 'save-settings': {
      await figma.clientStorage.setAsync(SETTINGS_KEY, sanitize(msg.settings));
      break;
    }
    case 'resize': {
      figma.ui.resize(320, Math.max(620, Math.min(960, Number(msg.height) || 620)));
      break;
    }
    case 'close': {
      figma.closePlugin();
      break;
    }
  }
};

(async function init() {
  updateClickOrder();
  const stored = await figma.clientStorage.getAsync(SETTINGS_KEY);
  figma.ui.postMessage({ type: 'init', settings: sanitize(stored), selection: selectionSummary() });
  await pushTemplate();
})();
