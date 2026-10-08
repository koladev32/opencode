import type { BoxRenderable } from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { onCleanup, onMount } from "solid-js"
import { useTheme } from "../context/theme"
import { useBindings } from "../keymap"
import { ExpandedDiagram, type LiveDiagram } from "./diagram"

// Full-window diagram view. It lives in the dialog stack (so the prompt loses focus and Esc
// closes it) but breaks out of the dialog's centred panel: the box is positioned back to the
// window's top-left corner, using the panel geometry from ui/dialog.tsx (medium width 60,
// top padding height/4 plus 1).
export function DialogDiagram(props: { diagram: LiveDiagram }) {
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const width = dimensions().width
  const height = dimensions().height
  let host: BoxRenderable | undefined

  onMount(() => {
    const view = new ExpandedDiagram(renderer, props.diagram, width, height)
    host?.add(view)
    onCleanup(() => view.destroyRecursively())
  })

  const d = props.diagram
  useBindings(() => ({
    bindings: d.interactive
      ? [
          { key: "left", desc: "Rotate left", group: "Diagram", cmd: () => d.orbit(-6, 0) },
          { key: "right", desc: "Rotate right", group: "Diagram", cmd: () => d.orbit(6, 0) },
          { key: "up", desc: "Tilt up", group: "Diagram", cmd: () => d.orbit(0, 4) },
          { key: "down", desc: "Tilt down", group: "Diagram", cmd: () => d.orbit(0, -4) },
          { key: "=", desc: "Zoom in", group: "Diagram", cmd: () => d.zoomBy(1.15) },
          { key: "-", desc: "Zoom out", group: "Diagram", cmd: () => d.zoomBy(1 / 1.15) },
          { key: "e", desc: "Explode or assemble", group: "Diagram", cmd: () => d.toggleExplode() },
          { key: "[", desc: "Previous part", group: "Diagram", cmd: () => d.go(-1) },
          { key: "]", desc: "Next part", group: "Diagram", cmd: () => d.go(1) },
          { key: "r", desc: "Reset view", group: "Diagram", cmd: () => d.resetView() },
          { key: "space", desc: "Play or pause", group: "Diagram", cmd: () => d.toggle() },
        ]
      : [
          { key: "left", desc: "Previous diagram step", group: "Diagram", cmd: () => d.go(-1) },
          { key: "right", desc: "Next diagram step", group: "Diagram", cmd: () => d.go(1) },
          { key: "space", desc: "Pause or play diagram", group: "Diagram", cmd: () => d.toggle() },
        ],
  }))

  return (
    <box
      ref={(el: BoxRenderable) => (host = el)}
      position="absolute"
      left={-Math.floor((width - Math.min(60, width - 2)) / 2)}
      top={-(height / 4) - 1}
      width={width}
      height={height}
      backgroundColor={theme.background}
    />
  )
}
