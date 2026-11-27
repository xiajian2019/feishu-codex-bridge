import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type RefObject } from "react";
import {
  anchoredZoomOffset, clampViewportOffset, matchDisplayRegions, viewportPlacement, viewportScale,
  type DesktopDisplay, type Point, type Rect, type Size,
} from "./remote-desktop-viewport.js";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 8;
const clampZoom = (value: number): number => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
const ZERO: Point = { x: 0, y: 0 };
type GestureDetail = { type?: string; clientX?: number; clientY?: number; magnitudeX?: number; magnitudeY?: number };
type GestureStart = { type: "pinch" | "drag"; zoom: number; distance: number; x: number; y: number; offset: Point };

export function useRemoteDesktopViewport(stageRef: RefObject<HTMLDivElement | null>, targetRef: RefObject<HTMLDivElement | null>,
  displays: DesktopDisplay[], active: boolean, connected: boolean) {
  const [stage, setStage] = useState<Size>({ width: 0, height: 0 });
  const [framebuffer, setFramebuffer] = useState<Size | null>(null);
  const [selection, setSelection] = useState("auto");
  const [zoom, setZoom] = useState(1);
  const [actualSize, setActualSize] = useState(false);
  const [pan, setPan] = useState(false);
  const [offset, setOffset] = useState<Point>(ZERO);
  const gesture = useRef<GestureStart | null>(null);
  const pointer = useRef<{ id: number; x: number; y: number; offset: Point } | null>(null);

  useEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const measure = (): void => {
      const next = { width: node.clientWidth, height: node.clientHeight };
      // A hidden route has no dimensions; keep the last useful viewport.
      if (next.width && next.height) setStage((current) => current.width === next.width && current.height === next.height ? current : next);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node); measure();
    return () => observer.disconnect();
  }, [stageRef]);

  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;
    const measure = (): void => {
      const canvas = target.querySelector("canvas");
      const next = canvas && canvas.width > 0 && canvas.height > 0 ? { width: canvas.width, height: canvas.height } : null;
      setFramebuffer((current) => current?.width === next?.width && current?.height === next?.height ? current : next);
    };
    const observer = new MutationObserver(measure);
    observer.observe(target, { subtree: true, childList: true, attributes: true, attributeFilter: ["width", "height"] });
    measure();
    return () => observer.disconnect();
  }, [targetRef]);

  const regions = useMemo(() => framebuffer ? matchDisplayRegions(displays, framebuffer) : null, [displays, framebuffer]);
  const automatic = regions?.find((item) => item.builtIn) ?? null;
  const selected = selection === "auto" ? automatic : regions?.find((item) => String(item.id) === selection) ?? null;
  const region: Rect | null = selected?.rect ?? (framebuffer ? { x: 0, y: 0, ...framebuffer } : null);
  const scale = region ? viewportScale(stage, region, actualSize, zoom) : 1;
  const placement = region && framebuffer && stage.width && stage.height
    ? viewportPlacement(stage, framebuffer, region, scale, offset) : null;
  const style: CSSProperties | undefined = placement ? {
    position: "absolute", left: placement.x, top: placement.y, width: placement.width, height: placement.height,
    clipPath: `inset(${region!.y * scale}px ${(framebuffer!.width - region!.x - region!.width) * scale}px ` +
      `${(framebuffer!.height - region!.y - region!.height) * scale}px ${region!.x * scale}px)`,
  } : undefined;
  const current = useRef({ stage, region, scale, zoom, offset, pan, actualSize, active, connected });
  current.current = { stage, region, scale, zoom, offset, pan, actualSize, active, connected };

  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;
    const handleGesture = (event: Event): void => {
      const detail = (event as CustomEvent<GestureDetail>).detail;
      const state = current.current;
      if (!state.active || !state.connected || !state.region || !detail?.type) return;
      const pinch = detail.type === "pinch";
      const drag = state.pan && (detail.type === "drag" || detail.type === "longpress");
      if (!pinch && !drag) return;
      // noVNC already recognizes touch gestures; intercept only local zoom/pan
      // so a pinch does not send Control+wheel to the remote application.
      event.stopImmediatePropagation();
      const stageRect = stageRef.current?.getBoundingClientRect();
      const x = (detail.clientX ?? 0) - (stageRect?.left ?? 0);
      const y = (detail.clientY ?? 0) - (stageRect?.top ?? 0);
      if (event.type === "gesturestart") {
        gesture.current = { type: pinch ? "pinch" : "drag", zoom: state.zoom,
          distance: Math.hypot(detail.magnitudeX ?? 0, detail.magnitudeY ?? 0), x, y,
          offset: clampViewportOffset(state.offset, state.stage, state.region, state.scale) };
      } else if (event.type === "gesturemove" && gesture.current) {
        const start = gesture.current;
        if (pinch && start.type === "pinch" && start.distance > 0) {
          const distance = Math.hypot(detail.magnitudeX ?? 0, detail.magnitudeY ?? 0);
          const nextZoom = clampZoom(start.zoom * distance / start.distance);
          const nextScale = viewportScale(state.stage, state.region, state.actualSize, nextZoom);
          const nextOffset = anchoredZoomOffset(state.stage, start.offset, { x: start.x, y: start.y }, nextZoom / start.zoom);
          setOffset(clampViewportOffset(nextOffset, state.stage, state.region, nextScale));
          setZoom(nextZoom);
        } else if (drag && start.type === "drag") {
          setOffset(clampViewportOffset({ x: start.offset.x + x - start.x, y: start.offset.y + y - start.y },
            state.stage, state.region, state.scale));
        }
      } else if (event.type === "gestureend") gesture.current = null;
    };
    target.addEventListener("gesturestart", handleGesture, true);
    target.addEventListener("gesturemove", handleGesture, true);
    target.addEventListener("gestureend", handleGesture, true);
    return () => {
      target.removeEventListener("gesturestart", handleGesture, true);
      target.removeEventListener("gesturemove", handleGesture, true);
      target.removeEventListener("gestureend", handleGesture, true);
    };
  }, [stageRef, targetRef]);

  const pointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    const state = current.current;
    if (!state.active || !state.connected || !state.pan || !state.region || event.pointerType !== "mouse" || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY,
      offset: clampViewportOffset(state.offset, state.stage, state.region, state.scale) };
  };
  const pointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const start = pointer.current;
    const state = current.current;
    if (!start || start.id !== event.pointerId || !state.region) return;
    event.preventDefault(); event.stopPropagation();
    setOffset(clampViewportOffset({ x: start.offset.x + event.clientX - start.x, y: start.offset.y + event.clientY - start.y },
      state.stage, state.region, state.scale));
  };
  const pointerEnd = (event: PointerEvent<HTMLDivElement>): void => {
    if (pointer.current?.id !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation(); pointer.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const selectDisplay = (value: string): void => { setSelection(value); setZoom(1); setOffset(ZERO); setActualSize(false); setPan(false); };
  const toggleActualSize = (): void => { setActualSize((value) => !value); setZoom(1); setOffset(ZERO); setPan(false); };
  const adjustZoom = (factor: number): void => { setZoom((value) => clampZoom(value * factor)); };
  const reset = (): void => { setZoom(1); setActualSize(false); setOffset(ZERO); setPan(false); };
  const selectedValue = selected ? String(selected.id) : "all";
  return { style, regions, layoutUnavailable: Boolean(framebuffer && displays.length > 1 && !regions),
    selectedValue, selectDisplay, zoom, actualSize, toggleActualSize, pan, setPan,
    adjustZoom, reset, pointerDown, pointerMove, pointerEnd };
}
