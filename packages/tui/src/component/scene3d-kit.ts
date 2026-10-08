// Components, presets and styles for 3D scenes (see scene3d.ts). Components turn one scene part
// into many meshes (a fan into hub, ring and pitched blades), so models can ask for `kind: fan`
// instead of improvising from cylinders. Presets assemble whole objects from components with
// named parts, explode offsets and default steps.

import type { Part } from "./scene3d"

type Three = typeof import("three/webgpu")
type Geometry = InstanceType<Three["BufferGeometry"]> & { clone(): Geometry }

// One mesh of a part: geometry in part-local space, a material key, and an offset.
export type Piece = { geometry: Geometry; material: string; at: [number, number, number]; shadow?: boolean }

export const KIT_MATERIALS: Record<string, { color: number; metalness: number; roughness: number }> = {
  pcb: { color: 0x15402b, metalness: 0.15, roughness: 0.42 },
  substrate: { color: 0x2b4d36, metalness: 0.2, roughness: 0.45 },
  silicon: { color: 0x1c2029, metalness: 0.75, roughness: 0.18 },
  chip: { color: 0x17191e, metalness: 0.25, roughness: 0.45 },
  choke: { color: 0x3b3f46, metalness: 0.65, roughness: 0.38 },
  cap: { color: 0xa9b1ba, metalness: 0.95, roughness: 0.22 },
  gold: { color: 0xe0b44c, metalness: 1, roughness: 0.22 },
  copper: { color: 0xc8743f, metalness: 1, roughness: 0.26 },
  aluminium: { color: 0xd9dde2, metalness: 1, roughness: 0.32 },
  shroud: { color: 0xb8bec7, metalness: 0.95, roughness: 0.28 },
  backplate: { color: 0x2a2e35, metalness: 0.85, roughness: 0.38 },
  bracket: { color: 0xc5cad1, metalness: 1, roughness: 0.3 },
  fan: { color: 0x121418, metalness: 0.15, roughness: 0.3 },
  connector: { color: 0x0e0f11, metalness: 0.2, roughness: 0.55 },
}

export const COMPONENTS = new Set(["fan", "fans", "fins", "heatpipes", "gpu-die", "vram", "vrm", "pcb", "pcie", "shroud", "bracket", "backplate", "power", "cold-plate", "chip"])

// ---- GPU preset ---------------------------------------------------------------------------------

const L = 10.4 // card length (x)
const W = 4.2 // card width (z)

export function gpuPreset(options: Record<string, unknown>) {
  const fans = Math.max(1, Math.min(3, Math.round(Number(options.fans) || 3)))
  const part = (id: string, label: string | undefined, kind: string, at: number[], explode: number[], extra: Partial<Part> = {}): Part => ({
    id,
    label,
    kind,
    shape: "box",
    size: [1, 1, 1],
    at,
    rotate: [0, 0, 0],
    material: "plastic",
    explode,
    options: { fans },
    ...extra,
  })
  const parts: Part[] = [
    part("backplate", "Backplate", "backplate", [0, -0.17, 0], [0, -1.9, 0]),
    part("pcb", "PCB", "pcb", [0, 0, 0], [0, 0, 0]),
    part("pcie", "PCIe x16 fingers", "pcie", [-L * 0.1, 0, W / 2 - 0.2], [0, -0.55, 0.9]),
    part("vrm", "VRM power stages", "vrm", [-L * 0.3, 0.06, -0.15], [0, 0.75, 0]),
    part("power", "Power connector", "power", [L * 0.4, 0.06, -W / 2 + 0.42], [0.5, 0.75, -0.4]),
    part("vram", "GDDR memory", "vram", [L * 0.04, 0.06, 0], [0, 0.95, 0]),
    part("die", "GPU die", "gpu-die", [L * 0.04, 0.06, 0], [0, 1.45, 0]),
    part("coldplate", "Copper cold plate", "cold-plate", [L * 0.04, 0.36, 0], [0, 2.35, 0]),
    part("heatpipes", "Heatpipes", "heatpipes", [L * 0.04, 0, 0], [0, 3.0, 0]),
    part("fins", "Fin stack", "fins", [0, 1.1, 0], [0, 3.9, 0]),
    part("shroud", "Shroud", "shroud", [0, 1.62, 0], [0, 5.05, 0]),
    part("fans", fans === 1 ? "Fan" : `${fans} fans`, "fans", [0, 1.78, 0], [0, 6.7, 0]),
    part("bracket", "I/O bracket", "bracket", [-L / 2 - 0.06, 0.48, 0], [-2.2, 0, 0]),
  ]
  const steps = [
    { part: "pcb", caption: "Everything mounts on a multi-layer PCB" },
    { part: "die", caption: "The GPU die: thousands of cores working in parallel" },
    { part: "vram", caption: "GDDR memory surrounds the die to feed it data" },
    { part: "vrm", caption: "The VRM turns 12 V into clean, low-voltage power" },
    { part: "coldplate", caption: "A copper cold plate pulls heat off the die" },
    { part: "heatpipes", caption: "Heatpipes carry that heat out along the card" },
    { part: "fins", caption: "The fin stack spreads it into the air" },
    { part: "fans", caption: "Fans push air through the fins" },
    { part: "bracket", caption: "The bracket holds the display outputs" },
    { part: "pcie", caption: "PCIe fingers connect the card to the motherboard" },
  ]
  return { title: "Graphics card", parts, steps }
}

// ---- Components ---------------------------------------------------------------------------------

export async function pieces(THREE: Three, part: Part): Promise<Piece[]> {
  const { RoundedBoxGeometry } = await import("three/examples/jsm/geometries/RoundedBoxGeometry.js")
  const box = (w: number, h: number, d: number, r = 0.03) =>
    new RoundedBoxGeometry(w, h, d, 3, Math.min(r, w / 2.2, h / 2.2, d / 2.2)) as unknown as Geometry
  const fans = Number(part.options?.fans) || 3
  const fanCenters = Array.from({ length: fans }, (_, i) => (i - (fans - 1) / 2) * (L / 3.15))
  const rng = seeded(part.id)

  if (part.kind === "pcb") {
    const smd = Array.from({ length: 70 }, () => {
      // Small parts scattered away from the die and memory, so the board reads as populated.
      const x = (rng() - 0.5) * (L - 0.6)
      const z = (rng() - 0.5) * (W - 0.6)
      if (Math.abs(x - L * 0.04) < 2.3 && Math.abs(z) < 2.0) return undefined
      const cap = rng() < 0.35
      return cap
        ? { geometry: new THREE.CylinderGeometry(0.06, 0.06, 0.14, 16), material: "cap", at: [x, 0.13, z] as [number, number, number] }
        : { geometry: box(0.12 + rng() * 0.18, 0.04, 0.08 + rng() * 0.1, 0.01), material: "chip", at: [x, 0.08, z] as [number, number, number] }
    }).filter((p): p is Piece => !!p)
    return [{ geometry: box(L, 0.12, W, 0.05), material: "pcb", at: [0, 0, 0] }, ...smd]
  }
  if (part.kind === "pcie") {
    return Array.from({ length: 38 }, (_, i) => ({
      geometry: box(0.1, 0.02, 0.34, 0.008),
      material: "gold",
      at: [(i - 18.5) * 0.15, 0.065, 0] as [number, number, number],
    }))
  }
  if (part.kind === "gpu-die") {
    const caps = Array.from({ length: 12 }, (_, i) => {
      const a = (i / 12) * Math.PI * 2
      return { geometry: box(0.08, 0.04, 0.05, 0.01), material: "gold", at: [Math.cos(a) * 0.82, 0.1, Math.sin(a) * 0.82] as [number, number, number] }
    })
    return [
      { geometry: box(2.0, 0.08, 2.0, 0.05), material: "substrate", at: [0, 0.04, 0] },
      { geometry: box(1.2, 0.07, 1.2, 0.02), material: "silicon", at: [0, 0.11, 0] },
      ...caps,
    ]
  }
  if (part.kind === "vram") {
    const spots: [number, number, number][] = [
      ...[-1.05, 0, 1.05].map((z) => [-1.55, 0.04, z] as [number, number, number]),
      ...[-1.05, 0, 1.05].map((z) => [1.55, 0.04, z] as [number, number, number]),
      ...[-0.55, 0.55].map((x) => [x, 0.04, -1.55] as [number, number, number]),
      ...[-0.55, 0.55].map((x) => [x, 0.04, 1.55] as [number, number, number]),
    ]
    return spots.map((at, i) => ({ geometry: i < 6 ? box(0.5, 0.07, 0.68, 0.02) : box(0.68, 0.07, 0.5, 0.02), material: "chip", at }))
  }
  if (part.kind === "vrm") {
    const chokes = Array.from({ length: 14 }, (_, i) => ({
      geometry: box(0.3, 0.26, 0.3, 0.04),
      material: "choke",
      at: [(i % 7) * 0.4 - 1.2, 0.13, Math.floor(i / 7) * 0.42 - 0.9] as [number, number, number],
    }))
    const stages = Array.from({ length: 7 }, (_, i) => ({ geometry: box(0.24, 0.05, 0.2, 0.01), material: "chip", at: [i * 0.4 - 1.2, 0.03, 0.12] as [number, number, number] }))
    const caps = Array.from({ length: 10 }, (_, i) => ({
      geometry: new THREE.CylinderGeometry(0.1, 0.1, 0.32, 20),
      material: "cap",
      at: [i * 0.3 - 1.35, 0.16, 0.62] as [number, number, number],
    }))
    return [...chokes, ...stages, ...caps]
  }
  if (part.kind === "power") {
    const pins = Array.from({ length: 6 }, (_, i) => ({ geometry: box(0.1, 0.06, 0.1, 0.01), material: "gold", at: [(i - 2.5) * 0.17, 0.38, 0] as [number, number, number] }))
    return [{ geometry: box(1.15, 0.34, 0.5, 0.04), material: "connector", at: [0, 0.17, 0] }, ...pins]
  }
  if (part.kind === "cold-plate") return [{ geometry: box(2.2, 0.12, 2.2, 0.04), material: "copper", at: [0, 0, 0] }]
  if (part.kind === "chip") return [{ geometry: box(part.size[0], part.size[1], part.size[2], 0.03), material: part.material === "plastic" ? "chip" : part.material, at: [0, 0, 0] }]
  if (part.kind === "heatpipes") {
    return [-1.05, -0.35, 0.35, 1.05].map((z, i) => {
      const reach = i % 2 === 0 ? L * 0.46 : L * 0.4
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(-reach, 0.8, z),
        new THREE.Vector3(-1.6, 0.66, z),
        new THREE.Vector3(-0.7, 0.44, z),
        new THREE.Vector3(0.7, 0.44, z),
        new THREE.Vector3(1.6, 0.66, z),
        new THREE.Vector3(reach * 0.92, 0.8, z),
      ])
      return { geometry: new THREE.TubeGeometry(curve, 80, 0.085, 14, false) as unknown as Geometry, material: "copper", at: [0, 0, 0] as [number, number, number] }
    })
  }
  if (part.kind === "fins") {
    return Array.from({ length: 52 }, (_, i) => ({
      geometry: box(0.035, 0.7, W * 0.9, 0.012),
      material: "aluminium",
      at: [-L * 0.47 + i * ((L * 0.94) / 51), 0, 0] as [number, number, number],
    }))
  }
  if (part.kind === "shroud") {
    const top = roundedRect(THREE, L, W, 0.35)
    fanCenters.forEach((x) => {
      const hole = new THREE.Path()
      hole.absarc(x, 0, 1.43, 0, Math.PI * 2, true)
      top.holes.push(hole)
    })
    const plate = new THREE.ExtrudeGeometry(top, { depth: 0.1, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 3, curveSegments: 48 })
    plate.rotateX(-Math.PI / 2)
    const skirt = (z: number) => ({ geometry: box(L - 0.2, 0.5, 0.08, 0.03), material: "shroud", at: [0, -0.28, z] as [number, number, number] })
    return [
      { geometry: plate as unknown as Geometry, material: "shroud", at: [0, 0, 0] },
      skirt(W / 2 - 0.05),
      skirt(-W / 2 + 0.05),
      { geometry: box(0.08, 0.5, W - 0.2, 0.03), material: "shroud", at: [L / 2 - 0.05, -0.28, 0] },
      // A single thin accent line along the top edge, in the theme's accent colour.
      { geometry: box(L * 0.58, 0.03, 0.06, 0.012), material: "accent", at: [L * 0.12, 0.15, W / 2 - 0.22] },
    ]
  }
  if (part.kind === "fans" || part.kind === "fan") {
    const centers = part.kind === "fan" ? [0] : fanCenters
    const radius = part.kind === "fan" ? Math.max(0.4, part.size[0]) / 1.45 : 1
    const blade = bladeGeometry(THREE)
    return centers.flatMap((x) => [
      { geometry: torus(THREE, 1.42 * radius, 0.05 * radius), material: "fan", at: [x, 0, 0] as [number, number, number] },
      { geometry: new THREE.CylinderGeometry(0.42 * radius, 0.44 * radius, 0.16, 48), material: "fan", at: [x, 0.02, 0] as [number, number, number] },
      { geometry: new THREE.CylinderGeometry(0.25 * radius, 0.25 * radius, 0.02, 48), material: "accent", at: [x, 0.11, 0] as [number, number, number] },
      ...Array.from({ length: 11 }, (_, i) => {
        const g = blade.clone()
        g.scale(radius, 1, radius)
        g.rotateY((i / 11) * Math.PI * 2)
        return { geometry: g, material: "fan", at: [x, 0.02, 0] as [number, number, number] }
      }),
    ])
  }
  if (part.kind === "bracket") {
    const plate = roundedRect(THREE, W + 0.3, 2.1, 0.08)
    // Vent slots in the upper half, display port openings below.
    for (let c = 0; c < 4; c++)
      for (let r = 0; r < 4; r++) plate.holes.push(rectPath(THREE, -1.5 + c * 0.75, 0.2 + r * 0.2, 0.55, 0.09))
    const ports = [-1.45, -0.55, 0.35, 1.25]
    ports.forEach((z, i) => plate.holes.push(rectPath(THREE, z, -0.55, i === 3 ? 0.62 : 0.68, 0.3)))
    const g = new THREE.ExtrudeGeometry(plate, { depth: 0.05, bevelEnabled: false, curveSegments: 12 })
    g.rotateY(Math.PI / 2)
    const connectors = ports.map((z, i) => ({ geometry: box(0.5, 0.26, i === 3 ? 0.56 : 0.62, 0.02), material: "connector", at: [0.28, -0.55, -z] as [number, number, number] }))
    return [{ geometry: g as unknown as Geometry, material: "bracket", at: [0, 0, 0] }, ...connectors]
  }
  if (part.kind === "backplate") {
    const plate = roundedRect(THREE, L, W, 0.3)
    for (let c = 0; c < 14; c++)
      for (let r = 0; r < 3; r++) plate.holes.push(rectPath(THREE, -L * 0.42 + c * 0.42 + L * 0.2, -0.6 + r * 0.6, 0.3, 0.1))
    const g = new THREE.ExtrudeGeometry(plate, { depth: 0.05, bevelEnabled: true, bevelThickness: 0.015, bevelSize: 0.015, bevelSegments: 2 })
    g.rotateX(-Math.PI / 2)
    return [{ geometry: g as unknown as Geometry, material: "backplate", at: [0, 0, 0] }]
  }
  return []
}

// A swept fan blade: a curved 2D outline, extruded thin, laid flat and pitched.
function bladeGeometry(THREE: Three) {
  const s = new THREE.Shape()
  s.moveTo(0.44, -0.1)
  s.quadraticCurveTo(0.95, -0.34, 1.37, -0.16)
  s.quadraticCurveTo(1.42, 0.02, 1.34, 0.2)
  s.quadraticCurveTo(0.9, 0.3, 0.44, 0.12)
  s.closePath()
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.025, bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.008, bevelSegments: 1, curveSegments: 16 })
  g.rotateX(-Math.PI / 2 + 0.42)
  return g as unknown as Geometry
}

function torus(THREE: Three, radius: number, tube: number) {
  const g = new THREE.TorusGeometry(radius, tube, 16, 96)
  g.rotateX(Math.PI / 2)
  return g as unknown as Geometry
}

function roundedRect(THREE: Three, w: number, h: number, r: number) {
  const s = new THREE.Shape()
  s.moveTo(-w / 2 + r, -h / 2)
  s.lineTo(w / 2 - r, -h / 2)
  s.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r)
  s.lineTo(w / 2, h / 2 - r)
  s.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2)
  s.lineTo(-w / 2 + r, h / 2)
  s.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r)
  s.lineTo(-w / 2, -h / 2 + r)
  s.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2)
  return s
}

// A rounded slot, drawn clockwise so it cuts a hole.
function rectPath(THREE: Three, cx: number, cy: number, w: number, h: number) {
  const r = Math.min(w, h) / 2
  const p = new THREE.Path()
  p.moveTo(cx - w / 2 + r, cy - h / 2)
  p.lineTo(cx - w / 2, cy - h / 2 + r)
  p.lineTo(cx - w / 2, cy + h / 2 - r)
  p.lineTo(cx - w / 2 + r, cy + h / 2)
  p.lineTo(cx + w / 2 - r, cy + h / 2)
  p.lineTo(cx + w / 2, cy + h / 2 - r)
  p.lineTo(cx + w / 2, cy - h / 2 + r)
  p.lineTo(cx + w / 2 - r, cy - h / 2)
  p.closePath()
  return p
}

// Deterministic pseudo-random numbers, so a scene renders the same every time.
function seeded(seed: string) {
  let h = [...seed].reduce((a, c) => Math.imul(a ^ c.charCodeAt(0), 2654435761) >>> 0, 2166136261)
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0
    h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0
    return ((h ^= h >>> 16) >>> 0) / 4294967296
  }
}

// ---- Blueprint style ----------------------------------------------------------------------------

// Background pixels (RGBA) for the blueprint style: deep blue gradient, fine and major grid,
// soft vignette. Drawn in code so moving frames and still frames match exactly.
export function blueprintBackground(width: number, height: number) {
  const out = Buffer.alloc(width * height * 4)
  const minor = Math.max(10, Math.round(height / 34))
  const major = minor * 5
  for (let y = 0; y < height; y++) {
    const t = y / height
    const [r0, g0, b0] = [12 + 4 * t, 38 + 10 * t, 70 + 18 * t]
    for (let x = 0; x < width; x++) {
      const dx = x / width - 0.5
      const dy = t - 0.5
      const vignette = 1 - Math.min(0.45, (dx * dx + dy * dy) * 1.1)
      const line = x % major === 0 || y % major === 0 ? 0.13 : x % minor === 0 || y % minor === 0 ? 0.05 : 0
      const i = (y * width + x) * 4
      out[i] = Math.min(255, r0 * vignette + 255 * line * 0.6)
      out[i + 1] = Math.min(255, g0 * vignette + 255 * line * 0.75)
      out[i + 2] = Math.min(255, b0 * vignette + 255 * line)
      out[i + 3] = 255
    }
  }
  return out
}

// Alpha-composites the rendered object over a background (both RGBA, same size).
export function composite(front: Buffer, back: Buffer) {
  const out = Buffer.alloc(front.length)
  for (let i = 0; i < front.length; i += 4) {
    const a = front[i + 3] / 255
    out[i] = front[i] * a + back[i] * (1 - a)
    out[i + 1] = front[i + 1] * a + back[i + 1] * (1 - a)
    out[i + 2] = front[i + 2] * a + back[i + 2] * (1 - a)
    out[i + 3] = 255
  }
  return out
}

// Decorative drawing marks for the blueprint style: corner ticks, a title block, a dimension line.
export function blueprintMarks(width: number, height: number, title: string) {
  const ink = "rgba(220,235,255,0.55)"
  const faint = "rgba(220,235,255,0.25)"
  const m = Math.round(height * 0.035)
  const font = Math.max(10, Math.round(height / 52))
  const corner = (x: number, y: number, dx: number, dy: number) =>
    `<path d="M${x} ${y + dy * m}V${y}H${x + dx * m}" fill="none" stroke="${ink}" stroke-width="1.2"/>`
  const block = `<g font-family="JetBrains Mono" fill="${ink}"><rect x="${width - m - font * 17}" y="${height - m - font * 3.2}" width="${font * 17}" height="${font * 3.2}" fill="none" stroke="${faint}"/><text x="${width - m - font * 16.4}" y="${height - m - font * 1.9}" font-size="${font}" letter-spacing="1">${escapeXml(title.toUpperCase().slice(0, 22))}</text><text x="${width - m - font * 16.4}" y="${height - m - font * 0.7}" font-size="${Math.round(font * 0.8)}" fill="${faint}">EXPLODED VIEW · REV A</text></g>`
  const dim = `<g stroke="${faint}" stroke-width="1"><path d="M${m * 1.5} ${height - m * 1.6}H${m * 1.5 + width * 0.18}"/><path d="M${m * 1.5} ${height - m * 1.9}v${m * 0.6}M${m * 1.5 + width * 0.18} ${height - m * 1.9}v${m * 0.6}"/></g><text x="${m * 1.5 + width * 0.09}" y="${height - m * 2}" fill="${faint}" font-family="JetBrains Mono" font-size="${Math.round(font * 0.8)}" text-anchor="middle">267 mm</text>`
  return corner(m, m, 1, 1) + corner(width - m, m, -1, 1) + corner(m, height - m, 1, -1) + corner(width - m, height - m, -1, -1) + block + dim
}

function escapeXml(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}
