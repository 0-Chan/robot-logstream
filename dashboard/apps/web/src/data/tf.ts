// Static TF tree (static/tf.json) -> relative transforms between sensor frames.
import { Matrix4, Quaternion, Vector3 } from "three";
import type { TfFile, Transform } from "@grandtour/protocol";

export function transformToMatrix(t: Pick<Transform, "translation" | "rotationXyzw">): Matrix4 {
  const [x, y, z, w] = t.rotationXyzw;
  return new Matrix4().compose(new Vector3(...t.translation), new Quaternion(x, y, z, w), new Vector3(1, 1, 1));
}

export class TfTree {
  private cache = new Map<string, Matrix4>();

  constructor(private readonly tf: TfFile) {}

  has(frame: string): boolean {
    return frame in this.tf.frames || this.isRoot(frame);
  }

  private isRoot(frame: string): boolean {
    return Object.values(this.tf.frames).some((t) => t.parent === frame) && !(frame in this.tf.frames);
  }

  /** T_root_frame, where root is the top of the frame's parent chain. */
  private fromRoot(frame: string): Matrix4 {
    const hit = this.cache.get(frame);
    if (hit) return hit;
    const t = this.tf.frames[frame];
    const m = t ? this.fromRoot(t.parent).clone().multiply(transformToMatrix(t)) : new Matrix4();
    this.cache.set(frame, m);
    return m;
  }

  /** T_from_to: maps points expressed in `to` into `from`. */
  relative(from: string, to: string): Matrix4 {
    return this.fromRoot(from).clone().invert().multiply(this.fromRoot(to));
  }
}
