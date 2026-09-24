import * as THREE from "three";
import { RuntimeIndex } from "@voxel-studio/render-runtime";
import { ActorPreviewControls } from "./orbitControls";
import {
  buildModelGroupWithNodes,
  type BuiltModelGroup,
} from "./map/client/modelRenderer";
import { WorldForgeMaterialTagRuntime } from "./map/client/materialTagRuntimeAdapter";
import { createMapViewer, type MapViewer } from "./map/client/mapViewer";
import { AnimationPlayer } from "./animationPlayer";
import type { AnimationClip, ActorInstance } from "../../shared/contracts";
import type { MapResource } from "../../shared/maps";
import { resources } from "../services/resources";

class Visual {
  readonly root = new THREE.Group();
  readonly player: AnimationPlayer;
  readonly materials: WorldForgeMaterialTagRuntime;
  clip: AnimationClip | null = null;
  time = 0;
  playing = false;
  loop = false;
  stopped = true;
  constructor(
    readonly built: BuiltModelGroup,
    scene: THREE.Scene,
    renderer: THREE.WebGLRenderer,
  ) {
    this.root.add(built.group);
    scene.add(this.root);
    this.player = new AnimationPlayer(built);
    const runtimeIndex = new RuntimeIndex();
    for (const [id, mesh] of built.objects)
      if ((mesh as THREE.Mesh).isMesh) runtimeIndex.registerMesh(id, mesh);
    this.materials = new WorldForgeMaterialTagRuntime({
      scene,
      renderer,
      runtimeIndex,
      batchParent: this.root,
      objectGroups: new Map(),
      materialTagPolicy: { disabled: [] },
      effectBatchMinGroupSize: Number.MAX_SAFE_INTEGER,
    });
    this.materials.apply(built.group);
  }
  update(dt: number, elapsed: number, camera: THREE.Camera): void {
    if (this.playing && this.clip) {
      this.time += dt;
      if (this.time >= this.clip.duration) {
        if (this.loop) this.time %= this.clip.duration;
        else {
          this.time = this.clip.duration;
          this.playing = false;
        }
      }
    }
    this.player.sample(this.stopped ? null : this.clip, this.time);
    this.materials.updateRuntimeUniforms(elapsed, camera);
  }
  dispose(): void {
    this.materials.dispose();
    this.root.removeFromParent();
    disposeObject(this.root);
  }
}
export class Viewport {
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;
  private controls!: ActorPreviewControls;
  private viewer: MapViewer | null = null;
  private visuals = new Map<string, Visual>();
  private frame = 0;
  private last = 0;
  private elapsed = 0;
  private active = false;
  private observer: ResizeObserver;
  private loadVersion = 0;
  private disposed = false;
  private selected: string | null = null;
  onPlayback = (_time: number, _duration: number, _playing: boolean) => {};
  onSelect = (_id: string | null) => {};
  constructor(private canvas: HTMLCanvasElement) {
    this.previewScene();
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas.parentElement!);
  }
  private previewScene(): void {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xccd2d8);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.05, 5000);
    this.camera.position.set(8, 5, 12);
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x63705e, 1.5));
    const sun = new THREE.DirectionalLight(0xffffff, 2);
    sun.position.set(10, 20, 15);
    this.scene.add(sun);
    this.scene.add(new THREE.GridHelper(100, 100, 0x8d9b87, 0xaab5a0));
    this.makeControls();
    this.controls.fit(
      new THREE.Box3(new THREE.Vector3(-3, 0, -3), new THREE.Vector3(3, 5, 3)),
    );
  }
  private makeControls(): void {
    this.controls?.dispose();
    this.controls = new ActorPreviewControls(
      this.canvas,
      this.camera,
      (x, y) => {
        const rect = this.canvas.getBoundingClientRect();
        const ray = new THREE.Raycaster();
        ray.setFromCamera(
          new THREE.Vector2(
            ((x - rect.left) / rect.width) * 2 - 1,
            (-(y - rect.top) / rect.height) * 2 + 1,
          ),
          this.camera,
        );
        const hits = ray.intersectObjects(
          [...this.visuals.values()].map((v) => v.root),
          true,
        );
        const hit = hits[0]?.object;
        let found: string | null = null;
        if (hit)
          for (const [id, v] of this.visuals) {
            let node: THREE.Object3D | null = hit;
            while (node) {
              if (node === v.root) found = id;
              node = node.parent;
            }
          }
        this.selected = found;
        this.onSelect(found);
      },
    );
    if (this.active) this.controls.activate();
  }
  async openMap(resource: MapResource): Promise<void> {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    ++this.loadVersion;
    this.clearVisuals();
    this.controls.dispose();
    if (this.viewer) this.viewer.dispose();
    else {
      disposeObject(this.scene);
      this.renderer.dispose();
    }
    this.viewer = null;
    try {
      this.viewer = await createMapViewer({
        canvas: this.canvas,
        map: resource.map,
        scheme: resource.scheme,
        hdriUrl: () => resources.hdri(resource.id),
        autoStart: false,
      });
      this.scene = this.viewer.scene;
      this.camera = this.viewer.camera;
      this.renderer = this.viewer.renderer;
      this.makeControls();
      this.fit();
      this.resize();
      this.setActive(this.active);
    } catch (error) {
      this.previewScene();
      this.setActive(this.active);
      throw error;
    }
  }
  async model(modelJson: unknown): Promise<void> {
    const version = ++this.loadVersion;
    const built = await buildModelGroupWithNodes(modelJson, { fidelity: true });
    if (version !== this.loadVersion || this.disposed) {
      disposeObject(built.group);
      return;
    }
    this.clearVisuals();
    const visual = new Visual(built, this.scene, this.renderer);
    this.visuals.set("preview", visual);
    this.selected = "preview";
    this.fit();
    this.notify();
  }
  clear(): void {
    ++this.loadVersion;
    this.clearVisuals();
    this.notify();
  }
  async add(
    instance: ActorInstance,
    modelJson: unknown,
    clip: AnimationClip | null,
  ): Promise<void> {
    const built = await buildModelGroupWithNodes(modelJson, { fidelity: true });
    if (this.disposed) {
      disposeObject(built.group);
      return;
    }
    const visual = new Visual(built, this.scene, this.renderer);
    this.visuals.set(instance.id, visual);
    this.updateInstance(instance, clip);
  }
  updateInstance(instance: ActorInstance, clip: AnimationClip | null): void {
    const v = this.visuals.get(instance.id);
    if (!v) return;
    v.root.position.fromArray(instance.position);
    v.root.rotation.y = THREE.MathUtils.degToRad(instance.rotation);
    v.root.scale.setScalar(instance.scale);
    if (v.clip?.id !== clip?.id) {
      v.clip = clip;
      v.time = 0;
      v.playing = false;
      v.stopped = false;
    }
    v.loop = instance.loop;
  }
  remove(id: string): void {
    this.visuals.get(id)?.dispose();
    this.visuals.delete(id);
  }
  private clearVisuals(): void {
    for (const v of this.visuals.values()) v.dispose();
    this.visuals.clear();
  }
  setClip(clip: AnimationClip | null): void {
    const v = this.visuals.get("preview");
    if (!v) return;
    v.clip = clip;
    v.time = 0;
    v.playing = false;
    v.stopped = false;
    v.loop = Boolean((clip?.animation as { loop?: boolean })?.loop);
    v.player.sample(clip, 0);
    this.notify();
  }
  setLoop(value: boolean): void {
    const v = this.visuals.get("preview");
    if (v) v.loop = value;
  }
  toggle(): void {
    const active = [...this.visuals.values()].filter((v) => v.clip);
    const play = !active.some((v) => v.playing);
    for (const v of active) {
      if (v.time >= v.clip!.duration) v.time = 0;
      v.playing = play;
      v.stopped = false;
    }
    this.notify();
  }
  stop(): void {
    for (const v of this.visuals.values()) {
      v.playing = false;
      v.stopped = true;
      v.time = 0;
      v.player.sample(null, 0);
    }
    this.notify();
  }
  seek(time: number): void {
    for (const v of this.visuals.values()) {
      v.stopped = false;
      v.time = Math.max(0, Math.min(time, v.clip?.duration ?? 0));
      v.player.sample(v.clip, v.time);
    }
    this.notify();
  }
  fit(): void {
    const object =
      this.viewer?.runtime.rendered?.group ?? this.visuals.get("preview")?.root;
    if (object) {
      const bounds = new THREE.Box3().setFromObject(object);
      if (!bounds.isEmpty()) this.controls.fit(bounds);
    }
  }
  setActive(value: boolean): void {
    this.active = value;
    if (value) {
      this.controls.activate();
      this.resize();
      if (!this.frame) {
        this.last = performance.now();
        this.frame = requestAnimationFrame(this.render);
      }
    } else {
      this.controls.deactivate();
      for (const v of this.visuals.values()) v.playing = false;
      cancelAnimationFrame(this.frame);
      this.frame = 0;
      this.notify();
    }
  }
  private render = () => {
    this.frame = requestAnimationFrame(this.render);
    const now = performance.now(),
      dt = Math.min((now - this.last) / 1000, 0.05);
    this.last = now;
    this.elapsed += dt;
    this.controls.update();
    for (const v of this.visuals.values())
      v.update(dt, this.elapsed, this.camera);
    if (this.viewer) this.viewer.tick(dt);
    else this.renderer.render(this.scene, this.camera);
    this.notify();
  };
  private notify(): void {
    const v = this.visuals.get("preview");
    const list = [...this.visuals.values()];
    this.onPlayback(
      v?.time ?? Math.max(0, ...list.map((v) => v.time)),
      v?.clip?.duration ??
        Math.max(0, ...list.map((v) => v.clip?.duration ?? 0)),
      list.some((v) => v.playing),
    );
  }
  private resize(): void {
    const width = this.canvas.clientWidth,
      height = this.canvas.clientHeight;
    if (!width || !height) return;
    if (this.viewer) this.viewer.setSize(width, height);
    else {
      this.renderer.setSize(width, height, false);
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    }
  }
  dispose(): void {
    this.disposed = true;
    this.setActive(false);
    this.observer.disconnect();
    this.clearVisuals();
    this.controls.dispose();
    if (this.viewer) this.viewer.dispose();
    else {
      disposeObject(this.scene);
      this.renderer.dispose();
    }
  }
}
export function disposeObject(object: THREE.Object3D): void {
  object.traverse((o) => {
    const mesh = o as THREE.Mesh;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material)
      ? mesh.material
      : [mesh.material];
    materials.forEach((m) => m?.dispose());
  });
}
