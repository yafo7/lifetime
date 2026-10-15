import * as THREE from "three";
import { PlayerMotion, type PlayerFrame } from "../play/playerMotion";
import type { SceneGeometry } from "../navigation/geometry";
import type { Navigation } from "../navigation/navigation";
import type { Vec3 } from "../../shared/motion";

/** Third-person input and camera only; geometry/navigation and library clips stay independent. */
export class ThirdPersonControls {
  readonly motor: PlayerMotion;
  private keys = new Set<string>();
  private yaw: number;
  private pitch = 0.28;
  private distance = 6;
  private drag: { id: number; x: number; y: number } | null = null;
  private ray = new THREE.Raycaster();
  private oldPosition: THREE.Vector3;
  private oldQuaternion: THREE.Quaternion;
  private oldTabIndex: number;
  private previousFocus: HTMLElement | null;
  constructor(
    private canvas: HTMLCanvasElement,
    private camera: THREE.PerspectiveCamera,
    nav: Navigation,
    private geometry: SceneGeometry,
    start: Vec3,
    heading: number,
    jumpDuration: number,
    private exit: () => void,
  ) {
    this.yaw = heading + Math.PI;
    this.oldPosition = camera.position.clone();
    this.oldQuaternion = camera.quaternion.clone();
    this.oldTabIndex = canvas.tabIndex;
    this.previousFocus = canvas.ownerDocument
      .activeElement as HTMLElement | null;
    this.motor = new PlayerMotion(
      nav,
      start,
      heading,
      jumpDuration,
      (ground) => {
        this.ray.set(
          new THREE.Vector3(ground[0], ground[1] + 0.1, ground[2]),
          new THREE.Vector3(0, 1, 0),
        );
        this.ray.near = 0;
        this.ray.far = 6;
        const hit = this.ray.intersectObject(geometry.root, true)[0];
        return hit ? Math.max(ground[1], hit.point.y - 2.05) : Infinity;
      },
    );
    canvas.tabIndex = 0;
    canvas.addEventListener("pointerdown", this.down);
    canvas.addEventListener("pointermove", this.move);
    canvas.addEventListener("pointerup", this.up);
    canvas.addEventListener("pointercancel", this.release);
    canvas.addEventListener("lostpointercapture", this.release);
    canvas.addEventListener("wheel", this.wheel, { passive: false });
    canvas.addEventListener("contextmenu", this.prevent);
    window.addEventListener("keydown", this.keyDown);
    window.addEventListener("keyup", this.keyUp);
    window.addEventListener("blur", this.clear);
    canvas.addEventListener("blur", this.clear);
    document.addEventListener("visibilitychange", this.clear);
    canvas.focus({ preventScroll: true });
    this.updateCamera();
  }
  update(dt: number): PlayerFrame {
    const forward =
      Number(this.keys.has("KeyW")) - Number(this.keys.has("KeyS"));
    const right = Number(this.keys.has("KeyD")) - Number(this.keys.has("KeyA"));
    const frame = this.motor.update(
      dt,
      -Math.sin(this.yaw) * forward + Math.cos(this.yaw) * right,
      -Math.cos(this.yaw) * forward - Math.sin(this.yaw) * right,
    );
    this.updateCamera();
    return frame;
  }
  private updateCamera(): void {
    const p = this.motor.frame.position,
      target = new THREE.Vector3(p[0], p[1] + 1.25, p[2]);
    const offset = new THREE.Vector3(
      Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      Math.cos(this.yaw) * Math.cos(this.pitch),
    );
    this.ray.set(target, offset);
    this.ray.near = 0.1;
    this.ray.far = this.distance;
    const hit = this.ray.intersectObject(this.geometry.root, true)[0];
    const distance = hit ? Math.max(0.25, hit.distance - 0.25) : this.distance;
    this.camera.position.copy(target).addScaledVector(offset, distance);
    this.camera.lookAt(target);
    this.camera.updateMatrixWorld();
  }
  private prevent = (e: Event) => e.preventDefault();
  private keyDown = (e: KeyboardEvent) => {
    if (e.code === "Escape") {
      e.preventDefault();
      this.exit();
      return;
    }
    if (
      document.activeElement !== this.canvas ||
      e.ctrlKey ||
      e.metaKey ||
      e.altKey
    )
      return;
    if (!["KeyW", "KeyA", "KeyS", "KeyD", "Space"].includes(e.code)) return;
    e.preventDefault();
    if (e.code === "Space" && !e.repeat && !this.keys.has(e.code))
      this.motor.jump();
    this.keys.add(e.code);
  };
  private keyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };
  private clear = () => {
    this.keys.clear();
    this.motor.clearInput();
    this.release();
  };
  private down = (e: PointerEvent) => {
    if (this.drag || (e.button !== 0 && e.button !== 2)) return;
    e.preventDefault();
    this.canvas.focus({ preventScroll: true });
    this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    this.canvas.setPointerCapture(e.pointerId);
  };
  private move = (e: PointerEvent) => {
    if (!this.drag || e.pointerId !== this.drag.id) return;
    this.yaw -= (e.clientX - this.drag.x) * 0.006;
    this.pitch = THREE.MathUtils.clamp(
      this.pitch + (e.clientY - this.drag.y) * 0.006,
      0.05,
      1.15,
    );
    this.drag.x = e.clientX;
    this.drag.y = e.clientY;
    this.updateCamera();
  };
  private up = (e: PointerEvent) => {
    if (this.drag?.id === e.pointerId) this.release();
  };
  private release = () => {
    const drag = this.drag;
    this.drag = null;
    if (drag && this.canvas.hasPointerCapture(drag.id))
      this.canvas.releasePointerCapture(drag.id);
  };
  private wheel = (e: WheelEvent) => {
    e.preventDefault();
    this.distance = THREE.MathUtils.clamp(
      this.distance * Math.exp(e.deltaY * 0.001),
      3,
      14,
    );
    this.updateCamera();
  };
  dispose(): void {
    this.clear();
    this.canvas.removeEventListener("pointerdown", this.down);
    this.canvas.removeEventListener("pointermove", this.move);
    this.canvas.removeEventListener("pointerup", this.up);
    this.canvas.removeEventListener("pointercancel", this.release);
    this.canvas.removeEventListener("lostpointercapture", this.release);
    this.canvas.removeEventListener("wheel", this.wheel);
    this.canvas.removeEventListener("contextmenu", this.prevent);
    this.canvas.removeEventListener("blur", this.clear);
    window.removeEventListener("keydown", this.keyDown);
    window.removeEventListener("keyup", this.keyUp);
    window.removeEventListener("blur", this.clear);
    document.removeEventListener("visibilitychange", this.clear);
    this.canvas.tabIndex = this.oldTabIndex;
    this.camera.position.copy(this.oldPosition);
    this.camera.quaternion.copy(this.oldQuaternion);
    this.camera.updateMatrixWorld();
    this.previousFocus?.focus({ preventScroll: true });
  }
}
