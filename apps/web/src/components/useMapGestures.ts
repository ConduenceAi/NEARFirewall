import { useLayoutEffect, useRef } from "react";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2;
const DRAG_THRESHOLD = 5;
const PINCH_ZOOM_SPEED = 0.01;

type Point = { x: number; y: number };

function pointOf(event: MouseEvent): Point {
  return { x: event.clientX, y: event.clientY };
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function distance(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function useMapGestures(hasCanvas: boolean) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const canvas = canvasRef.current;
    if (!hasCanvas || !viewport || !canvas) return;

    const pointers = new Map<number, Point>();
    let pointerType = "";
    let dragged = false;
    let zoom = Number(canvas.style.zoom) || 1;
    let controlPressed = false;
    let safariPinchZoom = zoom;

    const resetView = () => {
      canvas.style.zoom = "1";
      zoom = 1;
      // The stage leaves half a viewport of panning room on each side.
      viewport.scrollTo(viewport.clientWidth / 2, viewport.clientHeight / 2);
    };
    resetView();

    const moveView = (nextZoom: number, from: Point, to = from) => {
      const scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom));
      if (scale === zoom) {
        viewport.scrollBy(from.x - to.x, from.y - to.y);
        return;
      }

      const before = canvas.getBoundingClientRect();
      const ratio = scale / zoom;
      canvas.style.zoom = String(scale);
      zoom = scale;
      const after = canvas.getBoundingClientRect();
      viewport.scrollBy(after.left + (from.x - before.left) * ratio - to.x, after.top + (from.y - before.top) * ratio - to.y);
    };

    const startDrag = () => {
      dragged = true;
      viewport.dataset.grabbing = "";
      for (const id of pointers.keys()) viewport.setPointerCapture(id);
    };

    const pointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      if (pointers.size && (pointerType !== "touch" || event.pointerType !== "touch" || pointers.size === 2)) return;

      if (!pointers.size) {
        dragged = false;
        pointerType = event.pointerType;
      }
      pointers.set(event.pointerId, pointOf(event));
      if (pointers.size === 2) startDrag();
    };

    const pointerMove = (event: PointerEvent) => {
      const previous = pointers.get(event.pointerId);
      if (!previous) return;
      const next = pointOf(event);
      if (!dragged) {
        if (distance(previous, next) < DRAG_THRESHOLD) return;
        startDrag();
      }

      pointers.set(event.pointerId, next);
      if (pointers.size === 1) {
        moveView(zoom, previous, next);
        return;
      }

      const other = [...pointers.entries()].find(([id]) => id !== event.pointerId)![1];
      const ratio = Math.max(1, distance(next, other)) / Math.max(1, distance(previous, other));
      moveView(zoom * ratio, midpoint(previous, other), midpoint(next, other));
    };

    const pointerEnd = (event: PointerEvent) => {
      if (pointers.delete(event.pointerId) && !pointers.size) delete viewport.dataset.grabbing;
    };

    const lostCapture = (event: PointerEvent) => {
      if (event.target === viewport) pointerEnd(event);
    };

    const cancelDragClick = (event: MouseEvent) => {
      if (!dragged || event.detail === 0) return;
      event.preventDefault();
      event.stopPropagation();
    };

    // Chromium and Firefox expose trackpad pinch as a Ctrl-modified wheel event.
    const trackpadPinch = (event: WheelEvent) => {
      if (!event.ctrlKey || controlPressed || pointers.size) return;
      event.preventDefault();
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? viewport.clientHeight : 1;
      moveView(zoom * Math.exp(-event.deltaY * unit * PINCH_ZOOM_SPEED), pointOf(event));
    };

    const safariPinchStart = (event: Event) => {
      event.preventDefault();
      safariPinchZoom = zoom;
    };

    const safariPinch = (event: Event) => {
      event.preventDefault();
      if (pointers.size) return;
      const gesture = event as MouseEvent & { scale: number };
      moveView(safariPinchZoom * gesture.scale, pointOf(gesture));
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.target !== viewport || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "0") {
        event.preventDefault();
        resetView();
        return;
      }

      const panX = event.key === "ArrowLeft" ? -48 : event.key === "ArrowRight" ? 48 : 0;
      const panY = event.key === "ArrowUp" ? -48 : event.key === "ArrowDown" ? 48 : 0;
      if (panX || panY) {
        event.preventDefault();
        viewport.scrollBy(panX, panY);
        return;
      }

      const nextZoom = event.key === "+" || event.key === "=" ? zoom * 1.25
        : event.key === "-" ? zoom / 1.25 : null;
      if (nextZoom === null) return;

      event.preventDefault();
      const bounds = viewport.getBoundingClientRect();
      moveView(nextZoom, { x: bounds.left + viewport.clientLeft + viewport.clientWidth / 2, y: bounds.top + viewport.clientTop + viewport.clientHeight / 2 });
    };

    const trackControl = (event: KeyboardEvent) => { controlPressed = event.ctrlKey; };
    const handleBlur = () => {
      controlPressed = false;
      pointers.clear();
      delete viewport.dataset.grabbing;
    };

    const listeners = new AbortController();
    const { signal } = listeners;
    viewport.addEventListener("pointerdown", pointerDown, { signal });
    window.addEventListener("pointermove", pointerMove, { signal });
    window.addEventListener("pointerup", pointerEnd, { signal });
    window.addEventListener("pointercancel", pointerEnd, { signal });
    viewport.addEventListener("lostpointercapture", lostCapture, { signal });
    viewport.addEventListener("click", cancelDragClick, { capture: true, signal });
    viewport.addEventListener("wheel", trackpadPinch, { passive: false, signal });
    viewport.addEventListener("gesturestart", safariPinchStart, { passive: false, signal });
    viewport.addEventListener("gesturechange", safariPinch, { passive: false, signal });
    viewport.addEventListener("keydown", handleKeyDown, { signal });
    window.addEventListener("keydown", trackControl, { signal });
    window.addEventListener("keyup", trackControl, { signal });
    window.addEventListener("blur", handleBlur, { signal });
    return () => listeners.abort();
  }, [hasCanvas]);

  return { viewportRef, canvasRef };
}
