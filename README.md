# Draw Flow

Draw FigJam-style connector arrows between two selected objects in a **Figma Design** file.

## Usage
1. Once per file: paste any connector from a FigJam board, select it, press **Load as template**.
   (If the file already contains a connector, the plugin auto-detects it.)
2. Select exactly two objects (frames, nested frames, instances, shapes…).
3. Pick where the arrow attaches on each object (T / L / R / B, or the centre button = Auto),
   the cap for each end, line type (Elbowed / Straight / Curved), weight and colour.
4. **Create Arrow** (or press Enter). The template is duplicated and the duplicate is re-pointed;
   the template itself is never touched. Settings are remembered between runs.

Start = the object you clicked first, End = the one you shift-clicked second (the plugin tracks
click order while it is open; a marquee selection falls back to layer order). The panel shows
which is which; **⇄ Swap** flips them.

## Labels
Connector labels default to black at 80 % — invisible on dark canvases. **Match label colour to
line** scans every connector on this page (or all pages) and sets each label's text fill to that
connector's own stroke paint. No hard-coded colours: coloured lines get matching labels too.
While the plugin is open, a label you type on any connector is recoloured live (a moment after
you stop typing). The current page is also synced when the plugin opens and after every arrow, so
labels typed while it was closed are fixed the next time you run it. (Pre-colouring an *empty*
label is impossible: Figma re-applies its black default the moment text appears, and a placeholder
space would leave a gap in the line.)

## Anchors
**Remove anchors in selection** deletes the invisible `Anchor · …` rectangles inside the selected
frames (or on the whole page when nothing is selected). Arrows attached to them are kept
(detached at that end) unless **Also remove the arrows attached to them** is ticked.

## How it works (and the caveats)
Figma Design blocks plugins from making connectors: `figma.createConnector()` doesn't exist there,
and `connector.clone()` throws *"Cloning CONNECTOR nodes is not supported in the current editor"*.
(Figma's own MCP `use_figma` runtime is privileged and can clone them — a plugin cannot.)

So the plugin tries, in order:
1. **Template** — the template connector is duplicated by the first strategy the sandbox allows
   (direct clone, else clone of a temporary wrapping section) and the duplicate is re-pointed.
   Live arrow, no manual step.
2. **Re-point** — if your selection also contains a (non-template) connector, e.g. one you ⌘D'd,
   it is re-pointed instead. Live arrow.
3. **Static vector arrow** with per-end caps and rounded elbows — always works, but does not
   follow the objects when they move. The panel explains why it fell back.

**Endpoint rules** (found via the plugin's diagnostics): a connector can attach to any *unlocked*
layer — nested frames and instances included. Locked layers are rejected (the panel warns you).
Layers *inside* an instance can't be endpoints, so for those the plugin creates an invisible,
unlocked rectangle (`Anchor · <name>`, no fill/stroke) at the same position inside the instance's
parent frame and attaches the arrow to that; it moves with the screen.

Live connectors between Design frames can also be drawn by Claude via the Figma MCP on request.

## Files
- `manifest.json` — `id` is `GENERATE_FROM_FIGMA` until first publish; paste Figma's numeric id back afterwards.
- `code.js` — plugin main (no build step).
- `ui.html` — single-file UI.
