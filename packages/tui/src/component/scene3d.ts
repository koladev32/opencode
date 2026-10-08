import { createHash } from "node:crypto"
import { deflateSync } from "node:zlib"
import { COMPONENTS, KIT_MATERIALS, blueprintBackground, blueprintMarks, composite, gpuPreset, pieces } from "./scene3d-kit"

// 3D scenes for inline diagrams: a ```scene3d block (YAML) lists parts built from primitive
// shapes. It is data, not code, so nothing the model writes is executed. Scenes render
// headless on the GPU (three.js + WebGPU through bun-webgpu) into PNGs, then go through the
// same frame pipeline as d2 diagrams. Labels are drawn as an SVG overlay in the terminal font.
//
//   title: Graphics card
//   parts:
//     - id: pcb
//       label: Circuit board
//       shape: box            # box | cylinder | sphere | cone | torus | capsule
//       size: [10, 0.15, 4]   # box: w h d · cylinder/cone: radius height · sphere: radius · torus: radius tube
//       at: [0, 0, 0]
//       rotate: [0, 0, 0]     # degrees
//       material: pcb
//       explode: [0, -2, 0]   # where the part moves in the exploded view
//       repeat: {count: 24, step: [0.38, 0, 0]}
//   steps:
//     - part: pcb
//       caption: Everything is mounted on the board

export type Part = {
  id: string
  label?: string
  shape: "box" | "cylinder" | "sphere" | "cone" | "torus" | "capsule"
  size: number[]
  at: number[]
  rotate: number[]
  material: string
  explode: number[]
  repeat?: { count: number; step: number[] }
  kind?: string // a component from scene3d-kit (fan, fins, heatpipes, …)
  options?: Record<string, unknown>
}
export type Scene = { title?: string; style: "theme" | "blueprint"; parts: Part[]; steps: { part: string; caption: string }[] }
export type Camera = { yaw: number; pitch: number; zoom: number; perspective: boolean }
export type SceneView = { camera: Camera; explode: number; focus?: string; labels: boolean }
export type ScenePalette = { text: string; muted: string; line: string; accent: string }

export const DEFAULT_CAMERA: Camera = { yaw: 45, pitch: 30, zoom: 1, perspective: false }

const SHAPES = new Set(["box", "cylinder", "sphere", "cone", "torus", "capsule"])
const MAX_PARTS = 80
const MAX_MESHES = 800
const MATERIALS: Record<string, { color: number; metalness: number; roughness: number; opacity?: number }> = {
  pcb: { color: 0x1f6f43, metalness: 0.1, roughness: 0.8 },
  metal: { color: 0xb8c0c8, metalness: 0.9, roughness: 0.3 },
  aluminium: { color: 0xc9ced4, metalness: 0.85, roughness: 0.35 },
  copper: { color: 0xb87333, metalness: 0.9, roughness: 0.35 },
  gold: { color: 0xd4af37, metalness: 0.95, roughness: 0.3 },
  silicon: { color: 0x2b2b2b, metalness: 0.5, roughness: 0.4 },
  plastic: { color: 0x30343a, metalness: 0.2, roughness: 0.6 },
  rubber: { color: 0x1b1b1b, metalness: 0, roughness: 0.9 },
  glass: { color: 0x9fd3ff, metalness: 0.1, roughness: 0.1, opacity: 0.35 },
  dark: { color: 0x22252a, metalness: 0.3, roughness: 0.6 },
  light: { color: 0xe5e7eb, metalness: 0.1, roughness: 0.6 },
  ...KIT_MATERIALS,
}

// ---- Parsing --------------------------------------------------------------------------------

// Parses and sanitises a scene; returns undefined if it has no usable parts. Unknown fields are
// ignored, numbers are clamped, and repeats are capped so a scene can't blow up the GPU.
export function parseScene(text: string): Scene | undefined {
  const data = readYaml(text) as
    | { title?: unknown; parts?: unknown; steps?: unknown; preset?: unknown; options?: unknown; style?: unknown }
    | undefined
  if (!data || typeof data !== "object") return
  const preset = data.preset === "gpu" ? gpuPreset((data.options as Record<string, unknown>) ?? {}) : undefined
  if (!preset && !Array.isArray(data.parts)) return
  const vec = (v: unknown, fallback: number[], length = 3) =>
    Array.isArray(v) && v.every((n) => typeof n === "number" && Number.isFinite(n))
      ? [...v.slice(0, length), ...fallback.slice(v.length)].map((n) => Math.max(-1000, Math.min(1000, n)))
      : fallback
  const meshes = { count: 0 }
  const own = (Array.isArray(data.parts) ? data.parts : []).slice(0, MAX_PARTS).flatMap((raw, i): Part[] => {
    if (!raw || typeof raw !== "object") return []
    const p = raw as Record<string, unknown>
    const shape = typeof p.shape === "string" && SHAPES.has(p.shape) ? (p.shape as Part["shape"]) : "box"
    const repeat = p.repeat as { count?: unknown; step?: unknown } | undefined
    const count = Math.max(1, Math.min(64, Math.floor(Number(repeat?.count) || 1)))
    if (meshes.count + count > MAX_MESHES) return []
    meshes.count += count
    return [
      {
        id: typeof p.id === "string" && p.id ? p.id : `part${i + 1}`,
        label: typeof p.label === "string" ? p.label.slice(0, 40) : undefined,
        shape,
        size: vec(p.size, [1, 1, 1]).map((n) => Math.max(0.01, Math.abs(n))),
        at: vec(p.at, [0, 0, 0]),
        rotate: vec(p.rotate, [0, 0, 0]),
        material: typeof p.material === "string" ? p.material.toLowerCase() : "plastic",
        explode: vec(p.explode, [0, 0, 0]),
        repeat: count > 1 ? { count, step: vec(repeat?.step, [1, 0, 0]) } : undefined,
        kind: typeof p.kind === "string" && COMPONENTS.has(p.kind) ? p.kind : undefined,
        options: p.options && typeof p.options === "object" ? (p.options as Record<string, unknown>) : undefined,
      },
    ]
  })
  // A preset supplies the object; the model's own parts are added on top of it.
  const parts = [...(preset?.parts ?? []), ...own]
  if (parts.length === 0) return
  const ids = new Set(parts.map((p) => p.id))
  const rawSteps = Array.isArray(data.steps) && data.steps.length > 0 ? data.steps : (preset?.steps ?? [])
  const steps = rawSteps.flatMap((raw) => {
    const s = raw as { part?: unknown; caption?: unknown }
    return typeof s?.part === "string" && ids.has(s.part)
      ? [{ part: s.part, caption: typeof s.caption === "string" ? s.caption.slice(0, 80) : s.part }]
      : []
  })
  return {
    title: typeof data.title === "string" ? data.title : preset?.title,
    style: data.style === "blueprint" || (data.style === undefined && !!preset) ? "blueprint" : "theme",
    parts,
    steps,
  }
}

// The YAML error for a scene that can't be read even after repair (shown to the user).
export function sceneError(text: string) {
  try {
    Bun.YAML.parse(repairYaml(text))
    return "the 3D scene has no usable parts"
  } catch (e) {
    return `the 3D scene could not be read: ${e instanceof Error ? e.message : String(e)}`
  }
}

function readYaml(text: string) {
  try {
    return Bun.YAML.parse(text)
  } catch {
    try {
      return Bun.YAML.parse(repairYaml(text))
    } catch {
      return undefined
    }
  }
}

const KEYS = "id|label|shape|size|at|rotate|material|explode|repeat|count|step|part|caption|title"
const TEXT_VALUE = new RegExp(
  `\\b(caption|label|title)\\s*:\\s*(?!["'])(.+?)(?=\\s*,\\s*(?:${KEYS})\\s*:|\\s*\\}\\s*$|\\s*$)`,
  "g",
)

// Models write free text unquoted (`caption: Control plane: API server, scheduler`), which YAML
// rejects when it contains `: ` or commas. Quote caption/label/title values, in flow maps and in
// block style alike.
function repairYaml(text: string) {
  return text
    .split("\n")
    .map((line) => (line.trim().startsWith("#") ? line : line.replace(TEXT_VALUE, (_, key: string, value: string) => `${key}: ${JSON.stringify(value.trim())}`)))
    .join("\n")
}

// While streaming: the scene up to the last complete part (YAML list items under `parts:`).
export function partialScene(text: string): Scene | undefined {
  const lines = text.split("\n")
  const items = lines.flatMap((line, i) => (/^\s*-\s+id\s*:/.test(line) ? [i] : []))
  if (items.length < 2) return
  return parseScene(lines.slice(0, items.at(-1)).join("\n"))
}

// ---- GPU rendering --------------------------------------------------------------------------

type Three = typeof import("three/webgpu")
type Gpu = {
  THREE: Three
  environment: InstanceType<Three["Texture"]>
  device: GPUDevice
  renderer: InstanceType<Three["WebGPURenderer"]>
  context: { getCurrentTexture(): GPUTexture; setSize(w: number, h: number): void }
  canvas: { width: number; height: number }
}

let gpu: Promise<Gpu | undefined> | undefined
let queue: Promise<unknown> = Promise.resolve()

export function gpuAvailable() {
  return (gpu ??= initGpu()).then((g) => !!g)
}

async function initGpu(): Promise<Gpu | undefined> {
  try {
    const { createWebGPUDevice, setupGlobals, GPUCanvasContextMock } = await import("bun-webgpu")
    // The compiled binary can't embed the native library; point at it explicitly if needed.
    setupGlobals(process.env.OPENCODE_WEBGPU_LIB ? { libPath: process.env.OPENCODE_WEBGPU_LIB } : undefined)
    // three.js drives its own loop with requestAnimationFrame; we render on demand only.
    globalThis.requestAnimationFrame ??= ((cb: (t: number) => void) => setTimeout(() => cb(performance.now()), 1000)) as never
    globalThis.cancelAnimationFrame ??= ((id: ReturnType<typeof setTimeout>) => clearTimeout(id)) as never
    const THREE = await import("three/webgpu")
    const device = await createWebGPUDevice()
    const canvas = { width: 64, height: 64, style: {}, addEventListener() {}, removeEventListener() {} } as Record<string, unknown> & {
      width: number
      height: number
    }
    const context = new GPUCanvasContextMock(canvas as never, 64, 64)
    canvas.getContext = (type: string) => (type === "webgpu" ? context : null)
    const renderer = new THREE.WebGPURenderer({ canvas: canvas as never, device, alpha: true, antialias: true })
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    await renderer.init()
    // A studio environment generated in code (no files) for realistic metal and glass.
    const { RoomEnvironment } = await import("three/examples/jsm/environments/RoomEnvironment.js")
    const environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture
    return { THREE, environment, device, renderer, context: context as never, canvas }
  } catch {
    return undefined
  }
}

const built = new Map<string, Promise<BuiltScene>>()
type BuiltScene = {
  scene: InstanceType<Three["Scene"]>
  shadow: InstanceType<Three["Mesh"]>
  parts: { part: Part; meshes: InstanceType<Three["Mesh"]>[]; base: InstanceType<Three["Vector3"]>[] }[]
  radius: number
  center: InstanceType<Three["Vector3"]>
}

// Renders one view of a scene at width×height and returns an SVG (the GPU image plus labels).
// Used for still frames.
export function renderScene(spec: Scene, palette: ScenePalette, view: SceneView, width: number, height: number) {
  return enqueue(() => draw(spec, palette, view, Math.round(width), Math.round(height), true).then((r) => r.svg!))
}

// Fast path for motion: raw RGBA pixels straight from the GPU, no labels, no PNG/SVG round trip.
export function renderSceneRaw(spec: Scene, palette: ScenePalette, view: SceneView, width: number, height: number) {
  return enqueue(() => draw(spec, palette, view, Math.round(width), Math.round(height), false))
}

// One GPU, one canvas: renders run one at a time.
function enqueue<T>(work: () => Promise<T>) {
  const job = queue.then(work)
  queue = job.catch(() => undefined)
  return job
}

async function draw(spec: Scene, palette: ScenePalette, view: SceneView, width: number, height: number, withLabels: boolean) {
  const g = await (gpu ??= initGpu())
  if (!g) throw new Error("3D needs WebGPU (bun-webgpu), which is not available here")
  const key = createHash("sha1").update(JSON.stringify(spec)).update(palette.accent).digest("hex")
  const b = await (built.get(key) ?? built.set(key, build(g, spec, palette)).get(key)!)
  const THREE = g.THREE

  // Explode and focus are applied to the cached meshes for this frame.
  b.parts.forEach(({ part, meshes, base }) =>
    meshes.forEach((mesh, i) => {
      mesh.position.set(
        base[i].x + part.explode[0] * view.explode,
        base[i].y + part.explode[1] * view.explode,
        base[i].z + part.explode[2] * view.explode,
      )
      const material = mesh.material as InstanceType<Three["MeshStandardMaterial"]>
      const focused = view.focus === part.id
      // The focused part glows in its own colour (copper stays copper); the accent is kept for
      // its callout.
      material.emissive.copy(focused ? material.color : new THREE.Color(0x000000))
      material.emissiveIntensity = focused ? 0.35 : 0
      const dim = !!view.focus && !focused
      material.transparent = dim || (MATERIALS[part.material]?.opacity ?? 1) < 1
      material.opacity = dim ? 0.18 : (MATERIALS[part.material]?.opacity ?? 1)
      material.depthWrite = !dim
    }),
  )

  if (g.canvas.width !== width || g.canvas.height !== height) {
    g.canvas.width = width
    g.canvas.height = height
    g.context.setSize(width, height)
    g.renderer.setSize(width, height, false)
  }
  // Frame the object as it is now (exploded parts take much more room than assembled ones).
  b.scene.updateMatrixWorld(true)
  const bounds = new THREE.Box3()
  b.parts.forEach(({ meshes }) => meshes.forEach((mesh) => bounds.expandByObject(mesh)))
  const center = bounds.getCenter(new THREE.Vector3())
  const extent3 = bounds.getSize(new THREE.Vector3())
  const radius = Math.max(0.5, extent3.length() / 2)
  // Soft contact shadow just under the lowest part, fading as the object comes apart.
  b.shadow.position.set(center.x, bounds.min.y - 0.02, center.z)
  b.shadow.scale.set(extent3.x * 1.25, extent3.z * 1.6, 1)
  ;(b.shadow.material as InstanceType<Three["MeshBasicMaterial"]>).opacity = 0.5 * (1 - 0.55 * view.explode)
  const c = view.camera
  const distance = radius * 3.2
  const yaw = (c.yaw * Math.PI) / 180
  const pitch = (Math.max(-80, Math.min(80, c.pitch)) * Math.PI) / 180
  const eye = new THREE.Vector3(
    center.x + Math.cos(pitch) * Math.sin(yaw) * distance,
    center.y + Math.sin(pitch) * distance,
    center.z + Math.cos(pitch) * Math.cos(yaw) * distance,
  )
  const aspect = width / height
  // Leave room at the sides for the label columns.
  const extent = (radius * (view.labels ? 1.08 : 1)) / c.zoom
  const camera = c.perspective
    ? new THREE.PerspectiveCamera(38 / c.zoom, aspect, 0.01, distance * 10)
    : new THREE.OrthographicCamera(-extent * aspect, extent * aspect, extent, -extent, 0.01, distance * 10)
  camera.position.copy(eye)
  camera.lookAt(center)
  camera.updateMatrixWorld()
  await g.renderer.renderAsync(b.scene, camera)
  const blueprint = spec.style === "blueprint"
  const pixels = await readback(g, width, height)
  const rgba = blueprint ? composite(pixels, background(width, height)) : pixels
  if (!withLabels) return { rgba, width, height }

  // Labels: projected part centres, pushed outward from the middle, with a leader line.
  const labels = view.labels && withLabels
    ? b.parts.flatMap(({ part, meshes }) => {
        if (!part.label || (view.focus && view.focus !== part.id)) return []
        const centre = meshes
          .reduce((sum, m) => sum.add(m.position), new THREE.Vector3())
          .divideScalar(meshes.length)
          .project(camera)
        const home = meshes
          .reduce((sum, m) => sum.add(m.position), new THREE.Vector3())
          .divideScalar(meshes.length)
          .sub(new THREE.Vector3(part.explode[0], part.explode[1], part.explode[2]).multiplyScalar(view.explode))
          .project(camera)
        const moved = Math.hypot(...part.explode) * view.explode > 0.3
        return [
          {
            x: ((centre.x + 1) / 2) * width,
            y: ((1 - centre.y) / 2) * height,
            hx: ((home.x + 1) / 2) * width,
            hy: ((1 - home.y) / 2) * height,
            moved,
            text: blueprint ? part.label.toUpperCase() : part.label,
            focused: view.focus === part.id,
          },
        ]
      })
    : []
  const font = Math.max(11, Math.round(height / 42))
  const ink = blueprint ? "#e6f0ff" : palette.text
  const guideColor = blueprint ? "rgba(214,232,255,0.45)" : palette.line
  // Dashed guides from where each part sits in the assembly to where it floats when exploded.
  const guides = labels
    .filter((l) => l.moved)
    .map((l) => `<line x1="${l.hx.toFixed(1)}" y1="${l.hy.toFixed(1)}" x2="${l.x.toFixed(1)}" y2="${l.y.toFixed(1)}" stroke="${guideColor}" stroke-width="1" stroke-dasharray="4 4"/>`)
    .join("")
  const marks = blueprint ? blueprintMarks(width, height, spec.title ?? "Assembly") : ""
  const overlay = marks + guides + columns(labels, width, height, font)
    .map((l) => {
      const anchor = l.lx < l.x ? "end" : "start"
      const color = l.focused ? palette.accent : ink
      const elbow = l.lx + (anchor === "end" ? 14 : -14)
      return `<polyline points="${l.x.toFixed(1)},${l.y.toFixed(1)} ${elbow.toFixed(1)},${l.ly.toFixed(1)} ${l.lx.toFixed(1)},${l.ly.toFixed(1)}" fill="none" stroke="${blueprint ? "rgba(230,240,255,0.75)" : palette.line}" stroke-width="1"/><circle cx="${l.x.toFixed(1)}" cy="${l.y.toFixed(1)}" r="2.5" fill="${color}"/><text x="${(l.lx + (anchor === "end" ? -4 : 4)).toFixed(1)}" y="${(l.ly + font / 3).toFixed(1)}" fill="${color}" font-family="JetBrains Mono" font-size="${font}" text-anchor="${anchor}" paint-order="stroke" stroke="#000" stroke-opacity="0.35" stroke-width="3">${escape(l.text)}</text>`
    })
    .join("")
  const png = encodePng(width, height, rgba)
  return {
    rgba,
    width,
    height,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><image width="${width}" height="${height}" xlink:href="data:image/png;base64,${png.toString("base64")}"/>${overlay}</svg>`,
  }
}

// Places labels in a left and a right column beside the object (by which side their part is
// on), sorted top to bottom and pushed apart so they never overlap.
function columns<T extends { x: number; y: number; text: string; focused: boolean }>(labels: T[], width: number, height: number, font: number) {
  const gap = font * 1.6
  const middle = labels.reduce((sum, l) => sum + l.x, 0) / Math.max(1, labels.length)
  return [labels.filter((l) => l.x < middle), labels.filter((l) => l.x >= middle)].flatMap((column, side) => {
    if (column.length === 0) return []
    const longest = Math.max(...column.map((l) => l.text.length)) * font * 0.62
    const edge = side === 0 ? Math.min(...column.map((l) => l.x)) - width * 0.06 : Math.max(...column.map((l) => l.x)) + width * 0.06
    const lx = side === 0 ? Math.max(longest + 8, edge) : Math.min(width - longest - 8, edge)
    const sorted = [...column].sort((a, b) => a.y - b.y)
    const ys = sorted.reduce<number[]>((acc, l) => [...acc, Math.max(l.y, (acc.at(-1) ?? -Infinity) + gap)], [])
    const overflow = Math.max(0, (ys.at(-1) ?? 0) - (height - gap))
    return sorted.map((l, i) => ({ ...l, lx, ly: Math.max(gap, ys[i] - overflow) }))
  })
}

const backgrounds = new Map<string, Buffer>()

function background(width: number, height: number) {
  const key = `${width}x${height}`
  return backgrounds.get(key) ?? backgrounds.set(key, blueprintBackground(width, height)).get(key)!
}

async function build(g: Gpu, spec: Scene, palette: ScenePalette): Promise<BuiltScene> {
  const THREE = g.THREE
  const scene = new THREE.Scene()
  // Studio environment for reflections, a soft key light, a cool fill and a faint accent rim.
  scene.environment = g.environment
  scene.environmentIntensity = 0.9
  scene.add(new THREE.HemisphereLight(0xffffff, 0x1a2233, 0.35))
  const key = new THREE.DirectionalLight(0xffffff, 1.7)
  key.position.set(5, 9, 6)
  scene.add(key)
  const rim = new THREE.DirectionalLight(palette.accent, 0.45)
  rim.position.set(-6, 3, -5)
  scene.add(rim)
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: shadowTexture(THREE), transparent: true, depthWrite: false, opacity: 0.5, color: 0x000000 }),
  )
  shadow.rotation.x = -Math.PI / 2
  scene.add(shadow)
  const parts = await Promise.all(spec.parts.map(async (part) => {
    if (part.kind) {
      // Components: many meshes per part, sharing one material per material key (focus and
      // dimming work per part).
      const materials = new Map<string, InstanceType<Three["MeshStandardMaterial"]>>()
      const material = (name: string) => {
        const look = MATERIALS[name] ?? MATERIALS.plastic
        return materials.get(name) ?? materials.set(name, new THREE.MeshStandardMaterial({ color: name === "accent" ? palette.accent : look.color, metalness: name === "accent" ? 0.3 : look.metalness, roughness: name === "accent" ? 0.35 : look.roughness })).get(name)!
      }
      const list = await pieces(THREE, part)
      const count = part.repeat?.count ?? 1
      const step = part.repeat?.step ?? [0, 0, 0]
      const placed = Array.from({ length: count }, (_, i) => list.map((piece) => ({ piece, offset: [step[0] * i, step[1] * i, step[2] * i] }))).flat()
      const meshes = placed.map(({ piece, offset }) => {
        const mesh = new THREE.Mesh(piece.geometry as InstanceType<Three["BoxGeometry"]>, material(piece.material))
        mesh.position.set(part.at[0] + offset[0] + piece.at[0], part.at[1] + offset[1] + piece.at[1], part.at[2] + offset[2] + piece.at[2])
        scene.add(mesh)
        return mesh
      })
      return { part, meshes, base: meshes.map((m) => m.position.clone()) }
    }
    return plainPart(THREE, scene, part, palette)
  }))
  const box = new THREE.Box3()
  parts.forEach(({ meshes }) => meshes.forEach((m) => box.expandByObject(m)))
  const center = box.getCenter(new THREE.Vector3())
  const radius = Math.max(0.5, box.getSize(new THREE.Vector3()).length() / 2)
  return { scene, shadow, parts, radius, center }
}

// A radial gradient used as a soft contact shadow.
function shadowTexture(THREE: Three) {
  const size = 64
  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const d = Math.min(1, Math.hypot(x / (size - 1) - 0.5, y / (size - 1) - 0.5) * 2)
      const i = (y * size + x) * 4
      data[i + 3] = Math.round(255 * (1 - d) ** 2.2)
    }
  const texture = new THREE.DataTexture(data, size, size)
  texture.needsUpdate = true
  return texture
}

function plainPart(THREE: Three, scene: InstanceType<Three["Scene"]>, part: Part, palette: ScenePalette) {
  const look = MATERIALS[part.material] ?? (/^#[0-9a-f]{6}$/i.test(part.material) ? undefined : MATERIALS.plastic)
  const color = look?.color ?? (part.material === "accent" ? palette.accent : part.material)
  const geometry = shapeGeometry(THREE, part)
  const count = part.repeat?.count ?? 1
  const base = Array.from({ length: count }, (_, i) => {
    const step = part.repeat?.step ?? [0, 0, 0]
    return new THREE.Vector3(part.at[0] + step[0] * i, part.at[1] + step[1] * i, part.at[2] + step[2] * i)
  })
  const meshes = base.map((position) => {
    const material = new THREE.MeshStandardMaterial({
      color: part.material === "accent" ? palette.accent : color,
      metalness: look?.metalness ?? 0.3,
      roughness: look?.roughness ?? 0.5,
    })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.copy(position)
    mesh.rotation.set(...(part.rotate.map((d) => (d * Math.PI) / 180) as [number, number, number]))
    scene.add(mesh)
    return mesh
  })
  return { part, meshes, base }
}

function shapeGeometry(THREE: Three, part: Part) {
  const [a, b, c] = part.size
  if (part.shape === "cylinder") return new THREE.CylinderGeometry(a, a, b, 48)
  if (part.shape === "cone") return new THREE.ConeGeometry(a, b, 48)
  if (part.shape === "sphere") return new THREE.SphereGeometry(a, 40, 24)
  if (part.shape === "torus") return new THREE.TorusGeometry(a, Math.min(b, a), 24, 64)
  if (part.shape === "capsule") return new THREE.CapsuleGeometry(a, b, 8, 24)
  return new THREE.BoxGeometry(a, b, c)
}

async function readback(g: Gpu, width: number, height: number) {
  const texture = g.context.getCurrentTexture()
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256
  const buffer = g.device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
  const encoder = g.device.createCommandEncoder()
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: height }, { width, height })
  g.device.queue.submit([encoder.finish()])
  await buffer.mapAsync(GPUMapMode.READ)
  const data = new Uint8Array(buffer.getMappedRange())
  const bgra = texture.format === "bgra8unorm"
  // Tightly packed RGBA (rows padded to 256 bytes on the GPU side).
  const rgba = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = y * bytesPerRow + x * 4
      const d = (y * width + x) * 4
      rgba[d] = data[s + (bgra ? 2 : 0)]
      rgba[d + 1] = data[s + 1]
      rgba[d + 2] = data[s + (bgra ? 0 : 2)]
      rgba[d + 3] = data[s + 3]
    }
  }
  buffer.unmap()
  buffer.destroy()
  return rgba
}

// Minimal PNG encoder: RGBA, filter 0 on every row. Level 1 is used for moving frames.
export function encodePng(width: number, height: number, rgba: Buffer, level = 3) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level })),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

const CRC = Array.from({ length: 256 }, (_, n) =>
  Array.from({ length: 8 }).reduce<number>((c) => (c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1), n),
)

function chunk(type: string, body: Buffer) {
  const typed = Buffer.concat([Buffer.from(type), body])
  const crc = (typed.reduce((c, v) => CRC[(c ^ v) & 255] ^ (c >>> 8), 0xffffffff) ^ 0xffffffff) >>> 0
  const out = Buffer.alloc(8 + body.length + 4)
  out.writeUInt32BE(body.length, 0)
  typed.copy(out, 4)
  out.writeUInt32BE(crc, 8 + body.length)
  return out
}

function escape(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}
