/**
 * Small animation-friendly camera for the character-cell graph viewport.
 */

import type { WorldPoint, WorldRect } from "./graph-layout";

export const MIN_GRAPH_ZOOM = 0.5;
export const MAX_GRAPH_ZOOM = 2;
export const DEFAULT_GRAPH_ZOOM = 1;

export interface CameraState {
  centerX: number;
  centerY: number;
  zoom: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function easeOutCubic(value: number): number {
  return 1 - Math.pow(1 - value, 3);
}

export class GraphCamera {
  private current: CameraState;
  private start: CameraState;
  private target: CameraState;
  private animationStartedAt = 0;
  private animationDurationMs = 160;

  constructor(initial: Partial<CameraState> = {}) {
    this.current = {
      centerX: initial.centerX ?? 0,
      centerY: initial.centerY ?? 0,
      zoom: clamp(initial.zoom ?? DEFAULT_GRAPH_ZOOM, MIN_GRAPH_ZOOM, MAX_GRAPH_ZOOM),
    };
    this.start = { ...this.current };
    this.target = { ...this.current };
  }

  get state(): Readonly<CameraState> {
    return this.current;
  }

  get targetState(): Readonly<CameraState> {
    return this.target;
  }

  get animating(): boolean {
    return (
      Math.abs(this.current.centerX - this.target.centerX) > 0.01 ||
      Math.abs(this.current.centerY - this.target.centerY) > 0.01 ||
      Math.abs(this.current.zoom - this.target.zoom) > 0.001
    );
  }

  jumpTo(next: Partial<CameraState>): void {
    this.current = {
      centerX: next.centerX ?? this.current.centerX,
      centerY: next.centerY ?? this.current.centerY,
      zoom: clamp(next.zoom ?? this.current.zoom, MIN_GRAPH_ZOOM, MAX_GRAPH_ZOOM),
    };
    this.start = { ...this.current };
    this.target = { ...this.current };
    this.animationStartedAt = 0;
  }

  animateTo(
    next: Partial<CameraState>,
    now = Date.now(),
    durationMs = 160,
  ): void {
    // Retarget from the interpolated current position so repeated input never
    // queues stale transitions.
    this.step(now);
    this.start = { ...this.current };
    this.target = {
      centerX: next.centerX ?? this.target.centerX,
      centerY: next.centerY ?? this.target.centerY,
      zoom: clamp(next.zoom ?? this.target.zoom, MIN_GRAPH_ZOOM, MAX_GRAPH_ZOOM),
    };
    this.animationStartedAt = now;
    this.animationDurationMs = Math.max(1, durationMs);
  }

  centerOn(point: WorldPoint, now = Date.now()): void {
    this.animateTo({ centerX: point.x, centerY: point.y }, now);
  }

  panBy(screenDx: number, screenDy: number, now = Date.now()): void {
    const zoom = this.target.zoom || 1;
    this.animateTo(
      {
        centerX: this.target.centerX + screenDx / zoom,
        centerY: this.target.centerY + screenDy / zoom,
      },
      now,
    );
  }

  /**
   * Zoom around a world-space anchor. Its current screen position remains
   * stable while the camera target changes.
   */
  zoomBy(delta: number, anchor: WorldPoint, now = Date.now()): void {
    const oldZoom = this.target.zoom;
    const nextZoom = clamp(oldZoom + delta, MIN_GRAPH_ZOOM, MAX_GRAPH_ZOOM);
    if (nextZoom === oldZoom) return;
    const screenOffsetX = (anchor.x - this.target.centerX) * oldZoom;
    const screenOffsetY = (anchor.y - this.target.centerY) * oldZoom;
    this.animateTo(
      {
        zoom: nextZoom,
        centerX: anchor.x - screenOffsetX / nextZoom,
        centerY: anchor.y - screenOffsetY / nextZoom,
      },
      now,
    );
  }

  fit(bounds: WorldRect, viewport: ViewportSize, now = Date.now()): void {
    const padding = 4;
    const availableWidth = Math.max(1, viewport.width - padding * 2);
    const availableHeight = Math.max(1, viewport.height - padding * 2);
    const zoom = clamp(
      Math.min(
        availableWidth / Math.max(1, bounds.width),
        availableHeight / Math.max(1, bounds.height),
      ),
      MIN_GRAPH_ZOOM,
      MAX_GRAPH_ZOOM,
    );
    this.animateTo(
      {
        centerX: bounds.x + bounds.width / 2,
        centerY: bounds.y + bounds.height / 2,
        zoom,
      },
      now,
    );
  }

  reset(anchor?: WorldPoint, now = Date.now()): void {
    this.animateTo(
      {
        centerX: anchor?.x ?? this.target.centerX,
        centerY: anchor?.y ?? this.target.centerY,
        zoom: DEFAULT_GRAPH_ZOOM,
      },
      now,
    );
  }

  step(now = Date.now()): boolean {
    if (!this.animationStartedAt) return false;
    const elapsed = now - this.animationStartedAt;
    const progress = clamp(elapsed / this.animationDurationMs, 0, 1);
    const eased = easeOutCubic(progress);
    this.current = {
      centerX: this.start.centerX + (this.target.centerX - this.start.centerX) * eased,
      centerY: this.start.centerY + (this.target.centerY - this.start.centerY) * eased,
      zoom: this.start.zoom + (this.target.zoom - this.start.zoom) * eased,
    };
    if (progress >= 1) {
      this.current = { ...this.target };
      this.animationStartedAt = 0;
    }
    return this.animating;
  }

  worldToScreen(point: WorldPoint, viewport: ViewportSize): WorldPoint {
    return {
      x: (point.x - this.current.centerX) * this.current.zoom + viewport.width / 2,
      y: (point.y - this.current.centerY) * this.current.zoom + viewport.height / 2,
    };
  }
}
