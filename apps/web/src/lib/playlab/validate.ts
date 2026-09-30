import type { PlayLabConfig } from "@/lib/contracts";
import type { Point } from "@/lib/tracking/geometry";

/**
 * PlayLab edit validation against supplied bounds only (§10): field bounds,
 * the model-configured displacement radius, and supplied half-plane
 * constraints. Returns a reason when invalid. Shared by the UI and the fixture
 * so the same rule applies on both sides of the contract.
 */
export function validateEdit(config: PlayLabConfig, original: Point, proposed: Point): string | null {
  const b = config.field_bounds;
  if (proposed.x < b.x_min || proposed.x > b.x_max || proposed.y < b.y_min || proposed.y > b.y_max) return "Outside the field.";
  if (config.max_displacement_yd !== null && Math.hypot(proposed.x - original.x, proposed.y - original.y) > config.max_displacement_yd + 1e-6) {
    return `More than ${config.max_displacement_yd.toFixed(1)} yd from the source position.`;
  }
  for (const h of config.constraints) {
    if (h.nx * proposed.x + h.ny * proposed.y < h.c - 1e-6) return `${h.description}.`;
  }
  return null;
}
