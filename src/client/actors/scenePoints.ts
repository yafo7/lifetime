import type { ActionPoint, Vec3 } from "../../shared/motion";
import { pointPosition } from "../../shared/motion";
import type { Viewport } from "../rendering/viewport";
import {
  magneticSurface,
  pointOnSurface,
  pointAtHeight,
  type SurfaceHit,
} from "../rendering/surfacePicker";

export const POINT_MIME = "application/x-lifetime-point";
/** DOM handles projected onto the same camera used to raycast the ground. */
export class ScenePoints {
  private layer = document.createElement("div");
  private hint = document.createElement("div");
  private points: ActionPoint[] = [];
  private selected = "";
  private dragging = "";
  private armed = "";
  private enabled = false;
  private ghost: Vec3 | null = null;
  private lift = document.createElement("button");
  private vertical: {
    original: ActionPoint;
    draft: ActionPoint;
    start: Vec3;
    x: number;
    y: number;
    scale: { x: number; y: number };
    candidates: SurfaceHit[];
    snap: SurfaceHit | null;
    pointerId: number;
  } | null = null;
  private handles = new Map<
    string,
    { button: HTMLButtonElement; ground: HTMLElement; line: SVGLineElement }
  >();
  private preview = document.createElement("span");
  constructor(
    private canvas: HTMLCanvasElement,
    private view: Viewport,
    private place: (id: string, point: ActionPoint) => void,
    private choose: (id: string) => void,
  ) {
    this.layer.className = "scene-points";
    this.hint.className = "point-placement-hint";
    this.preview.className = "point-drop-preview";
    this.lift.className = "point-height-handle";
    this.lift.textContent = "↑";
    this.lift.title = "拖动调整向上高度 · Alt 暂停吸附 · Esc 取消";
    this.lift.setAttribute("aria-label", "拖动标点高度");
    this.lift.onpointerdown = this.liftDown;
    this.lift.onpointermove = this.liftMove;
    this.lift.onpointerup = this.liftUp;
    this.lift.onpointercancel = this.cancelLift;
    this.lift.onlostpointercapture = this.cancelLift;
    window.addEventListener("blur", this.cancelLift);
    canvas.parentElement!.append(this.layer, this.hint);
    canvas.parentElement!.addEventListener("dragover", this.dragover);
    canvas.parentElement!.addEventListener("dragenter", this.dragover);
    canvas.parentElement!.addEventListener("drop", this.drop);
    canvas.parentElement!.addEventListener("dragleave", this.leave);
    canvas.addEventListener("pointerdown", this.down, true);
    canvas.addEventListener("click", this.click, true);
    document.addEventListener("dragend", this.end);
    document.addEventListener("keydown", this.keydown);
    this.view.onFrame = () => this.update();
    this.show(false);
  }
  set(points: ActionPoint[], selected: string): void {
    this.cancelLift();
    this.points = points;
    this.selected = selected;
    if (this.armed && !points.some((p) => p.id === this.armed)) this.armed = "";
    this.layer.replaceChildren();
    this.handles.clear();
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("point-projections");
    this.layer.append(svg);
    for (const p of points.filter((p) => p.ground)) {
      const button = document.createElement("button"),
        ground = document.createElement("span");
      button.className = `scene-point ${p.id === selected ? "selected" : ""}`;
      button.textContent = p.name;
      button.draggable = true;
      button.setAttribute(
        "aria-label",
        `地图标点 ${p.name}，${p.offsetMode === "normal" ? "离面距离" : "向上高度"} ${p.height}`,
      );
      button.onclick = () => this.choose(p.id);
      button.ondragstart = (e) => {
        e.dataTransfer?.setData(POINT_MIME, p.id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "copyMove";
        this.beginDrag(p.id);
      };
      ground.className = "point-ground-projection";
      const line = document.createElementNS(
        svg.namespaceURI,
        "line",
      ) as SVGLineElement;
      svg.append(line);
      this.layer.append(ground, button);
      this.handles.set(p.id, { button, ground, line });
    }
    this.layer.append(this.preview, this.lift);
    this.update();
  }
  show(enabled: boolean): void {
    this.enabled = enabled;
    this.layer.hidden = !enabled;
    if (!enabled) {
      this.cancelLift();
      this.armed = "";
      this.dragging = "";
      this.ghost = null;
    }
    this.update();
  }
  beginDrag(id: string): void {
    this.dragging = id;
    this.selected = id;
    this.armed = "";
    this.update();
  }
  arm(id: string): void {
    this.armed = id;
    this.selected = id;
    this.update();
  }
  private down = (e: PointerEvent) => {
    if (this.enabled && this.armed && e.button === 0)
      e.stopImmediatePropagation();
  };
  private click = (e: MouseEvent) => {
    if (!this.enabled || !this.armed) return;
    e.stopImmediatePropagation();
    const hit = this.view.pickSurface(e.clientX, e.clientY);
    if (hit) {
      const id = this.armed;
      this.armed = "";
      const p = this.points.find((p) => p.id === id);
      if (p) this.place(id, pointOnSurface(p, hit));
    }
    this.update();
  };
  private dragover = (e: DragEvent) => {
    if (!this.enabled || !e.dataTransfer?.types.includes(POINT_MIME)) return;
    e.preventDefault();
    this.ghost = this.view.pickSurface(e.clientX, e.clientY)?.position ?? null;
    e.dataTransfer.dropEffect = this.ghost ? "move" : "none";
    this.update();
  };
  private drop = (e: DragEvent) => {
    if (!this.enabled || !e.dataTransfer?.types.includes(POINT_MIME)) return;
    e.preventDefault();
    const id = e.dataTransfer.getData(POINT_MIME),
      hit = this.view.pickSurface(e.clientX, e.clientY),
      p = this.points.find((p) => p.id === id);
    if (hit && p) this.place(id, pointOnSurface(p, hit));
    this.end();
  };
  private leave = () => {
    this.ghost = null;
    this.update();
  };
  private keydown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      this.cancelLift();
      this.armed = "";
      this.end();
    }
  };
  private end = () => {
    this.dragging = "";
    this.ghost = null;
    this.update();
  };
  private liftDown = (e: PointerEvent) => {
    if (!this.enabled || e.button !== 0) return;
    const point = this.points.find((p) => p.id === this.selected);
    if (!point?.ground) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      const original = this.view.resolvePoint(point),
        start = pointPosition(original);
      this.vertical = {
        original,
        draft: original,
        start,
        x: e.clientX,
        y: e.clientY,
        scale: this.view.verticalDragScale(start),
        candidates: this.view.verticalSurfaces(start[0], start[2]),
        snap: null,
        pointerId: e.pointerId,
      };
      this.lift.setPointerCapture(e.pointerId);
      this.update();
    } catch {
      /* Invalid anchors stay editable through re-placement. */
    }
  };
  private liftMove = (e: PointerEvent) => {
    const d = this.vertical;
    if (!d || e.pointerId !== d.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    const delta =
      ((e.clientX - d.x) * d.scale.x + (e.clientY - d.y) * d.scale.y) /
      (d.scale.x ** 2 + d.scale.y ** 2);
    const limits = this.view.pointHeightLimits();
    const height = Math.max(limits[0], Math.min(limits[1], d.start[1] + delta));
    d.snap = magneticSurface(d.candidates, height, d.snap, e.altKey);
    d.draft = pointAtHeight(d.original, height, d.snap, limits);
    this.ghost = d.snap?.position ?? null;
    this.update();
  };
  private liftUp = (e: PointerEvent) => {
    const d = this.vertical;
    if (!d || e.pointerId !== d.pointerId) return;
    this.liftMove(e);
    const draft = d.draft;
    this.cancelLift();
    this.place(d.original.id, draft);
  };
  private cancelLift = () => {
    if (!this.vertical) return;
    const id = this.vertical.pointerId;
    this.vertical = null;
    this.ghost = null;
    if (this.lift.hasPointerCapture(id)) this.lift.releasePointerCapture(id);
    this.update();
  };
  update(): void {
    this.hint.hidden =
      !this.enabled || !(this.armed || this.dragging || this.vertical);
    const name =
      this.points.find((p) => p.id === (this.armed || this.dragging))?.name ??
      "标点";
    this.hint.textContent = this.vertical
      ? `${this.vertical.snap ? "已吸附表面" : "竖直调高"} · Alt 暂停吸附 · Esc 取消`
      : this.armed
        ? `点击模型表面或地面放置 ${name}`
        : this.ghost
          ? `松开放置 ${name}`
          : "拖到模型表面或地面后松开";
    this.canvas.classList.toggle("placing-point", this.enabled && !!this.armed);
    if (!this.enabled) return;
    this.lift.hidden = true;
    for (const p of this.points) {
      const h = this.handles.get(p.id);
      if (!h || !p.ground) continue;
      let resolved: ActionPoint;
      try {
        resolved =
          this.vertical?.original.id === p.id
            ? this.vertical.draft
            : this.view.resolvePoint(p);
        h.button.classList.remove("invalid");
        h.button.title = "拖动重新定位，点击选择";
      } catch (error) {
        resolved = p;
        h.button.classList.add("invalid");
        h.button.title = String(error);
      }
      const a = this.view.projectPoint(pointPosition(resolved)),
        b = this.view.projectPoint(
          resolved.surface?.position ?? resolved.ground!,
        );
      h.button.hidden = !a.visible;
      h.ground.hidden = !b.visible;
      h.button.style.left = `${a.x}px`;
      h.button.style.top = `${a.y}px`;
      h.ground.style.left = `${b.x}px`;
      h.ground.style.top = `${b.y}px`;
      h.line.style.display =
        a.visible && b.visible && resolved.height > 0 ? "" : "none";
      h.line.setAttribute("x1", String(a.x));
      h.line.setAttribute("y1", String(a.y));
      h.line.setAttribute("x2", String(b.x));
      h.line.setAttribute("y2", String(b.y));
      if (p.id === this.selected && !h.button.classList.contains("invalid")) {
        this.lift.hidden = !a.visible;
        this.lift.style.left = `${a.x}px`;
        this.lift.style.top = `${a.y - 38}px`;
      }
    }
    this.preview.hidden = !this.ghost;
    if (this.ghost) {
      const p = this.view.projectPoint(this.ghost);
      this.preview.style.left = `${p.x}px`;
      this.preview.style.top = `${p.y}px`;
    }
  }
  dispose(): void {
    this.cancelLift();
    window.removeEventListener("blur", this.cancelLift);
    this.view.onFrame = () => {};
    this.layer.remove();
    this.hint.remove();
    this.canvas.parentElement!.removeEventListener("dragover", this.dragover);
    this.canvas.parentElement!.removeEventListener("dragenter", this.dragover);
    this.canvas.parentElement!.removeEventListener("drop", this.drop);
    this.canvas.parentElement!.removeEventListener("dragleave", this.leave);
    this.canvas.removeEventListener("pointerdown", this.down, true);
    this.canvas.removeEventListener("click", this.click, true);
    document.removeEventListener("dragend", this.end);
    document.removeEventListener("keydown", this.keydown);
  }
}
