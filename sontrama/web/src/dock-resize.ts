/** Resize dock items without scaling their contents or persisting every move. */
export class DockResizeInteractions {
  private gesture: {
    handle: HTMLElement;
    item: HTMLElement;
    pointer: number;
    x: number;
    width: number;
    original: number;
    next: number;
    id: string;
  } | null = null;

  constructor(
    private root: HTMLElement,
    private save: (id: string, width: number) => void,
  ) {
    root.addEventListener("pointerdown", (event) => {
      const handle = (event.target as Element).closest<HTMLElement>(
        "[data-dock-resize]",
      );
      if (!handle || event.button !== 0 || !event.isPrimary) return;
      this.cancel();
      const item = handle.closest<HTMLElement>(".dock-item")!;
      const id = handle.dataset.dockResize!;
      const original = Number(item.dataset.dockWidth);
      this.gesture = {
        handle,
        item,
        pointer: event.pointerId,
        x: event.clientX,
        width: item.getBoundingClientRect().width,
        original,
        next: original,
        id,
      };
      handle.setPointerCapture(event.pointerId);
      handle.focus({ preventScroll: true });
      event.preventDefault();
    });
    root.addEventListener("pointermove", (event) => {
      const gesture = this.gesture;
      if (
        !gesture ||
        gesture.pointer !== event.pointerId ||
        Math.abs(event.clientX - gesture.x) < 4
      )
        return;
      gesture.next = this.clamp(
        gesture.item,
        Math.round((gesture.width + event.clientX - gesture.x) / 20) * 20,
      );
      gesture.item.style.setProperty("--dock-item-width", `${gesture.next}px`);
      gesture.item.classList.add("dock-resizing");
    });
    root.addEventListener("pointerup", (event) => {
      if (event.pointerId === this.gesture?.pointer) this.finish(true);
    });
    for (const kind of ["pointercancel", "lostpointercapture"])
      root.addEventListener(kind, (event) => {
        if ((event as PointerEvent).pointerId === this.gesture?.pointer)
          this.cancel();
      });
    root.addEventListener("keydown", (event) => {
      const handle = (event.target as Element).closest<HTMLElement>(
        "[data-dock-resize]",
      );
      if (
        !handle ||
        !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      const id = handle.dataset.dockResize!;
      const current = Number(
        handle.closest<HTMLElement>(".dock-item")!.dataset.dockWidth,
      );
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? 2000
            : current + (event.key === "ArrowLeft" ? -20 : 20);
      this.save(
        id,
        this.clamp(handle.closest<HTMLElement>(".dock-item")!, next),
      );
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.gesture) {
        event.preventDefault();
        this.cancel();
      }
    });
    window.addEventListener("blur", () => this.cancel());
    window.addEventListener("resize", () => this.cancel());
  }

  private clamp(item: HTMLElement, width: number) {
    const content = this.root.querySelector<HTMLElement>(".dock-content")!;
    const bounds = content.getBoundingClientRect();
    const padding = parseFloat(getComputedStyle(content).paddingRight) || 0;
    const available = Math.floor(
      Math.min(innerWidth, bounds.right) -
        padding -
        item.getBoundingClientRect().left,
    );
    const keyboard = item.dataset.widget === "keyboard";
    return Math.max(
      keyboard ? 460 : 220,
      Math.min(keyboard ? 1200 : 800, available, width),
    );
  }

  cancel() {
    this.finish(false);
  }
  private finish(commit: boolean) {
    const gesture = this.gesture;
    if (!gesture) return;
    this.gesture = null;
    gesture.item.style.setProperty(
      "--dock-item-width",
      `${gesture.original}px`,
    );
    gesture.item.classList.remove("dock-resizing");
    if (gesture.handle.hasPointerCapture(gesture.pointer))
      gesture.handle.releasePointerCapture(gesture.pointer);
    if (commit && gesture.original !== gesture.next)
      this.save(gesture.id, gesture.next);
  }
}
