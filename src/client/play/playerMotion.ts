import type { Vec3 } from "../../shared/motion";

export interface PlayerSurface {
  move(from: Vec3, to: Vec3): Vec3;
}
export interface PlayerFrame {
  position: Vec3;
  heading: number;
  moving: boolean;
  airborne: boolean;
  jumpPhase: number;
}
/** Local character motor. Input and render animations cannot move the collision position. */
export class PlayerMotion {
  private support: Vec3;
  private position: Vec3;
  private heading: number;
  private velocity = 0;
  private jumpTime = 0;
  private airborne = false;
  private moving = false;
  private jumpQueued = false;
  readonly speed = 4;
  private readonly gravity: number;
  constructor(
    private surface: PlayerSurface,
    start: Vec3,
    heading = 0,
    readonly jumpDuration = 1.1,
    private ceiling: (ground: Vec3) => number = () => Infinity,
    private canMove: (from: Vec3, to: Vec3) => boolean = () => true,
  ) {
    this.support = [...start];
    this.position = [...start];
    this.heading = heading;
    this.gravity = (8 * 1.35) / (jumpDuration * jumpDuration);
  }
  jump(): void {
    if (!this.airborne) this.jumpQueued = true;
  }
  clearInput(): void {
    this.jumpQueued = false;
    this.moving = false;
  }
  update(seconds: number, x: number, z: number): PlayerFrame {
    const dt = Math.max(0, Math.min(seconds, 0.1));
    const length = Math.hypot(x, z);
    if (length > 1) {
      x /= length;
      z /= length;
    }
    if (this.jumpQueued && !this.airborne) {
      this.airborne = true;
      this.velocity = (this.gravity * this.jumpDuration) / 2;
      this.jumpTime = 0;
    }
    this.jumpQueued = false;
    const count = Math.max(1, Math.ceil(dt / (1 / 60))),
      step = dt / count;
    let distance = 0;
    for (let i = 0; i < count; i++) {
      const previous = this.support,
        previousPosition: Vec3 = [...this.position],
        wasAirborne = this.airborne;
      if (x || z)
        this.support = this.surface.move(previous, [
          previous[0] + x * this.speed * step,
          previous[1],
          previous[2] + z * this.speed * step,
        ]);
      this.position[0] = this.support[0];
      this.position[2] = this.support[2];
      if (this.airborne) {
        this.jumpTime += step;
        this.position[1] +=
          this.velocity * step - (this.gravity * step * step) / 2;
        this.velocity -= this.gravity * step;
        const top = this.ceiling(this.support);
        if (this.position[1] > top) {
          this.position[1] = top;
          this.velocity = Math.min(0, this.velocity);
        }
        if (this.position[1] <= this.support[1] && this.velocity <= 0) {
          this.position[1] = this.support[1];
          this.velocity = 0;
          this.airborne = false;
        }
      } else this.position[1] = this.support[1];
      if (!this.canMove(previousPosition, this.position)) {
        // Keep gravity/jump progress when horizontal movement hits an NPC.
        this.support = previous;
        this.position[0] = previousPosition[0];
        this.position[2] = previousPosition[2];
        if (!this.canMove(previousPosition, this.position)) {
          this.position = previousPosition;
          this.velocity = 0;
          this.airborne = wasAirborne;
        }
      }
      distance += Math.hypot(
        this.position[0] - previousPosition[0],
        this.position[2] - previousPosition[2],
      );
    }
    this.moving = distance > 0.0001;
    if (length > 0.01) this.heading = Math.atan2(x, z);
    return this.frame;
  }
  get frame(): PlayerFrame {
    return {
      position: [...this.position],
      heading: this.heading,
      moving: this.moving,
      airborne: this.airborne,
      jumpPhase: Math.min(1, this.jumpTime / this.jumpDuration),
    };
  }
}
