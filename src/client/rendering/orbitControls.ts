import * as THREE from 'three';

/** Studio's OrbitControls mouse mapping and damping, scoped to this preview's lifecycle. */
export class ActorPreviewControls {
  private readonly target = new THREE.Vector3();
  private readonly rotation = new THREE.Vector2();
  private readonly pan = new THREE.Vector3();
  private readonly damping = 0.08;
  private active = false;
  private drag: { id: number; button: number; x: number; y: number; startX: number; startY: number; moved: boolean } | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly select: (clientX: number, clientY: number) => void
  ) {}

  activate(): void {
    if (this.active) return;
    this.active = true;
    this.canvas.addEventListener('pointerdown', this.onDown);
    this.canvas.addEventListener('pointermove', this.onMove);
    this.canvas.addEventListener('pointerup', this.onUp);
    this.canvas.addEventListener('pointercancel', this.cancel);
    this.canvas.addEventListener('lostpointercapture', this.onLostCapture);
    this.canvas.addEventListener('contextmenu', this.preventDefault);
    this.canvas.addEventListener('auxclick', this.preventDefault);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.ownerDocument.defaultView?.addEventListener('blur', this.cancel);
  }

  deactivate(): void {
    this.active = false;
    this.cancel();
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.canvas.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('pointercancel', this.cancel);
    this.canvas.removeEventListener('lostpointercapture', this.onLostCapture);
    this.canvas.removeEventListener('contextmenu', this.preventDefault);
    this.canvas.removeEventListener('auxclick', this.preventDefault);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.ownerDocument.defaultView?.removeEventListener('blur', this.cancel);
  }

  dispose(): void { this.deactivate(); }

  update(): void {
    if (!this.active || (this.rotation.lengthSq() < 1e-16 && this.pan.lengthSq() < 1e-16)) return;
    const offset = this.camera.position.clone().sub(this.target);
    const orbit = new THREE.Spherical().setFromVector3(offset);
    orbit.theta += this.rotation.x * this.damping;
    orbit.phi += this.rotation.y * this.damping;
    orbit.makeSafe();
    this.target.addScaledVector(this.pan, this.damping);
    this.camera.position.copy(this.target).add(offset.setFromSpherical(orbit));
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld();
    this.rotation.multiplyScalar(1 - this.damping);
    this.pan.multiplyScalar(1 - this.damping);
  }

  fit(bounds: THREE.Box3): void {
    this.cancel();
    const sphere = bounds.getBoundingSphere(new THREE.Sphere());
    this.target.copy(sphere.center);
    const vertical = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const horizontal = Math.atan(Math.tan(vertical) * this.camera.aspect);
    const distance = Math.max(sphere.radius * 3, sphere.radius / Math.sin(Math.min(vertical, horizontal)) * 1.1, 10);
    this.camera.position.copy(this.target).addScaledVector(new THREE.Vector3(0.5, 0.55, 0.7).normalize(), distance);
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld();
  }

  private readonly preventDefault = (event: Event): void => { event.preventDefault(); };

  private releaseDrag(): void {
    const drag = this.drag;
    this.drag = null;
    if (drag && this.canvas.hasPointerCapture(drag.id)) this.canvas.releasePointerCapture(drag.id);
    this.canvas.style.cursor = '';
  }

  private readonly cancel = (): void => {
    this.releaseDrag();
    this.rotation.set(0, 0);
    this.pan.set(0, 0, 0);
  };

  private readonly onLostCapture = (): void => {
    // A normal pointer-up has already released the drag; retain its damping tail.
    if (this.drag) this.cancel();
  };

  private readonly onDown = (event: PointerEvent): void => {
    if (this.drag || event.button < 0 || event.button > 2) return;
    event.preventDefault();
    this.drag = { id: event.pointerId, button: event.button, x: event.clientX, y: event.clientY,
      startX: event.clientX, startY: event.clientY, moved: false };
    this.canvas.setPointerCapture(event.pointerId);
    this.canvas.style.cursor = event.button === 2 ? 'move' : event.button === 0 ? 'grabbing' : 'ns-resize';
  };

  private readonly onMove = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    drag.x = event.clientX;
    drag.y = event.clientY;
    drag.moved ||= Math.abs(event.clientX - drag.startX) > 3 || Math.abs(event.clientY - drag.startY) > 3;
    const height = Math.max(1, this.canvas.getBoundingClientRect().height);
    const modifier = event.ctrlKey || event.metaKey || event.shiftKey;
    if ((drag.button === 0 && !modifier) || (drag.button === 2 && modifier)) {
      this.rotation.x -= dx * 2 * Math.PI / height;
      this.rotation.y -= dy * 2 * Math.PI / height;
    } else if (drag.button === 2 || drag.button === 0) {
      const units = 2 * this.camera.position.distanceTo(this.target) * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) / height;
      this.pan.add(new THREE.Vector3(-dx * units, dy * units, 0).applyQuaternion(this.camera.quaternion));
    } else if (dy) {
      this.zoom(Math.pow(0.95, -dy * 0.01));
    }
    this.update();
  };

  private readonly onUp = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || drag.id !== event.pointerId) return;
    const rect = this.canvas.getBoundingClientRect();
    const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
    const clicked = drag.button === 0 && event.button === 0 && !drag.moved
      && Math.abs(event.clientX - drag.startX) <= 3 && Math.abs(event.clientY - drag.startY) <= 3 && inside;
    this.releaseDrag();
    if (clicked) this.select(event.clientX, event.clientY);
  };

  private zoom(factor: number): void {
    const offset = this.camera.position.clone().sub(this.target);
    this.camera.position.copy(this.target).add(offset.multiplyScalar(factor));
    this.camera.updateMatrixWorld();
  }

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1);
    this.zoom(Math.pow(0.95, -THREE.MathUtils.clamp(pixels, -1000, 1000) * 0.01));
    this.update();
  };
}
