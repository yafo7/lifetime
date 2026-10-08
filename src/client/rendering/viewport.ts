import { mapSpace } from "../../shared/sceneMotion";
import type { SceneGeometry } from "../navigation/geometry";
import type { MotionFrame } from "../motion/runtime";
import * as THREE from "three";
import { RuntimeIndex } from "@voxel-studio/render-runtime";
import { ActorPreviewControls } from "./orbitControls";
import {
  buildModelGroupWithNodes,
  type BuiltModelGroup,
} from "./map/client/modelRenderer";
import { WorldForgeMaterialTagRuntime } from "./map/client/materialTagRuntimeAdapter";
import { createMapViewer, type MapViewer } from "./map/client/mapViewer";
import { AnimationPlayer, type Pose } from "./animationPlayer";
import { motionPose } from "./motionPose";
import type { AnimationClip, ActorInstance } from "../../shared/contracts";
import type { MapResource } from "../../shared/maps";
import { resources } from "../services/resources";

import referenceTree from "../assets/reference-tree.json";
import { MotionRuntime, type MotionOrigin } from "../motion/runtime";
import { SurfacePicker, type SurfaceHit } from "./surfacePicker";
import {
  MotionError,
  type MotionContext,
  type MotionPlan,
  type Vec3,
  type ActionPoint,
} from "../../shared/motion";
import {
  PREVIEW_GROUND_SIZE,
  PREVIEW_GROUND_HALF,
  REFERENCE_TREE_POSITIONS,
} from "./previewGround";

class Visual {
  readonly root = new THREE.Group();
  readonly player: AnimationPlayer;
  readonly materials: WorldForgeMaterialTagRuntime;
  clip: AnimationClip | null = null;
  time = 0;
  playing = false;
  rate = 1;
  loop = false;
  stopped = true;
  readonly groundAnchor = new THREE.Vector3();
  motionPose: Pose | null = null;
  transitionPose: Pose | null = null;
  motionStep = "";
  constructor(
    readonly built: BuiltModelGroup,
    scene: THREE.Scene,
    renderer: THREE.WebGLRenderer,
  ) {
    this.root.add(built.group);
    scene.add(this.root);
    this.player = new AnimationPlayer(built);
    const bounds = new THREE.Box3().setFromObject(built.group);
    const center = bounds.getCenter(new THREE.Vector3());
    this.groundAnchor.set(center.x, bounds.min.y, center.z);
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
      this.time += dt * this.rate;
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
  readonly motion = new MotionRuntime();
  private motionRequest: {
    plan: MotionPlan;
    ctx: MotionContext;
    id: string;
    parameters: Record<string, Vec3>;
    start: Vec3;
    heading: number;
  } | null = null;
  onMotionState = () => {};
  onFrame = () => {};
  onSceneFrame = (_dt: number) => {};
  private sceneGeometry: SceneGeometry | null = null;
  private sceneGuides = new Map<string, THREE.Group>();
  private surfaces = new SurfacePicker();
  private actorSurfaceId = "unbound";
  setActorSurfaceId(id: string): void {
    this.actorSurfaceId = id;
    this.refreshSurfaces();
  }
  private refreshSurfaces(): void {
    this.surfaces.clear();
    if (this.viewer) {
      if (this.sceneGeometry)
        for (const [id, root] of this.sceneGeometry.objects)
          this.surfaces.register(id, root);
      return;
    }
    this.referenceTrees.forEach((root, index) =>
      this.surfaces.register(`reference-tree-v1:${index}`, root),
    );
    const actor = this.visuals.get("preview");
    if (actor)
      this.surfaces.register(`actor:${this.actorSurfaceId}`, actor.built.group);
  }
  resolvePoint(p: ActionPoint): ActionPoint {
    return this.surfaces.resolve(p);
  }
  resolveMotionContext(ctx: MotionContext): MotionContext {
    return {
      ...ctx,
      points: (ctx.points ?? []).map((p) => this.resolvePoint(p)),
    };
  }
  pickSurface(clientX: number, clientY: number): SurfaceHit | null {
    const rect = this.canvas.getBoundingClientRect();
    if (
      !rect.width ||
      !rect.height ||
      clientX < rect.left ||
      clientX > rect.right ||
      clientY < rect.top ||
      clientY > rect.bottom
    )
      return null;
    const ray = new THREE.Raycaster();
    this.camera.updateMatrixWorld();
    ray.setFromCamera(
      new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        1 - ((clientY - rect.top) / rect.height) * 2,
      ),
      this.camera,
    );
    return this.surfaces.pick(ray);
  }
  verticalSurfaces(x: number, z: number): SurfaceHit[] {
    return this.surfaces.vertical(x, z);
  }
  verticalDragScale(point: Vec3): { x: number; y: number } {
    const a = this.projectPoint(point),
      b = this.projectPoint([point[0], point[1] + 1, point[2]]);
    if (Math.hypot(b.x - a.x, b.y - a.y) >= 3)
      return { x: b.x - a.x, y: b.y - a.y };
    // A top-down camera projects the axis to a point: use a stable screen-up fallback.
    return {
      x: 0,
      y: -Math.max(
        3,
        this.canvas.clientHeight /
          (2 *
            this.camera.position.distanceTo(new THREE.Vector3(...point)) *
            Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))),
      ),
    };
  }
  projectPoint(point: Vec3): { x: number; y: number; visible: boolean } {
    const p = new THREE.Vector3(...point).project(this.camera);
    return {
      x: ((p.x + 1) / 2) * this.canvas.clientWidth,
      y: ((1 - p.y) / 2) * this.canvas.clientHeight,
      visible:
        p.z >= -1 && p.z <= 1 && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1,
    };
  }
  private reference = new THREE.Group();
  private motionGuide = new THREE.Group();
  private referenceTrees: THREE.Group[] = [];
  private referenceTreeHeight = 10;

  onPlayback = (_time: number, _duration: number, _playing: boolean) => {};
  get isAction(): boolean {
    return this.motion.getExecutionState() !== null;
  }
  onSelect = (_id: string | null) => {};
  constructor(
    private canvas: HTMLCanvasElement,
    private actorStage = false,
  ) {
    this.previewScene();
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas.parentElement!);
  }
  private previewScene(): void {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xe9eee5);
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
    this.scene.add(
      new THREE.GridHelper(
        PREVIEW_GROUND_SIZE,
        PREVIEW_GROUND_SIZE,
        0xa5b09a,
        0xcbd5c2,
      ),
    );
    if (this.actorStage) {
      this.reference = new THREE.Group();
      this.scene.add(this.reference);
      this.scene.add(this.motionGuide);
      const border = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(-PREVIEW_GROUND_HALF, 0.02, -PREVIEW_GROUND_HALF),
          new THREE.Vector3(PREVIEW_GROUND_HALF, 0.02, -PREVIEW_GROUND_HALF),
          new THREE.Vector3(PREVIEW_GROUND_HALF, 0.02, PREVIEW_GROUND_HALF),
          new THREE.Vector3(-PREVIEW_GROUND_HALF, 0.02, PREVIEW_GROUND_HALF),
        ]),
        new THREE.LineBasicMaterial({ color: 0x71894e }),
      );
      this.reference.add(border);
      void buildModelGroupWithNodes(referenceTree, { fidelity: true })
        .then((tree) => {
          if (this.disposed) {
            disposeObject(tree.group);
            return;
          }
          const bounds = new THREE.Box3().setFromObject(tree.group);
          const center = bounds.getCenter(new THREE.Vector3());
          const height = Math.max(bounds.getSize(new THREE.Vector3()).y, 0.01);
          this.referenceTrees = REFERENCE_TREE_POSITIONS.map(
            ([x, z], index) => {
              const model = index === 0 ? tree.group : tree.group.clone(true);
              const normalized = new THREE.Group();
              normalized.add(model);
              normalized.scale.setScalar(1 / height);
              normalized.position.set(
                -center.x / height,
                -bounds.min.y / height,
                -center.z / height,
              );
              const root = new THREE.Group();
              root.add(normalized);
              root.position.set(x, 0, z);
              root.scale.setScalar(this.referenceTreeHeight);
              this.reference.add(root);
              return root;
            },
          );
          this.refreshSurfaces();
        })
        .catch((error) => console.warn("参考树加载失败", error));
    }
    this.makeControls();
    this.controls.fit(
      new THREE.Box3(new THREE.Vector3(-3, 0, -3), new THREE.Vector3(3, 5, 3)),
    );
    if (this.actorStage) this.fit();
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
    this.sceneGeometry = null;
    this.surfaces.setSpace(mapSpace(resource.map), false);
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
    this.refreshSurfaces();
    if (this.actorStage) {
      visual.root.position.x = 4;
      const height = new THREE.Box3()
        .setFromObject(built.group)
        .getSize(new THREE.Vector3()).y;
      this.referenceTreeHeight = Math.max(10, height * 2);
      for (const tree of this.referenceTrees)
        tree.scale.setScalar(this.referenceTreeHeight);
    }
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
    v.motionPose = null;
    v.motionStep = "";
    if (this.viewer)
      v.built.group.position.copy(v.groundAnchor).multiplyScalar(-1);
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
    this.clearSceneGuide(id);
    this.visuals.delete(id);
  }
  private clearVisuals(): void {
    this.clearMotionGuide();
    for (const id of this.sceneGuides.keys()) this.clearSceneGuide(id);
    this.motion.reset();
    this.motionRequest = null;
    for (const v of this.visuals.values()) v.dispose();
    this.visuals.clear();
    this.refreshSurfaces();
  }
  executeAction(
    plan: MotionPlan,
    ctx: MotionContext,
    id: string,
    parameters: Record<string, Vec3> = {},
    replace = false,
    origin?: MotionOrigin,
  ): string {
    const v = this.visuals.get("preview");
    if (!v) throw new MotionError("MODEL_NOT_READY", "请等待模型加载完成");
    const start = origin?.position ?? (v.root.position.toArray() as Vec3),
      heading = origin?.heading ?? v.root.rotation.y;
    const executionId = this.motion.executeAction(
      plan,
      ctx,
      id,
      parameters,
      start,
      heading,
      replace,
    );
    this.showMotionGuide();
    this.motionRequest = {
      plan: structuredClone(plan),
      ctx: structuredClone(ctx),
      id,
      parameters: structuredClone(parameters),
      start,
      heading,
    };
    v.playing = false;
    v.stopped = false;
    v.motionStep = "";
    v.motionPose = null;
    v.transitionPose = null;
    v.built.group.position.copy(v.groundAnchor).multiplyScalar(-1);
    if (!this.active) this.motion.pauseExecution(executionId);
    this.sampleMotion(v);
    this.notify();
    return executionId;
  }
  setSceneGeometry(geometry: SceneGeometry | null): void {
    this.sceneGeometry = geometry;
    this.refreshSurfaces();
  }
  pointHeightLimits(): [number, number] {
    const map = this.viewer?.runtime.map,
      space = map ? mapSpace(map) : undefined;
    return space ? [space.min[1], space.max[1]] : [0, 100];
  }
  getFoundations(): Map<string, THREE.Group> {
    return this.viewer?.runtime.rendered?.objectGroups ?? new Map();
  }
  instanceSize(id: string): Vec3 {
    const v = this.visuals.get(id);
    if (!v) throw new Error("演员未加载");
    v.root.updateWorldMatrix(true, true);
    const b = new THREE.Box3().setFromObject(v.built.group);
    return b.getSize(new THREE.Vector3()).toArray() as Vec3;
  }
  applySceneFrame(id: string, frame: MotionFrame): void {
    const v = this.visuals.get(id);
    if (!v) return;
    v.playing = false;
    v.stopped = false;
    this.sampleMotion(v, frame);
  }
  resetSceneInstance(
    instance: ActorInstance,
    clip: AnimationClip | null,
  ): void {
    this.updateInstance(instance, clip);
    const v = this.visuals.get(instance.id);
    if (v) {
      v.motionPose = null;
      v.transitionPose = null;
      v.player.sample(null, 0);
      v.playing = false;
      v.time = 0;
    }
  }
  showSceneGuide(id: string, paths: Vec3[][]): void {
    this.clearSceneGuide(id);
    const group = new THREE.Group();
    group.userData.lifetimeHelper = true;
    for (const points of paths)
      if (points.length > 1)
        group.add(
          new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(
              points.map((p) => new THREE.Vector3(p[0], p[1] + 0.05, p[2])),
            ),
            new THREE.LineBasicMaterial({
              color: 0x2196d2,
              depthTest: false,
              transparent: true,
              opacity: 0.85,
            }),
          ),
        );
    this.scene.add(group);
    this.sceneGuides.set(id, group);
  }
  clearSceneGuide(id: string): void {
    const g = this.sceneGuides.get(id);
    if (g) {
      disposeObject(g);
      g.removeFromParent();
      this.sceneGuides.delete(id);
    }
  }
  focusInstance(id: string): void {
    const v = this.visuals.get(id);
    if (v) this.controls.fit(new THREE.Box3().setFromObject(v.root));
  }
  getMotionOrigin(): MotionOrigin {
    const v = this.visuals.get("preview");
    return {
      position: v ? (v.root.position.toArray() as Vec3) : [4, 0, 0],
      heading: v?.root.rotation.y ?? 0,
    };
  }
  invalidateAction(): void {
    this.motion.reset();
    this.motionRequest = null;
    this.clearMotionGuide();
    const v = this.visuals.get("preview");
    if (v) {
      v.playing = false;
      v.stopped = true;
      v.clip = null;
      v.time = 0;
    }
    this.notify();
  }
  private clearMotionGuide(): void {
    for (const child of [...this.motionGuide.children]) {
      disposeObject(child);
      this.motionGuide.remove(child);
    }
  }
  private showMotionGuide(): void {
    this.clearMotionGuide();
    for (const points of this.motion.getTrajectory()) {
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(
          points.map((p) => new THREE.Vector3(p[0], p[1] + 0.05, p[2])),
        ),
        new THREE.LineBasicMaterial({ color: 0x567d29 }),
      );
      this.motionGuide.add(line);
      const end = points.at(-1)!;
      const marker = new THREE.Mesh(
        new THREE.RingGeometry(0.5, 0.8, 24),
        new THREE.MeshBasicMaterial({
          color: 0x567d29,
          side: THREE.DoubleSide,
        }),
      );
      marker.rotation.x = -Math.PI / 2;
      marker.position.set(end[0], end[1] + 0.06, end[2]);
      this.motionGuide.add(marker);
    }
  }
  private sampleMotion(v: Visual, frame = this.motion.frame): void {
    if (!frame) return;
    if (v.motionStep !== frame.stepId) {
      v.transitionPose =
        v.motionPose ?? v.player.pose(null, 0, frame.rootHeight);
      v.motionStep = frame.stepId;
    }
    let pose = motionPose(v.player, frame);
    if (v.transitionPose && frame.transition < 1)
      pose = v.player.blend(v.transitionPose, pose, frame.transition);
    v.player.apply(pose);
    v.motionPose = pose;
    v.root.position.fromArray(frame.position);
    v.root.rotation.y = frame.heading;
    v.clip = frame.animation?.clip.clip ?? null;
    v.time = frame.animation?.time ?? 0;
  }
  setClip(clip: AnimationClip | null): void {
    this.clearMotionGuide();
    this.motion.reset();
    this.motionRequest = null;
    const v = this.visuals.get("preview");
    if (!v) return;
    v.built.group.position.set(0, 0, 0);
    v.root.position.set(this.actorStage ? 4 : 0, 0, 0);
    v.root.rotation.set(0, 0, 0);
    v.clip = clip;
    v.rate = 1;
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
  get playbackRate(): number {
    return this.visuals.get("preview")?.rate ?? 1;
  }
  setPlaybackRate(rate: number): void {
    if (!Number.isFinite(rate) || rate < 0.25 || rate > 3)
      throw new Error("播放倍率必须在 0.25～3 之间");
    const v = this.visuals.get("preview");
    if (v && !this.isAction) v.rate = rate;
    this.notify();
  }
  toggle(): void {
    const state = this.motion.getExecutionState();
    if (state) {
      if (state.status === "running")
        this.motion.pauseExecution(state.executionId);
      else if (state.status === "paused")
        this.motion.resumeExecution(state.executionId);
      else if (this.motionRequest) {
        const r = this.motionRequest,
          v = this.visuals.get("preview")!;
        v.root.position.fromArray(r.start);
        v.root.rotation.y = r.heading;
        this.executeAction(r.plan, r.ctx, r.id, r.parameters, true);
      }
      this.notify();
      return;
    }
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
    const state = this.motion.getExecutionState();
    if (state) {
      this.motion.cancelExecution(state.executionId);
      this.notify();
      return;
    }
    for (const v of this.visuals.values()) {
      v.playing = false;
      v.stopped = true;
      v.time = 0;
      v.player.sample(null, 0);
    }
    this.notify();
  }
  seek(time: number): void {
    const state = this.motion.getExecutionState();
    if (state) {
      this.motion.seekExecution(state.executionId, time);
      const v = this.visuals.get("preview");
      if (v) {
        v.transitionPose = null;
        v.motionPose = null;
        v.motionStep = this.motion.frame!.stepId;
        this.sampleMotion(v);
      }
      this.notify();
      return;
    }
    for (const v of this.visuals.values()) {
      v.stopped = false;
      v.time = Math.max(0, Math.min(time, v.clip?.duration ?? 0));
      v.player.sample(v.clip, v.time);
    }
    this.notify();
  }
  seekSceneFrame(id: string, frame: MotionFrame): void {
    const v = this.visuals.get(id);
    if (v) {
      v.transitionPose = null;
      v.motionPose = null;
      v.motionStep = frame.stepId;
      this.applySceneFrame(id, frame);
    }
  }
  fit(): void {
    const map = this.viewer?.runtime.map;
    if (map) {
      this.controls.fit(
        new THREE.Box3().setFromCenterAndSize(
          new THREE.Vector3(0, map.box.size[1] / 2, 0),
          new THREE.Vector3(...map.box.size),
        ),
      );
      return;
    }
    // Frame the actor itself; the ground and reference trees must not widen the shot.
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
      const state = this.motion.getExecutionState();
      if (state) this.motion.pauseExecution(state.executionId);
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
    this.onSceneFrame(dt);
    this.onFrame();
    const state = this.motion.getExecutionState();
    for (const [id, v] of this.visuals) {
      if (id === "preview" && state)
        v.materials.updateRuntimeUniforms(this.elapsed, this.camera);
      else if (v.motionPose)
        v.materials.updateRuntimeUniforms(this.elapsed, this.camera);
      else v.update(dt, this.elapsed, this.camera);
    }
    if (state) {
      this.motion.advance(dt);
      this.sampleMotion(this.visuals.get("preview")!);
      this.onMotionState();
    }
    if (this.viewer) this.viewer.tick(dt);
    else this.renderer.render(this.scene, this.camera);
    this.notify();
  };
  private notify(): void {
    const v = this.visuals.get("preview");
    const list = [...this.visuals.values()];
    this.onPlayback(
      this.motion.getExecutionState()?.elapsed ??
        v?.time ??
        Math.max(0, ...list.map((v) => v.time)),
      this.motion.getExecutionState()?.duration ??
        v?.clip?.duration ??
        Math.max(0, ...list.map((v) => v.clip?.duration ?? 0)),
      this.isAction
        ? this.motion.getExecutionState()?.status === "running"
        : list.some((v) => v.playing),
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
