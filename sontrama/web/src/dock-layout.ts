import type { VisualizationSettings } from "./visualizations";

export interface DockCell {
  column: number;
  span: number;
  row: number;
  width: number;
}
export function moveDock(
  settings: VisualizationSettings,
  id: string,
  target: string,
  before: boolean,
  x?: number,
) {
  settings.dock_positions[id] = x ?? null;
  const order = settings.dock_order;
  if (id === target || !order.includes(id) || !order.includes(target)) return;
  order.splice(order.indexOf(id), 1);
  order.splice(order.indexOf(target) + (before ? 0 : 1), 0, id);
}

/** The committed layout and placement preview must use exactly the same packing. */
export function dockLayout(
  settings: VisualizationSettings,
  widths: Map<string, number>,
  available: number,
) {
  const plan = new Map<string, DockCell>();
  const step = available / 24;
  const occupied: [number, number][] = [];
  for (const id of settings.dock_order) {
    const requested = widths.get(id);
    if (requested === undefined) continue;
    const width = Math.min(requested, available);
    const span = Math.max(1, Math.min(24, Math.ceil(width / step)));
    const position = settings.dock_positions[id];
    let start =
      position === undefined || position === null
        ? 0
        : Math.max(0, Math.round(position / step));
    while (true) {
      const collisions = occupied.filter(
        ([left, right]) => start < right && start + span > left,
      );
      if (!collisions.length) break;
      start = Math.max(...collisions.map(([, right]) => right));
    }
    occupied.push([start, start + span]);
    plan.set(id, { column: start + 1, span, row: 1, width });
  }
  return plan;
}
