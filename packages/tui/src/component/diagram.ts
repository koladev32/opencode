import { createHash } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  BoxRenderable,
  ImageRenderable,
  Renderable,
  RGBA,
  StyledText,
  TextRenderable,
  createMarkdownCodeBlockRenderer,
  fg,
  t,
  type MarkdownCodeBlockRenderer,
  type OptimizedBuffer,
  type RenderContext,
} from "@opentui/core"
import type { Theme } from "../theme"
import {
  DEFAULT_CAMERA,
  gpuAvailable,
  parseScene,
  partialScene,
  renderScene,
  renderSceneRaw,
  encodePng,
  sceneError,
  type Scene,
  type SceneView,
} from "./scene3d"

// Inline diagrams: ```d2 blocks in assistant replies render as graphics that blend into the
// theme (transparent background, theme colours, terminal font). `# @step a -> b | caption`
// lines turn the block into an animation: the active step is focused and glows while a pulse
// travels along its connection. It plays once, then rests (click the caption to replay); click
// the diagram to open it full-window.
//
// On Kitty-graphics terminals every frame is uploaded once and shown through Unicode
// placeholder cells, so switching frames only recolours cells: no flicker, nothing re-sent.
// Terminals keep images decoded (4 bytes/pixel; Ghostty caps this at 320 MB by default), so
// frames are rendered at their displayed size and only frames near the playhead stay uploaded.
// Elsewhere it falls back to ImageRenderable. Design notes: diagram-demo/NOTES.md.

const CACHE = path.join(os.tmpdir(), "opencode-diagrams")
const STEP = /^\s*#\s*@step\s+(.+?)\s*(?:\|\s*(.*))?$/
const ARROW = /(<->|->|<-|--)/
const LABEL_PX = 15 // node label size set in themed()
const REDRAW_MS = 300
const INLINE_HEIGHT = 0.6 // share of the window an inline diagram may use
const TIMING = { build: 120, overview: 1200, pulse: 40, hold: 1300, fade: 45 }
const PULSE_FRAMES = 9
const FADE_FRAMES = 4 // crossfade frames at the start of each step (and the outro length is 6)
const FRAME_MS_3D = 33 // ~30 fps while a 3D view is moving
const FAST_SCALE = 0.5 // resolution of moving 3D frames; still frames render at full size
const SETTLE_MS = 220 // after the user stops moving a 3D view, render it sharp with labels
const DIM = 0.45 // opacity of everything outside the focused step
const LOOKAHEAD = 14 // frames rasterised (and kept uploaded) ahead of the playhead
// "once" plays through and rests on the overview, "loop" repeats, "static" waits for ▶ play.
const MODE = process.env.OPENCODE_DIAGRAM_ANIMATION || "once"
const ENABLED = process.env.OPENCODE_DIAGRAMS !== "off"
// Set to a file path to log how long each live 3D frame takes.
const DEBUG = process.env.OPENCODE_DIAGRAM_DEBUG
const RASTER_JOBS = 3
// "auto" uses placeholders when the terminal reports Kitty graphics outside tmux. Inside tmux
// set OPENCODE_DIAGRAM_PROTOCOL=kitty (needs `set -g allow-passthrough on`).
const PROTOCOL = process.env.OPENCODE_DIAGRAM_PROTOCOL || "auto"
const FONT_DIRS = [path.join(os.homedir(), "Library/Fonts"), "/Library/Fonts", "/usr/share/fonts/truetype/jetbrains-mono"]
const SHAPES = new Set(
  "rectangle square page parallelogram document cylinder queue package step callout stored_data person diamond oval circle hexagon cloud text code class sql_table image sequence_diagram c4-person".split(
    " ",
  ),
)
// Small built-in icon set (24×24 strokes), so icons work offline and follow the theme.
const ICONS: Record<string, string> = {
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
  cart: '<path d="M3 4h2l2 11h11l2-8H7"/><circle cx="9" cy="20" r="1.5"/><circle cx="17" cy="20" r="1.5"/>',
  card: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18M7 15h3"/>',
  database: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3 3 7 3s7-1.3 7-3"/>',
  cloud: '<path d="M7 18h10a4 4 0 0 0 0-8 6 6 0 0 0-11.5 2A3 3 0 0 0 7 18z"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  server: '<rect x="4" y="4" width="16" height="7" rx="1.5"/><rect x="4" y="13" width="16" height="7" rx="1.5"/><path d="M8 7.5h.01M8 16.5h.01"/>',
  phone: '<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 18h2"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l2 2"/>',
  bell: '<path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M16 16l5 5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  code: '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4"/>',
  bot: '<rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 4v4M9.5 13h.01M14.5 13h.01"/>',
  queue: '<rect x="3" y="8" width="4" height="8" rx="1"/><rect x="10" y="8" width="4" height="8" rx="1"/><rect x="17" y="8" width="4" height="8" rx="1"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
}
// d2 leaves http(s) icon URLs alone with --bundle=false (other paths it tries to load), and the
// reserved .invalid domain never resolves, so these are safe placeholders.
const ICON_URL = "https://dg-icon.invalid/"
const PLACEHOLDER = "\u{10EEEE}"
// Row/column diacritics from the Kitty spec (gen/rowcolumn-diacritics.txt).
const DIACRITICS = [
  0x0305, 0x030d, 0x030e, 0x0310, 0x0312, 0x033d, 0x033e, 0x033f, 0x0346, 0x034a, 0x034b, 0x034c,
  0x0350, 0x0351, 0x0352, 0x0357, 0x035b, 0x0363, 0x0364, 0x0365, 0x0366, 0x0367, 0x0368, 0x0369,
  0x036a, 0x036b, 0x036c, 0x036d, 0x036e, 0x036f, 0x0483, 0x0484, 0x0485, 0x0486, 0x0487, 0x0592,
  0x0593, 0x0594, 0x0595, 0x0597, 0x0598, 0x0599, 0x059c, 0x059d, 0x059e, 0x059f, 0x05a0, 0x05a1,
  0x05a8, 0x05a9, 0x05ab, 0x05ac, 0x05af, 0x05c4, 0x0610, 0x0611, 0x0612, 0x0613, 0x0614, 0x0615,
  0x0616, 0x0617, 0x0657, 0x0658, 0x0659, 0x065a, 0x065b, 0x065d, 0x065e, 0x06d6, 0x06d7, 0x06d8,
  0x06d9, 0x06da, 0x06db, 0x06dc, 0x06df, 0x06e0, 0x06e1, 0x06e2, 0x06e4, 0x06e7, 0x06e8, 0x06eb,
  0x06ec, 0x0730, 0x0732, 0x0733, 0x0735, 0x0736, 0x073a, 0x073d, 0x073f, 0x0740, 0x0741, 0x0743,
  0x0745, 0x0747, 0x0749, 0x074a, 0x07eb, 0x07ec, 0x07ed, 0x07ee, 0x07ef, 0x07f0, 0x07f1, 0x07f3,
  0x0816, 0x0817, 0x0818, 0x0819, 0x081b, 0x081c, 0x081d, 0x081e, 0x081f, 0x0820, 0x0821, 0x0822,
  0x0823, 0x0825, 0x0826, 0x0827, 0x0829, 0x082a, 0x082b, 0x082c, 0x082d, 0x0951, 0x0953, 0x0954,
  0x0f82, 0x0f83, 0x0f86, 0x0f87, 0x135d, 0x135e, 0x135f, 0x17dd, 0x193a, 0x1a17, 0x1a75, 0x1a76,
  0x1a77, 0x1a78, 0x1a79, 0x1a7a, 0x1a7b, 0x1a7c, 0x1b6b, 0x1b6d, 0x1b6e, 0x1b6f, 0x1b70, 0x1b71,
  0x1b72, 0x1b73, 0x1cd0, 0x1cd1, 0x1cd2, 0x1cda, 0x1cdb, 0x1ce0, 0x1dc0, 0x1dc1, 0x1dc3, 0x1dc4,
  0x1dc5, 0x1dc6, 0x1dc7, 0x1dc8, 0x1dc9, 0x1dcb, 0x1dcc, 0x1dd1, 0x1dd2, 0x1dd3, 0x1dd4, 0x1dd5,
  0x1dd6, 0x1dd7, 0x1dd8, 0x1dd9, 0x1dda, 0x1ddb, 0x1ddc, 0x1ddd, 0x1dde, 0x1ddf, 0x1de0, 0x1de1,
  0x1de2, 0x1de3, 0x1de4, 0x1de5, 0x1de6, 0x1dfe, 0x20d0, 0x20d1, 0x20d4, 0x20d5, 0x20d6, 0x20d7,
  0x20db, 0x20dc, 0x20e1, 0x20e7, 0x20e9, 0x20f0, 0x2cef, 0x2cf0, 0x2cf1, 0x2de0, 0x2de1, 0x2de2,
  0x2de3, 0x2de4, 0x2de5, 0x2de6, 0x2de7, 0x2de8, 0x2de9, 0x2dea, 0x2deb, 0x2dec, 0x2ded, 0x2dee,
  0x2def, 0x2df0, 0x2df1, 0x2df2, 0x2df3, 0x2df4, 0x2df5, 0x2df6, 0x2df7, 0x2df8, 0x2df9, 0x2dfa,
  0x2dfb, 0x2dfc, 0x2dfd, 0x2dfe, 0x2dff, 0xa66f, 0xa67c, 0xa67d, 0xa6f0, 0xa6f1, 0xa8e0, 0xa8e1,
  0xa8e2, 0xa8e3, 0xa8e4, 0xa8e5, 0xa8e6, 0xa8e7, 0xa8e8, 0xa8e9, 0xa8ea, 0xa8eb, 0xa8ec, 0xa8ed,
  0xa8ee, 0xa8ef, 0xa8f0, 0xa8f1, 0xaab0, 0xaab2, 0xaab3, 0xaab7, 0xaab8, 0xaabe, 0xaabf, 0xaac1,
  0xfe20, 0xfe21, 0xfe22, 0xfe23, 0xfe24, 0xfe25, 0xfe26, 0x10a0f, 0x10a38, 0x1d185, 0x1d186, 0x1d187,
  0x1d188, 0x1d189, 0x1d1aa, 0x1d1ab, 0x1d1ac, 0x1d1ad, 0x1d242, 0x1d243, 0x1d244,
].map((c) => String.fromCodePoint(c))

type Step = { caption: string; focus: Focus }
type Palette = ReturnType<typeof diagramPalette>
type Cell = { w: number; h: number }
type Size = { cols: number; rows: number }
type Focus = { edge: string; nodes: Set<string> } // edge is "" when a step highlights boxes only
// A frame is either a d2 SVG (rasterised at the surface's zoom) or a 3D view drawn on demand
// at the surface's pixel size.
// A frame is a d2 SVG (rasterised at each surface's zoom) or, for 3D, a timeline segment: hold
// `view` for `delay` ms, or move to it from `from` over `delay` ms (rendered live).
type Frame = { svg?: string; view?: SceneView; from?: SceneView; delay: number; step: number }
type View = { sync(): void }
type Kind = "d2" | "scene3d"
type Limits = { cols: number; rows: number }
// Where a diagram is shown (inline in the reply, or the full-window view). Frames are
// rasterised at the surface's displayed size, and only frames near the playhead stay uploaded.
type Surface = {
  limits: Limits
  zoom: number
  size: Size
  files: (string | undefined)[]
  jobs: (Promise<string> | undefined)[]
  uploads: Map<number, number> // frame index -> terminal image id
  shown: number | undefined
  views: Set<View>
  release: ReturnType<typeof setTimeout> | undefined
  // 3D only: the image currently shown (rendered live, not from planned frames).
  custom: { file?: string; id?: number }
}

const hex = (c: RGBA) =>
  "#" +
  c
    .toInts()
    .slice(0, 3)
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")

// Theme colours for diagrams. Some themes use the same hue for borders and the primary colour,
// so lines and the highlight are picked to stay clearly apart.
export function diagramPalette(theme: Theme) {
  const distance = (a: RGBA, b: RGBA) => {
    const [x, y] = [a.toInts(), b.toInts()]
    return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2])
  }
  const line = distance(theme.borderActive, theme.primary) > 100 ? theme.borderActive : theme.border
  const accent =
    [theme.primary, theme.accent, theme.secondary].find(
      (c) => distance(c, line) > 120 && distance(c, theme.backgroundPanel) > 120,
    ) ?? theme.primary
  return {
    text: hex(theme.text),
    muted: hex(theme.textMuted),
    line: hex(line),
    fill: hex(theme.backgroundPanel),
    fillStrong: hex(theme.backgroundElement),
    accent: hex(accent),
    success: hex(theme.success),
    warning: hex(theme.warning),
    error: hex(theme.error),
    info: hex(theme.info),
  }
}

export function diagramRenderNode(
  ctx: RenderContext,
  palette: Palette,
  maxWidth: () => number,
  onExpand: (diagram: LiveDiagram) => void,
) {
  // While a reply streams, Markdown rebuilds a custom block on every chunk, so diagram state
  // lives here (one per message part) and each rebuilt view just shows its latest frame.
  const live = new Map<string, LiveDiagram>()
  const renderer =
    (kind: Kind): MarkdownCodeBlockRenderer =>
    (token) => {
      if (!ENABLED || !Bun.which("rsvg-convert") || (kind === "d2" && !Bun.which("d2"))) return undefined
      if (!token.text.includes("\n")) return undefined // wait for the first complete line
      const key = `${kind}:${token.text.slice(0, token.text.indexOf("\n"))}`
      const diagram = live.get(key) ?? new LiveDiagram(ctx, palette, maxWidth(), kind)
      live.set(key, diagram)
      diagram.update(token.text, /\n\s*(```|~~~)\s*$/.test(token.raw.trimEnd()))
      return new DiagramView(ctx, diagram, onExpand)
    }
  return createMarkdownCodeBlockRenderer({ d2: renderer("d2"), scene3d: renderer("scene3d") })
}

// Draws a diagram progressively while it streams (redrawing only when a new box appears).
// Once complete it plays: build-in (if never drawn live) → overview → per step a crossfade
// with a pulse along the connection, then a hold → fade back to the overview, where it rests
// (or loops, per OPENCODE_DIAGRAM_ANIMATION). Frames are rasterised just ahead of the playhead.
export class LiveDiagram {
  frames: Frame[] = []
  steps: Step[] = []
  index = 0
  playing = false
  ended = false
  status = "drawing…"
  notice = ""
  private reserved = 0
  private rest = 0
  private complete = false
  private live = false
  private parts = 0
  private base = { width: 1, height: 1 }
  private queued: { source: string; complete: boolean } | undefined
  private busy = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private surfaces = new Map<string, Surface>()
  readonly cell: Cell
  private zoom: number

  private scene: Scene | undefined
  private sceneView: SceneView | undefined // the user's own camera, once they take control
  private custom = false
  private target: { view: SceneView; quality: "fast" | "full" } | undefined
  private rendering = false
  private lastView: SceneView | undefined
  private segmentStart = 0
  private settle: ReturnType<typeof setTimeout> | undefined

  constructor(
    readonly ctx: RenderContext,
    readonly palette: Palette,
    private maxWidth: number,
    readonly kind: Kind = "d2",
  ) {
    this.cell = cellSize(ctx)
    // At this zoom diagram labels are about the size of terminal text (1:1 pixels).
    this.zoom = (this.cell.h * 0.78) / LABEL_PX
  }

  get interactive() {
    return this.kind === "scene3d"
  }

  update(text: string, complete: boolean) {
    if (this.complete) return
    if (this.kind === "scene3d") return this.updateScene(text, complete)
    const source = repair(complete ? text : stablePrefix(text))
    // Redraw while streaming only when a new box or arrow appears.
    const parts = nodeOrder(source).length + arrowCount(source)
    if (!complete && parts <= this.parts) return
    if (!complete) this.live = true
    this.parts = parts
    this.complete = complete
    this.queued = { source, complete }
    void this.pump()
  }

  // 3D: redraw while streaming whenever another complete part has arrived.
  private updateScene(text: string, complete: boolean) {
    const parts = (complete ? parseScene(text) : partialScene(text))?.parts.length ?? 0
    if (!complete && parts <= this.parts) return
    if (!complete) this.live = true
    this.parts = parts
    this.complete = complete
    this.queued = { source: text, complete }
    void this.pump()
  }

  inlineLimits(): Limits {
    return { cols: this.maxWidth, rows: Math.max(8, Math.floor((this.ctx.height || 40) * INLINE_HEIGHT)) }
  }

  attach(key: string, view: View, limits: Limits) {
    const surface = this.surface(key, limits)
    clearTimeout(surface.release)
    surface.views.add(view)
    if (this.kind === "scene3d" && surface.custom.id === undefined && this.lastView) this.show(this.lastView, "full")
    this.prefetch()
    this.schedule()
  }

  detach(key: string, view: View) {
    const surface = this.surfaces.get(key)
    if (!surface) return
    surface.views.delete(view)
    if (key === "expanded" && surface.views.size === 0 && this.kind === "scene3d" && this.lastView) this.show(this.lastView, "full")
    // Markdown rebuilds views constantly while streaming; only free memory if nobody returns.
    if (surface.views.size === 0)
      surface.release = setTimeout(() => {
        if (surface.views.size > 0) return
        this.dropUploads(surface, new Set())
        if (surface.custom.id !== undefined) releaseLater(this.ctx, surface.custom.id)
        this.surfaces.delete(key)
        if (this.viewCount() === 0) clearTimeout(this.timer)
      }, 2000)
  }

  size(key: string) {
    return this.surfaces.get(key)?.size ?? { cols: 1, rows: 1 }
  }

  reservedRows() {
    return this.reserved
  }

  // Image id to draw for a surface: the current frame, or the last one that was ready.
  image(key: string) {
    const surface = this.surfaces.get(key)
    if (!surface) return
    if (this.kind === "scene3d") return surface.custom.id === undefined ? undefined : { id: surface.custom.id, ...surface.size }
    const index = surface.files[this.index] ? this.index : surface.shown
    const file = index === undefined ? undefined : surface.files[index]
    if (index === undefined || !file) return
    surface.shown = index
    const id = surface.uploads.get(index) ?? upload(this.ctx, file, surface.size.cols, surface.size.rows)
    surface.uploads.set(index, id)
    this.dropUploads(surface, this.keep())
    return { id, ...surface.size }
  }

  file(key: string) {
    const surface = this.surfaces.get(key)
    return this.kind === "scene3d" ? surface?.custom.file : surface?.files[this.index]
  }

  play() {
    if (this.frames.length < 2 || this.status) return
    this.leaveCustom()
    if (this.ended || this.index === this.rest) this.index = this.rest
    this.playing = true
    this.ended = false
    this.segmentStart = performance.now()
    this.prefetch()
    this.notify()
    this.schedule()
  }

  pause() {
    if (!this.playing) return
    this.playing = false
    this.index = this.hold(this.frames[this.index].step)
    if (this.kind === "scene3d") this.show(this.frames[this.index].view!, "full")
    this.notify()
    this.schedule()
  }

  toggle() {
    if (this.playing) return this.pause()
    this.play()
  }

  // Step to the previous/next step's highlight (the overview counts as step -1). Pauses.
  go(delta: number) {
    if (this.steps.length === 0 || this.status) return
    this.playing = false
    const current = this.frames[this.index].step
    const target = ((current + 1 + delta + this.steps.length + 1) % (this.steps.length + 1)) - 1
    this.index = this.hold(target)
    // In a 3D view the user has turned, keep their camera and just change the focused part.
    if (this.custom) return this.adjust((v) => ({ ...v, focus: target < 0 ? undefined : this.scene?.steps[target]?.part, labels: true }))
    if (this.kind === "scene3d") this.show(this.frames[this.index].view!, "full")
    this.prefetch()
    this.notify()
    this.schedule()
  }

  // ---- 3D camera controls (full-window view) ----

  orbit(yaw: number, pitch: number) {
    this.adjust((v) => ({
      ...v,
      camera: { ...v.camera, yaw: v.camera.yaw + yaw, pitch: Math.max(-80, Math.min(80, v.camera.pitch + pitch)), perspective: true },
    }))
  }

  zoomBy(factor: number) {
    this.adjust((v) => ({ ...v, camera: { ...v.camera, zoom: Math.max(0.4, Math.min(4, v.camera.zoom * factor)) } }))
  }

  toggleExplode() {
    this.adjust((v) => ({ ...v, explode: v.explode > 0.5 ? 0 : 1, labels: v.explode <= 0.5 || !!v.focus }))
  }

  resetView() {
    if (!this.custom) return
    this.leaveCustom()
    this.index = this.rest
    this.show(this.frames[this.rest].view!, "full")
    this.notify()
  }

  // Takes the camera from the planned animation: a fast frame right away, then a sharp one with
  // labels once the user pauses for SETTLE_MS.
  private adjust(change: (view: SceneView) => SceneView) {
    if (!this.scene || this.status) return
    this.playing = false
    clearTimeout(this.timer)
    // Taking control starts from what is on screen, unfocused and labelled; [ ] pick parts again.
    const shown = this.lastView
    const current = this.sceneView ?? { camera: shown?.camera ?? DEFAULT_CAMERA, explode: shown?.explode ?? 0, labels: true }
    const view = change(current)
    this.sceneView = view
    this.custom = true
    this.show(view, "fast")
    clearTimeout(this.settle)
    this.settle = setTimeout(() => this.sceneView === view && this.show(view, "full"), SETTLE_MS)
  }

  private leaveCustom() {
    clearTimeout(this.settle)
    this.custom = false
    this.sceneView = undefined
  }

  // Renders a 3D view to every visible surface. The latest request wins while one is in flight,
  // so a slow frame drops intermediate ones instead of lagging behind. Each new image is
  // uploaded before the cells switch to it, and the old one is freed only afterwards.
  private show(view: SceneView, quality: "fast" | "full") {
    this.lastView = view
    this.target = { view, quality: useKitty(this.ctx) ? quality : "full" }
    void this.renderLoop()
  }

  private async renderLoop() {
    if (this.rendering) return
    this.rendering = true
    while (this.target && this.scene) {
      const { view, quality } = this.target
      this.target = undefined
      const scene = this.scene
      // While the full-window view is open, moving frames go only there; the inline view is
      // hidden behind it and gets a sharp frame again when the view closes.
      const visible = [...this.surfaces.entries()].filter(([, surface]) => surface.views.size > 0)
      const expanded = visible.some(([key]) => key === "expanded")
      const started = performance.now()
      await Promise.all(
        visible
          .filter(([key]) => quality === "full" || !expanded || key === "expanded")
          .map(async ([, surface]) => {
            const scale = quality === "fast" ? FAST_SCALE : 1
            const [width, height] = [this.base.width * surface.zoom * scale, this.base.height * surface.zoom * scale]
            const next =
              quality === "fast"
                ? { id: uploadRaw(this.ctx, await renderSceneRaw(scene, this.palette, view, width, height), surface.size) }
                : await rasterise(await renderScene(scene, this.palette, view, width, height), 1).then((file) => ({
                    file,
                    id: useKitty(this.ctx) ? upload(this.ctx, file, surface.size.cols, surface.size.rows) : undefined,
                  }))
            if (surface.custom.id !== undefined) releaseLater(this.ctx, surface.custom.id)
            surface.custom = next
          }),
      ).catch(() => undefined)
      if (DEBUG) appendFileSync(DEBUG, `${Date.now()} ${quality} ${(performance.now() - started).toFixed(1)}ms\n`)
      this.notify()
    }
    this.rendering = false
  }

  // 3D playback: walks the timeline by wall-clock time, rendering moving segments at ~30 fps on
  // the fast path (frames that can't keep up are skipped) and holds once, sharp.
  private tick() {
    clearTimeout(this.timer)
    if (!this.playing || this.viewCount() === 0) return
    const now = performance.now()
    const start = this.index
    while (now - this.segmentStart >= this.frames[this.index].delay) {
      this.segmentStart += this.frames[this.index].delay
      if (this.index + 1 < this.frames.length) {
        this.index++
        continue
      }
      if (MODE === "loop") {
        this.index = this.rest
        continue
      }
      this.index = this.rest
      this.playing = false
      this.ended = true
      this.show(this.frames[this.rest].view!, "full")
      this.notify()
      return
    }
    const segment = this.frames[this.index]
    const t = Math.min(1, (now - this.segmentStart) / segment.delay)
    if (segment.from) this.show(blend(segment.from, segment.view!, t), "fast")
    if (!segment.from && (this.index !== start || this.lastView !== segment.view)) this.show(segment.view!, "full")
    if (this.index !== start) this.notify()
    this.timer = setTimeout(() => this.tick(), segment.from ? FRAME_MS_3D : Math.max(FRAME_MS_3D, segment.delay - (now - this.segmentStart)))
  }

  // Changes only when the caption text would, so views skip relayout on pulse frames.
  captionKey() {
    return `${this.status}|${this.notice}|${this.frames[this.index]?.step}|${this.playing}|${this.ended}|${this.steps.length}|${this.custom}`
  }

  caption(expanded: boolean) {
    const p = this.palette
    if (this.status) return new StyledText([fg(p.muted)(this.status)])
    const expand = (expanded ? "" : "   ⤢ click diagram to expand") + (this.notice ? `   · ${this.notice}` : "")
    if (this.steps.length === 0) return new StyledText([fg(p.muted)(expand.trim())])
    const step = this.frames[this.index].step
    const dots = this.steps.slice(0, 24).map((_, i) => (i <= step ? "●" : "○"))
    const done = dots.filter((d) => d === "●").join("")
    const label = step < 0 ? "Overview" : this.steps[step].caption.replace(/^\d+\.\s+/, "")
    const counter = step < 0 ? `–/${this.steps.length}` : `${step + 1}/${this.steps.length}`
    const action = this.playing ? "" : this.ended ? "   ↻ replay" : "   ▶ play"
    return t`${fg(p.accent)(done)}${fg(p.line)(dots.slice(done.length).join(""))}  ${fg(p.accent)(counter)}  ${fg(p.text)(label)}${fg(p.accent)(expanded ? "" : action)}${fg(p.muted)(expand)}`
  }

  private hold(step: number) {
    return step < 0 ? this.rest : this.frames.findLastIndex((f) => f.step === step)
  }

  private viewCount() {
    return [...this.surfaces.values()].reduce((n, s) => n + s.views.size, 0)
  }

  private surface(key: string, limits: Limits, rebuild = false) {
    const existing = this.surfaces.get(key)
    if (existing && !rebuild && existing.limits.cols === limits.cols && existing.limits.rows === limits.rows) return existing
    if (existing) this.dropUploads(existing, new Set())
    const layout = scaled(this.base, this.cell, this.zoom, limits)
    const surface: Surface = {
      limits,
      ...layout,
      files: [],
      jobs: [],
      uploads: new Map(),
      shown: undefined,
      views: existing?.views ?? new Set(),
      release: undefined,
      custom: {},
    }
    this.surfaces.set(key, surface)
    if (key === "inline") this.reserved = Math.max(this.reserved, surface.size.rows)
    return surface
  }

  // Frames that may stay uploaded: a short window around the playhead while playing, only the
  // current frame otherwise. Everything else is deleted from the terminal's image memory.
  private keep() {
    if (!this.playing) return new Set([this.index])
    return new Set(Array.from({ length: LOOKAHEAD + 3 }, (_, i) => this.index - 2 + i).concat(this.rest))
  }

  private dropUploads(surface: Surface, keep: Set<number>) {
    surface.uploads.forEach((id, index) => {
      if (keep.has(index)) return
      releaseLater(this.ctx, id)
      surface.uploads.delete(index)
    })
  }

  private job(surface: Surface, index: number) {
    const frame = this.frames[index]
    if (!frame) return Promise.resolve("")
    surface.jobs[index] ??= rasterise(frame.svg ?? "", surface.zoom).then((file) => {
      surface.files[index] = file
      if (index === this.index) this.notify()
      return file
    })
    return surface.jobs[index]!
  }

  private prefetch() {
    if (this.kind === "scene3d") return
    const ahead = this.playing ? LOOKAHEAD : 0
    this.surfaces.forEach((surface) => {
      if (surface.views.size === 0) return
      Array.from({ length: ahead + 1 }, (_, i) => this.index + i)
        .filter((i) => i < this.frames.length)
        .forEach((i) => this.job(surface, i))
    })
  }

  private async pump() {
    if (this.busy) return
    this.busy = true
    while (this.queued) {
      const job = this.queued
      this.queued = undefined
      await (this.kind === "scene3d" ? this.drawScene(job.source, job.complete) : this.draw(job.source, job.complete)).catch((error) => {
        // Partial sources can fail to compile; only report errors for the finished diagram.
        if (job.complete) this.status = `diagram failed: ${error instanceof Error ? error.message : String(error)}`
      })
      this.notify()
      if (this.queued) await Bun.sleep(REDRAW_MS)
    }
    this.busy = false
  }

  private async draw(raw: string, complete: boolean) {
    const limits = this.inlineLimits()
    // One bad line must not lose the whole diagram: drop the lines d2 rejects and keep going.
    const { source, skipped } = complete ? await lenient(raw, this.palette) : { source: raw, skipped: [] as string[] }
    this.notice = skipped.length ? `${skipped.length} line${skipped.length > 1 ? "s" : ""} skipped: ${skipped[0]}` : ""
    // The model's own `direction:` wins (sequence diagrams have none). Otherwise partial diagrams
    // follow the window's shape and the finished one gets the more readable of both.
    const direction =
      hasDirection(source) || isSequence(source)
        ? undefined
        : complete
          ? await bestDirection(source, this.palette, this.cell, this.zoom, limits)
          : limits.cols * this.cell.w > 1.6 * limits.rows * this.cell.h
            ? "right"
            : "down"
    const base = themed(source, this.palette, direction)
    const svg = await compile(base)
    const plan = complete ? await this.plan(source, base, svg) : { frames: [{ svg: decorate(svg, this.palette, {}), delay: Infinity, step: -1 }], rest: 0, steps: [] }
    this.base = svgSize(svg)
    await this.commit(plan, complete, complete ? "" : `drawing… ${nodeOrder(source).length} boxes, ${arrowCount(source)} arrows`)
  }

  private async commit(plan: { frames: Frame[]; steps: Step[]; rest: number }, complete: boolean, status: string) {
    this.leaveCustom()
    this.frames = plan.frames
    this.steps = plan.steps
    this.rest = plan.rest
    this.index = 0
    this.ended = false
    this.playing = complete && MODE !== "static" && this.frames.length > 1
    if (!this.playing) this.index = this.rest
    // New frames: rebuild every surface at the new layout, keeping its views (and, for 3D, the
    // image on screen until the next one replaces it).
    ;[...this.surfaces.entries()].forEach(([key, surface]) => {
      const shown = surface.custom
      this.surface(key, surface.limits, true).custom = shown
    })
    if (this.kind === "scene3d") {
      this.segmentStart = performance.now()
      this.show(this.frames[this.index].view!, "full")
    }
    this.prefetch()
    if (this.kind !== "scene3d")
      await Promise.all([...this.surfaces.values()].filter((s) => s.views.size > 0).map((s) => this.job(s, this.index)))
    this.status = status
    this.schedule()
  }

  // 3D timeline: assembled overview → explode → slow turn → labels → one hold per step (the part
  // is lit, the rest ghosted) → reassemble. Scenes without explode offsets just turn.
  private async drawScene(text: string, complete: boolean) {
    const spec = complete ? parseScene(text) : partialScene(text)
    if (!spec) {
      if (complete) throw new Error(sceneError(text))
      return
    }
    if (!(await gpuAvailable())) throw new Error("3D needs WebGPU (bun-webgpu), which is not available here")
    this.scene = spec
    this.base = { width: 960, height: 600 }
    const camera = (yaw: number) => ({ ...DEFAULT_CAMERA, yaw })
    const apart = spec.parts.some((part) => part.explode.some((v) => v !== 0)) ? 1 : 0
    const assembled: SceneView = { camera: camera(45), explode: 0, labels: !apart }
    if (!complete)
      return this.commit({ frames: [{ view: assembled, delay: Infinity, step: -1 }], steps: [], rest: 0 }, false, `building 3D scene… ${spec.parts.length} parts`)
    const opened: SceneView = { camera: camera(58), explode: apart, labels: false }
    // The turn stays between 35° and 65° so exploded parts spread out instead of lining up.
    const turned: SceneView = { camera: camera(35), explode: apart, labels: true }
    const steps = spec.steps.map((s) => ({ caption: s.caption, focus: { edge: "", nodes: new Set([s.part]) } }))
    const frames: Frame[] = [
      { view: assembled, delay: TIMING.overview, step: -1 },
      ...(apart ? [{ from: assembled, view: opened, delay: 900, step: -1 }] : []),
      { from: apart ? opened : assembled, view: turned, delay: 1800, step: -1 },
      { view: turned, delay: 1100, step: -1 },
      ...spec.steps.map((s, i) => ({ view: { ...turned, focus: s.part }, delay: TIMING.hold, step: i })),
      ...(apart ? [{ from: { ...turned, labels: false }, view: { ...assembled, labels: false }, delay: 900, step: -1 }] : []),
    ]
    return this.commit({ frames, steps, rest: 0 }, true, "")
  }

  private async plan(source: string, base: string, svg: string) {
    // Sequence diagrams animate their messages in order. Graph diagrams use `# @step` lines that
    // name a connection or a box; names are matched against the ids d2 actually drew (so boxes
    // nested in containers resolve too), and a step that matches nothing is dropped.
    const sequence = sequenceSteps(source)
    const ids = groupIds(svg)
    const candidates = sequence ?? parseSteps(source).flatMap((s) => resolveStep(s, ids) ?? [])
    const compiled = await Promise.allSettled(candidates.map((s) => compile(highlighted(base, s.focus, this.palette))))
    const steps = candidates.filter((_, i) => compiled[i].status === "fulfilled")
    const stepSvgs = compiled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []))
    const order = nodeOrder(source)
    const p = this.palette
    const build = this.live || sequence
      ? []
      : order.map((_, i) => ({ svg: decorate(svg, p, { visible: new Set(order.slice(0, i + 1)) }), delay: TIMING.build, step: -1 }))
    const overview = { svg: decorate(svg, p, {}), delay: TIMING.overview, step: -1 }
    const focuses = steps.map((s) => s.focus)
    const stepFrames = steps.flatMap((_, i) => {
      const focus = focuses[i]
      const prev = i === 0 ? null : focuses[i - 1]
      // The first frames double as a crossfade from the previous step; connection steps also
      // run a pulse along the arrow, box steps just fade in.
      const count = focus.edge ? PULSE_FRAMES : FADE_FRAMES
      return [
        ...Array.from({ length: count }, (_, k) => ({
          svg: decorate(stepSvgs[i], p, {
            focus,
            prev,
            mix: Math.min(1, (k + 1) / FADE_FRAMES),
            pulse: focus.edge ? k / (PULSE_FRAMES - 1) : undefined,
          }),
          delay: TIMING.pulse,
          step: i,
        })),
        { svg: decorate(stepSvgs[i], p, { focus }), delay: TIMING.hold, step: i },
      ]
    })
    const last = focuses.at(-1)
    const outro = last
      ? [1, 2, 3, 4, 5, 6].map((k) => ({ svg: decorate(svg, p, { focus: null, prev: last, mix: k / 6 }), delay: TIMING.fade, step: -1 }))
      : []
    return { frames: [...build, overview, ...stepFrames, ...outro], rest: build.length, steps }
  }

  private schedule() {
    if (this.kind === "scene3d") return this.tick()
    clearTimeout(this.timer)
    this.timer = undefined
    const frame = this.frames[this.index]
    if (!frame || !this.playing || this.viewCount() === 0 || frame.delay === Infinity) return
    this.timer = setTimeout(async () => {
      const last = this.index + 1 >= this.frames.length
      // "once": stop on the overview after one play-through; "loop": go around again.
      if (last && MODE !== "loop") {
        this.index = this.rest
        this.playing = false
        this.ended = true
        this.notify()
        return
      }
      const next = last ? this.rest : this.index + 1
      await Promise.all([...this.surfaces.values()].filter((s) => s.views.size > 0).map((s) => this.job(s, next)))
      if (!this.playing) return
      this.index = next
      this.prefetch()
      this.notify()
      this.schedule()
    }, frame.delay)
  }

  private notify() {
    this.surfaces.forEach((surface) => surface.views.forEach((view) => view.sync()))
  }
}

class DiagramView extends BoxRenderable {
  private area: BoxRenderable
  private image: PlaceholderImage | ImageRenderable
  private caption: TextRenderable
  private shown = ""

  constructor(
    ctx: RenderContext,
    private diagram: LiveDiagram,
    onExpand: (diagram: LiveDiagram) => void,
  ) {
    super(ctx, { flexDirection: "column", flexShrink: 0, marginTop: 1, marginBottom: 1 })
    this.area = new BoxRenderable(ctx, { flexShrink: 0 })
    this.image = useKitty(ctx)
      ? new PlaceholderImage(ctx, () => diagram.image("inline"))
      : new ImageRenderable(ctx, { fit: "fit" })
    this.caption = new TextRenderable(ctx, {})
    this.area.add(this.image)
    this.add(this.area)
    this.add(this.caption)
    this.area.onMouseDown = () => {
      if (diagram.frames.length > 0 && !diagram.status) onExpand(diagram)
    }
    this.caption.onMouseDown = () => diagram.toggle()
    diagram.attach("inline", this, diagram.inlineLimits())
    this.sync()
  }

  sync() {
    const size = this.diagram.size("inline")
    if (this.area.height !== this.diagram.reservedRows()) this.area.height = this.diagram.reservedRows()
    if (this.image.width !== size.cols) this.image.width = size.cols
    if (this.image.height !== size.rows) this.image.height = size.rows
    if (this.shown !== this.diagram.captionKey()) {
      this.shown = this.diagram.captionKey()
      this.caption.content = this.diagram.caption(false)
    }
    const file = this.diagram.file("inline")
    if (this.image instanceof PlaceholderImage) this.image.requestRender()
    if (this.image instanceof ImageRenderable && file) this.image.source = file
  }

  protected override destroySelf() {
    this.diagram.detach("inline", this)
    super.destroySelf()
  }
}

// Full-window view of a diagram, shown inside a dialog. It renders its own frames at this
// size and plays the animation once on open.
export class ExpandedDiagram extends BoxRenderable {
  private image: PlaceholderImage | ImageRenderable
  private caption: TextRenderable
  private shown = ""

  constructor(
    ctx: RenderContext,
    private diagram: LiveDiagram,
    width: number,
    height: number,
  ) {
    super(ctx, { width, height, flexDirection: "column", alignItems: "center", paddingTop: 1 })
    this.image = useKitty(ctx)
      ? new PlaceholderImage(ctx, () => diagram.image("expanded"))
      : new ImageRenderable(ctx, { fit: "fit" })
    this.caption = new TextRenderable(ctx, { marginTop: 1 })
    this.add(this.image)
    this.add(this.caption)
    this.add(
      new TextRenderable(ctx, {
        content: diagram.interactive
          ? "drag or ←→↑↓ rotate · scroll or = - zoom · e explode · [ ] parts · r reset · space play · esc close"
          : "←/→ step · space play/pause · esc close",
        fg: RGBA.fromHex(diagram.palette.muted),
      }),
    )
    if (diagram.interactive) {
      // Drag to orbit (degrees per cell), scroll to zoom.
      const last = { x: 0, y: 0 }
      this.image.onMouseDown = (event) => {
        last.x = event.x
        last.y = event.y
      }
      this.image.onMouseDrag = (event) => {
        diagram.orbit((event.x - last.x) * 3, (event.y - last.y) * 4)
        last.x = event.x
        last.y = event.y
      }
      this.image.onMouseScroll = (event) => {
        if (event.scroll?.direction === "up") diagram.zoomBy(1.12)
        if (event.scroll?.direction === "down") diagram.zoomBy(1 / 1.12)
      }
    }
    diagram.attach("expanded", this, { cols: width - 4, rows: height - 5 })
    diagram.play()
    this.sync()
  }

  sync() {
    const size = this.diagram.size("expanded")
    if (this.image.width !== size.cols) this.image.width = size.cols
    if (this.image.height !== size.rows) this.image.height = size.rows
    if (this.shown !== this.diagram.captionKey()) {
      this.shown = this.diagram.captionKey()
      this.caption.content = this.diagram.caption(true)
    }
    const file = this.diagram.file("expanded")
    if (this.image instanceof PlaceholderImage) this.image.requestRender()
    if (this.image instanceof ImageRenderable && file) this.image.source = file
  }

  protected override destroySelf() {
    this.diagram.detach("expanded", this)
    super.destroySelf()
  }
}

// Draws Kitty Unicode placeholders for an uploaded image. The foreground colour encodes the
// image id, so changing frames is just a recolour of these cells.
class PlaceholderImage extends Renderable {
  constructor(
    ctx: RenderContext,
    private image: () => (Size & { id: number }) | undefined,
  ) {
    super(ctx, { flexShrink: 0 })
  }

  protected override renderSelf(buffer: OptimizedBuffer) {
    const image = this.image()
    if (!image) return
    const color = RGBA.fromInts((image.id >> 16) & 255, (image.id >> 8) & 255, image.id & 255)
    Array.from({ length: image.rows }).forEach((_, row) =>
      buffer.drawText(
        DIACRITICS.slice(0, image.cols)
          .map((col) => PLACEHOLDER + DIACRITICS[row] + col)
          .join(""),
        this.x,
        this.y + row,
        color,
      ),
    )
  }
}

// ---- Source handling ------------------------------------------------------------------------

// Fix the mistakes models make most: `a -> b | label` (the step syntax) instead of
// `a -> b: label`, shapes d2 doesn't have (`shape: server`), literal braces in labels, and
// icons (only the built-in set renders offline).
function repair(source: string) {
  return source
    .split("\n")
    .map((line) =>
      line.trim().startsWith("#")
        ? line
        : line
            .replace(/^([^:|#]*(?:<->|->|<-|--)[^:|#]*?)\s+\|\s+(.+)$/, "$1: $2")
            .replace(/shape:\s*([\w-]+)/g, (match, shape) => (SHAPES.has(shape) ? match : "shape: rectangle"))
            // Built-in icon names become placeholder URLs (inlined later); any other icon (URLs,
            // paths) is dropped, since rendering is offline.
            .replace(/(^|[{;\s])icon:\s*"?([^";}\s]+)"?\s*;?/g, (_, lead: string, name: string) => {
              const key = name.replace(/^https:\/\/dg-icon\.invalid\//, "").toLowerCase()
              return ICONS[key] ? `${lead}icon: "${ICON_URL}${key}";` : lead
            })
            // Braces in a label are literal text unless they hold `key: value` settings.
            .replace(/^([^:{"]+:\s*)([^"'{|][^{]*\{[^:;}]*\}[^{]*)$/, (_, head, label) => `${head}"${label.trim().replaceAll('"', '\\"')}"`),
    )
    .join("\n")
}

// The longest run of complete lines with balanced braces, so a half-written line or an open
// `{ ... }` block never reaches d2.
function stablePrefix(text: string) {
  const lines = text.split("\n").slice(0, -1)
  const ends = lines.reduce(
    (acc, line, i) => {
      const depth = acc.depth + (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0)
      return { depth, last: depth === 0 ? i : acc.last }
    },
    { depth: 0, last: -1 },
  )
  return lines.slice(0, ends.last + 1).join("\n")
}

const RESERVED = new Set(["direction", "vars", "classes", "style", "label", "shape", "layers", "scenarios", "steps"])

// Top-level shape ids in the order they first appear (declarations and connection endpoints).
function nodeOrder(source: string) {
  const ids: string[] = []
  const add = (id: string) => id && !ids.includes(id) && ids.push(id)
  source.split("\n").reduce((depth, raw) => {
    const line = raw.replace(/#.*$/, "").trim()
    if (depth === 0 && line) {
      const head = line.split(":")[0]
      const ends = head.split(ARROW).filter((_, i) => i % 2 === 0)
      if (ends.length > 1) ends.forEach((e) => add(e.trim()))
      if (ends.length === 1 && line.includes(":") && !RESERVED.has(head.trim().split(".")[0])) add(head.trim())
    }
    return depth + (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0)
  }, 0)
  return ids
}

function parseSteps(source: string) {
  return source.split("\n").flatMap((line) => {
    const match = STEP.exec(line)
    return match ? [{ edge: match[1], caption: match[2] ?? match[1] }] : []
  })
}

// Every shape and connection id in a d2 SVG.
function groupIds(svg: string) {
  return new Set([...svg.matchAll(/<g class="([A-Za-z0-9+/=]+)/g)].flatMap((m) => groupId(m[1]) ?? []))
}

// Maps a `# @step` target to drawn ids: `a -> b` is a connection, a bare name is a box. Exact
// ids win; otherwise a unique match inside a container (`timeline.(a -> b)[0]`, `svc.cache`).
function resolveStep(step: { edge: string; caption: string }, ids: Set<string>): Step | undefined {
  const parts = step.edge.split(ARROW).map((part) => part.trim())
  const find = (id: string) => {
    if (ids.has(id)) return id
    const nested = [...ids].filter((candidate) => candidate.endsWith(`.${id}`))
    return nested.length === 1 ? nested[0] : undefined
  }
  if (parts.length === 1) {
    const node = find(parts[0])
    return node ? { caption: step.caption, focus: { edge: "", nodes: new Set([node]) } } : undefined
  }
  const edge = find(`(${parts.join(" ")})[0]`)
  if (!edge) return
  const prefix = edge.slice(0, edge.indexOf("("))
  return { caption: step.caption, focus: { edge, nodes: new Set(parts.filter((_, i) => i % 2 === 0).map((n) => prefix + n)) } }
}

const SEQUENCE = /shape\s*:\s*sequence_diagram/

function isSequence(source: string) {
  return SEQUENCE.test(source)
}

function hasDirection(source: string) {
  return source.split("\n").some((line) => /^direction\s*:/.test(line))
}

function arrowCount(source: string) {
  return source.split("\n").filter((line) => !line.trim().startsWith("#") && ARROW.test(line.split(":")[0])).length
}

// Steps for the first sequence diagram: one per message, in order. d2 ids repeated messages
// between the same pair as [0], [1], …, scoped by the container ("dns.(a -> b)[1]").
function sequenceSteps(source: string): Step[] | undefined {
  const lines = source.split("\n")
  const at = lines.findIndex((line) => SEQUENCE.test(line))
  if (at < 0) return
  // The sequence diagram is either the whole diagram (root `shape:`) or a container block.
  const depthAt = (i: number) =>
    lines.slice(0, i).reduce((d, line) => d + (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0), 0)
  const depth = depthAt(at)
  const opener = lines.slice(0, at).findLastIndex((line, i) => line.includes("{") && depthAt(i) === depth - 1)
  const container = depth === 0 || opener < 0 ? "" : lines[opener].split(/[:{]/)[0].trim()
  const prefix = container ? `${container}.` : ""
  const seen = new Map<string, number>()
  return lines.flatMap((raw, i) => {
    const line = raw.replace(/#.*$/, "").trim()
    if (i <= opener || depthAt(i) !== depth || !line) return []
    const [head, ...label] = line.split(":")
    const parts = head.split(ARROW).map((part) => part.trim())
    if (parts.length !== 3 || !parts[0] || !parts[2]) return []
    const pair = parts.join(" ")
    const n = seen.get(pair) ?? 0
    seen.set(pair, n + 1)
    const caption = label.join(":").replace(/\{.*$/, "").trim() || pair
    return [{ caption, focus: { edge: `${prefix}(${pair})[${n}]`, nodes: new Set([prefix + parts[0], prefix + parts[2]]) } }]
  })
}

// Compiles the finished source, removing the lines d2 reports as errors (up to 3 rounds).
// Returns the source that compiles and short descriptions of what was dropped.
async function lenient(source: string, p: Palette) {
  const attempt = async (src: string, skipped: string[], round: number): Promise<{ source: string; skipped: string[] }> => {
    const error = await compile(themed(src, p, undefined)).then(
      () => undefined,
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    )
    if (error === undefined) return { source: src, skipped }
    const lines = src.split("\n")
    const bad = new Set([...error.matchAll(/line (\d+):/g)].map((m) => Number(m[1]) - 1).filter((n) => n < lines.length))
    if (round >= 3 || bad.size === 0) throw new Error(error)
    return attempt(
      lines.filter((_, i) => !bad.has(i)).join("\n"),
      [...skipped, ...[...bad].map((n) => `line ${n + 1} (${lines[n].trim().slice(0, 40)})`)],
      round + 1,
    )
  }
  return attempt(source, [], 0)
}

// The model's source comes first so d2's error line numbers match the model's lines.
function themed(source: string, p: Palette, direction: string | undefined) {
  return `${source}
${direction ? `direction: ${direction}` : ""}

vars: {
  d2-config: {
    theme-overrides: {
      N1: "${p.text}"; N2: "${p.muted}"; N3: "${p.muted}"; N4: "${p.line}"; N5: "${p.line}"; N6: "${p.fill}"; N7: "${p.fill}"
      B1: "${p.line}"; B2: "${p.line}"; B3: "${p.line}"; B4: "${p.fillStrong}"; B5: "${p.fill}"; B6: "${p.fill}"
      AA2: "${p.line}"; AA4: "${p.fillStrong}"; AA5: "${p.fill}"; AB4: "${p.fillStrong}"; AB5: "${p.fill}"
    }
  }
}
style.fill: transparent
classes: {
  start: {shape: oval; style: {stroke: "${p.success}"; fill: "${p.fillStrong}"; bold: true}}
  end: {shape: oval; style: {stroke: "${p.info}"; fill: "${p.fillStrong}"; bold: true}}
  screen: {style: {stroke: "${p.line}"; fill: "${p.fillStrong}"}}
  action: {style: {stroke: "${p.line}"}}
  decision: {shape: diamond; style: {stroke: "${p.warning}"}}
  system: {shape: hexagon; style: {stroke: "${p.muted}"}}
  note: {shape: page; style: {stroke: "${p.muted}"; stroke-dash: 3; font-color: "${p.muted}"; italic: true}}
  alt: {style: {stroke: "${p.muted}"; stroke-dash: 4; font-color: "${p.muted}"}}
  error: {style: {stroke: "${p.error}"; stroke-dash: 3; font-color: "${p.error}"}}
  ok: {style: {stroke: "${p.success}"; font-color: "${p.success}"}}
}
*.style.border-radius: 8
*.style.font-size: ${LABEL_PX}
(* -> *)[*].style.font-size: 12`
}

function highlighted(source: string, focus: Focus, p: Palette) {
  return [
    source,
    ...(focus.edge
      ? [
          `${focus.edge}.style.stroke: "${p.accent}"`,
          `${focus.edge}.style.stroke-width: 3`,
          `${focus.edge}.style.font-color: "${p.accent}"`,
        ]
      : []),
    ...[...focus.nodes].flatMap((n) => [
      `${n}.style.stroke: "${p.accent}"`,
      `${n}.style.fill: "${p.fillStrong}"`,
      `${n}.style.bold: true`,
    ]),
  ].join("\n")
}

// ---- SVG frames -----------------------------------------------------------------------------

type Decoration = {
  focus?: Focus | null // highlighted step; null = overview (nothing dimmed)
  prev?: Focus | null // crossfade from this state…
  mix?: number // …to `focus`, 0..1
  pulse?: number // 0..1 position of the travelling pulse along the focused connection
  visible?: Set<string> // build-in: only these nodes (and connections between them) are shown
}

// Post-processes d2's SVG: soft shadows under shapes; with a focus, everything else fades and
// the focused parts glow (crossfading from the previous step); a pulse travels along the
// focused connection; build-in hides shapes.
function decorate(svg: string, p: Palette, d: Decoration) {
  const defs = `<defs>
<filter id="dg-soft" x="-20%" y="-20%" width="140%" height="160%"><feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#000" flood-opacity="0.4"/></filter>
<filter id="dg-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3" result="b"/><feFlood flood-color="${p.accent}" flood-opacity="0.45"/><feComposite in2="b" operator="in" result="g"/><feMerge><feMergeNode in="g"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
</defs>`
  const mix = d.mix ?? 1
  // d2 writes `<g class="<base64 id> <d2 classes>">`; screens get a window-style header strip.
  const groups = screenStrips(icons(svg, p), p).replace(/<g class="([A-Za-z0-9+/=]+)((?: [\w-]+)*)">/g, (match, cls: string, extra: string) => {
    const id = groupId(cls)
    if (!id) return match
    const edge = id.startsWith("(")
    if (d.visible) {
      const ends = edge ? id.slice(1, id.lastIndexOf(")")).split(ARROW).filter((_, i) => i % 2 === 0) : [id]
      return ends.every((e) => d.visible!.has(e.trim())) ? match : `<g class="${cls}${extra}" opacity="0">`
    }
    // A focused container keeps everything inside it (boxes and arrows) in focus too.
    const inside = (f: Focus) => [...f.nodes].some((n) => id.startsWith(`${n}.`))
    const active = (f: Focus | null | undefined) => !f || (edge ? id === f.edge : f.nodes.has(id)) || inside(f)
    const level = (f: Focus | null | undefined) => (active(f) ? 1 : DIM)
    const opacity = d.mix === undefined ? level(d.focus) : level(d.prev) + (level(d.focus) - level(d.prev)) * mix
    const glow = d.focus && active(d.focus) && mix >= 0.66 ? ' filter="url(#dg-glow)"' : ""
    const fade = opacity < 0.999 ? ` opacity="${opacity.toFixed(2)}"` : ""
    return glow || fade ? `<g class="${cls}${extra}"${fade}${glow}>` : match
  })
  const shadows = groups.replaceAll('<g class="shape"', '<g class="shape" filter="url(#dg-soft)"')
  const pulse = d.focus && d.pulse !== undefined ? pulseMarkup(svg, d.focus.edge, d.pulse, p) : ""
  // d2 nests the drawing in an inner <svg>; defs go first in it, the pulse last.
  const inner = shadows.indexOf(">", shadows.indexOf("<svg", shadows.indexOf("<svg") + 4)) + 1
  const end = shadows.lastIndexOf("</svg>", shadows.lastIndexOf("</svg>") - 1)
  return shadows.slice(0, inner) + defs + shadows.slice(inner, end) + pulse + shadows.slice(end)
}

// d2 tags each shape and connection group with its id, base64-encoded (HTML-escaped first).
function groupId(cls: string) {
  const decoded = Buffer.from(cls, "base64").toString("utf8")
  if (Buffer.from(decoded, "utf8").toString("base64") !== cls || !/^[\x20-\x7e]+$/.test(decoded)) return
  return decoded.replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&")
}

// Adds a header strip with three dots to every `screen` box so it reads as a page or window.
function screenStrips(svg: string, p: Palette) {
  return svg.replace(
    /(<g class="[A-Za-z0-9+/=]+(?: [\w-]+)* ?\bscreen\b[^"]*"[^>]*>[\s\S]*?<rect x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)"[^>]*\/>)/g,
    (match, _all, x: string, y: string, w: string) => {
      const [left, top, width] = [Number(x), Number(y), Number(w)]
      const dots = [0, 1, 2]
        .map((i) => `<circle cx="${left + 8 + i * 5}" cy="${top + 4}" r="1.2" fill="${p.fill}" opacity="0.9"/>`)
        .join("")
      return `${match}<rect x="${left + 1}" y="${top + 1}" width="${width - 2}" height="6" rx="3" fill="${p.info}" opacity="0.85"/>${dots}`
    },
  )
}

// Icons are written as placeholder URLs (see repair) and inlined here in theme colours.
function icons(svg: string, p: Palette) {
  return svg.replace(/(href)="https:\/\/dg-icon\.invalid\/([\w-]+)"/g, (match, attr: string, name: string) => {
    const body = ICONS[name]
    if (!body) return match
    const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${p.text}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
    return `${attr}="data:image/svg+xml;base64,${Buffer.from(icon).toString("base64")}"`
  })
}

// A comet: a bright head with a short fading tail, eased so it accelerates and settles.
function pulseMarkup(svg: string, edge: string, t: number, p: Palette) {
  const cls = Buffer.from(edge.replaceAll("&", "&amp;").replaceAll(">", "&gt;").replaceAll("<", "&lt;")).toString("base64")
  const group = svg.search(new RegExp(`<g class="${cls.replace(/[+/=]/g, "\\$&")}[" ]`))
  const d = group < 0 ? undefined : /<path d="([^"]+)"[^>]*class="connection/.exec(svg.slice(group))?.[1]
  if (!d) return ""
  const points = samplePath(d)
  const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
  const circle = (lag: number, r: number, fill: string, opacity: number, glow: boolean) => {
    const at = pointAt(points, Math.max(0, eased - lag))
    return `<circle cx="${at.x.toFixed(1)}" cy="${at.y.toFixed(1)}" r="${r}" fill="${fill}" opacity="${opacity}"${glow ? ' filter="url(#dg-glow)"' : ""}/>`
  }
  return [
    circle(0.16, 3, p.accent, 0.2, false),
    circle(0.11, 4, p.accent, 0.35, false),
    circle(0.06, 5, p.accent, 0.6, true),
    circle(0, 7, p.accent, 1, true),
    circle(0, 3, p.text, 0.95, false),
  ].join("")
}

type Point = { x: number; y: number }

// Flattens an SVG path (absolute M/L/H/V/C/S/Q/Z, as d2 emits) into a polyline. Unknown
// commands just jump to their last coordinate pair, so parsing always advances.
function samplePath(d: string) {
  const tokens = d.match(/[A-Za-z]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? []
  const points: Point[] = []
  let at: Point = { x: 0, y: 0 }
  let i = 0
  while (i < tokens.length) {
    const command = /[A-Za-z]/.test(tokens[i]) ? tokens[i++].toUpperCase() : "L"
    const args: number[] = []
    while (i < tokens.length && !/[A-Za-z]/.test(tokens[i])) args.push(Number(tokens[i++]))
    const pairs = Array.from({ length: Math.floor(args.length / 2) }, (_, k) => ({ x: args[2 * k], y: args[2 * k + 1] }))
    if (command === "H") at = { x: args.at(-1) ?? at.x, y: at.y }
    if (command === "V") at = { x: at.x, y: args.at(-1) ?? at.y }
    if (command === "C" || command === "S" || command === "Q") {
      const from = at
      const end = pairs.at(-1) ?? at
      Array.from({ length: 12 }, (_, k) => (k + 1) / 12).forEach((t) => points.push(bezier([from, ...pairs], t)))
      at = end
      continue
    }
    if (command !== "H" && command !== "V" && command !== "Z") at = pairs.at(-1) ?? at
    if (command !== "Z") points.push(at)
  }
  return points
}

function bezier(pts: Point[], s: number): Point {
  if (pts.length === 1) return pts[0]
  return bezier(
    pts.slice(1).map((pt, k) => ({ x: pts[k].x + (pt.x - pts[k].x) * s, y: pts[k].y + (pt.y - pts[k].y) * s })),
    s,
  )
}

function pointAt(points: Point[], t: number) {
  const lengths = points.slice(1).map((pt, k) => Math.hypot(pt.x - points[k].x, pt.y - points[k].y))
  const total = lengths.reduce((a, b) => a + b, 0)
  let remaining = t * total
  for (let k = 0; k < lengths.length; k++) {
    if (remaining <= lengths[k] && lengths[k] > 0) {
      const s = remaining / lengths[k]
      return { x: points[k].x + (points[k + 1].x - points[k].x) * s, y: points[k].y + (points[k + 1].y - points[k].y) * s }
    }
    remaining -= lengths[k]
  }
  return points[points.length - 1] ?? { x: 0, y: 0 }
}

function svgSize(svg: string) {
  const box = /viewBox="[-\d.]+ [-\d.]+ ([\d.]+) ([\d.]+)"/.exec(svg)
  return { width: Number(box?.[1] ?? 100), height: Number(box?.[2] ?? 100) }
}

// ---- Rendering ------------------------------------------------------------------------------

// Lays the diagram out both ways and keeps the direction that fits the window at the larger
// scale (bigger, more readable labels). Decided once per diagram so it never flips mid-stream.
async function bestDirection(source: string, p: Palette, cell: Cell, zoom: number, limits: Limits) {
  const options = ["down", "right"] as const
  const scales = await Promise.all(
    options.map(async (direction) => scaled(svgSize(await compile(themed(source, p, direction))), cell, zoom, limits).zoom),
  )
  return scales[1] > scales[0] * 1.1 ? "right" : "down"
}

const compiled = new Map<string, Promise<string>>()

// D2 source -> SVG text (in-memory cache). Needs `d2` on PATH.
function compile(source: string) {
  const key = createHash("sha1").update(source).digest("hex")
  const cached = compiled.get(key)
  if (cached) return cached
  const job = (async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-d2-"))
    try {
      const input = path.join(dir, "in.d2")
      const output = path.join(dir, "out.svg")
      await Bun.write(input, source)
      const f = font()
      await run(
        [
          "d2",
          "--layout",
          "elk",
          "--bundle=false", // icons are inlined later, in theme colours
          "--pad",
          "16",
          ...(f ? ["--font-regular", f.regular, "--font-bold", f.bold, "--font-italic", f.italic] : []),
          input,
          output,
        ],
        undefined,
      )
      const svg = await Bun.file(output).text()
      // d2 embeds its fonts under generated names librsvg cannot use; point it at the system font.
      return f ? svg.replace(/d2-\d+-font-(regular|bold|italic)/g, f.family) : svg
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })()
  job.catch(() => compiled.delete(key))
  compiled.set(key, job)
  return job
}

let rasterising = 0
const waiting: (() => void)[] = []

// SVG -> transparent PNG at `zoom`, cached on disk by content; at most RASTER_JOBS at once.
async function rasterise(svg: string, zoom: number) {
  const out = path.join(CACHE, createHash("sha1").update(svg).update(String(zoom)).digest("hex").slice(0, 20) + ".png")
  if (existsSync(out)) return out
  if (rasterising >= RASTER_JOBS) await new Promise<void>((resolve) => waiting.push(resolve))
  rasterising++
  try {
    mkdirSync(CACHE, { recursive: true })
    await run(["rsvg-convert", "--zoom", zoom.toFixed(3), "-o", out], svg)
    return out
  } finally {
    rasterising--
    waiting.shift()?.()
  }
}

async function run(cmd: string[], input: string | undefined) {
  const proc = Bun.spawn(cmd, { stdin: input === undefined ? "ignore" : new Blob([input]), stdout: "ignore", stderr: "pipe" })
  if ((await proc.exited) === 0) return
  // Keep only the error lines, without temp file paths: "line 12: indexed edge does not exist".
  const message = (await new Response(proc.stderr).text())
    .split("\n")
    .filter((line) => line.startsWith("err:") || line.startsWith("Error"))
    .map((line) =>
      line
        .replace(/^err:\s*/, "")
        .replace(/^failed to compile \S+: /, "")
        .replace(/\S+\.d2:(\d+):\d+:/, "line $1:"),
    )
    .filter((line, i, all) => all.indexOf(line) === i)
  throw new Error(message.join("; ") || `${cmd[0]} failed`)
}

function font() {
  const dir = FONT_DIRS.find((d) => existsSync(path.join(d, "JetBrainsMono-Regular.ttf")))
  if (!dir) return
  return {
    family: "JetBrains Mono",
    regular: path.join(dir, "JetBrainsMono-Regular.ttf"),
    bold: path.join(dir, "JetBrainsMono-Bold.ttf"),
    italic: path.join(dir, "JetBrainsMono-Italic.ttf"),
  }
}

function cellSize(ctx: RenderContext) {
  const res = ctx.resolution
  if (res && ctx.terminalWidth && ctx.terminalHeight) return { w: res.width / ctx.terminalWidth, h: res.height / ctx.terminalHeight }
  return { w: 16, h: 34 } // Retina-ish default when the terminal doesn't report pixel size
}

// Zoom and cell size for a drawing of `base` SVG units shown within `limits`: 1:1 pixels when
// it fits, otherwise rendered smaller (not just displayed smaller) to save terminal memory.
function scaled(base: { width: number; height: number }, cell: Cell, zoom: number, limits: Limits) {
  const cols = Math.min(limits.cols, DIACRITICS.length)
  const rows = Math.min(limits.rows, DIACRITICS.length)
  const z = zoom * Math.min(1, (cols * cell.w) / (base.width * zoom), (rows * cell.h) / (base.height * zoom))
  return {
    zoom: z,
    size: {
      cols: Math.max(1, Math.min(cols, Math.round((base.width * z) / cell.w))),
      rows: Math.max(1, Math.min(rows, Math.round((base.height * z) / cell.h))),
    },
  }
}

function useKitty(ctx: RenderContext) {
  if (PROTOCOL !== "auto") return PROTOCOL === "kitty"
  return !!ctx.capabilities?.kitty_graphics && !process.env.TMUX
}

// Image ids live in the placeholder's 24-bit foreground colour; keep them clear of OpenTUI's.
let nextImageId = 0x200000 + Math.floor(Math.random() * 0x10000)

function upload(ctx: RenderContext, file: string, cols: number, rows: number) {
  return uploadPng(ctx, readFileSync(file), cols, rows)
}

function uploadPng(ctx: RenderContext, png: Buffer, cols: number, rows: number) {
  const id = nextImageId++
  const data = png.toString("base64")
  const chunks = data.match(/.{1,4096}/g) ?? []
  writeGraphics(
    ctx,
    chunks.map((chunk, i) => {
      const more = i < chunks.length - 1 ? 1 : 0
      const ctrl = i === 0 ? `a=T,U=1,f=100,q=2,i=${id},c=${cols},r=${rows},m=${more}` : `m=${more}`
      return `\x1b_G${ctrl};${chunk}\x1b\\`
    }),
  )
  return id
}

// Moving 3D frames: GPU pixels encoded as a fast PNG in memory (no SVG overlay, no rsvg-convert).
// Deliberately PNG and never Kitty's zlib transmission (`o=z`): Ghostty 1.3.1 inflates `o=z`
// data with Zig's std flate decompressor, which panics on it and takes the terminal down
// (fixed upstream by switching to wuffs after 1.3.1); its PNG path already uses wuffs.
function uploadRaw(ctx: RenderContext, frame: { rgba: Buffer; width: number; height: number }, size: Size) {
  return uploadPng(ctx, encodePng(frame.width, frame.height, frame.rgba, 1), size.cols, size.rows)
}

// Frees an image once its replacement is surely on screen: deleting it straight away would
// blank the cells that still point at it until the next redraw (the flicker).
function releaseLater(ctx: RenderContext, id: number) {
  setTimeout(() => release(ctx, id), 150)
}

// Interpolates two 3D views (eased); labels are only drawn on still frames.
function blend(from: SceneView, to: SceneView, t: number): SceneView {
  const k = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
  const mix = (a: number, b: number) => a + (b - a) * k
  return {
    camera: {
      yaw: mix(from.camera.yaw, to.camera.yaw),
      pitch: mix(from.camera.pitch, to.camera.pitch),
      zoom: mix(from.camera.zoom, to.camera.zoom),
      perspective: to.camera.perspective,
    },
    explode: mix(from.explode, to.explode),
    focus: k < 0.5 ? from.focus : to.focus,
    labels: false,
  }
}

// Frees the image (and its decoded pixels) in the terminal.
function release(ctx: RenderContext, id: number) {
  writeGraphics(ctx, [`\x1b_Ga=d,d=I,i=${id},q=2\x1b\\`])
}

function writeGraphics(ctx: RenderContext, sequences: string[]) {
  const wrap = (seq: string) => (process.env.TMUX ? `\x1bPtmux;${seq.replaceAll("\x1b", "\x1b\x1b")}\x1b\\` : seq)
  // writeOut is private on CliRenderer, but it serialises with the renderer's own output.
  ;(ctx as unknown as { writeOut(data: string): void }).writeOut(sequences.map(wrap).join(""))
}
