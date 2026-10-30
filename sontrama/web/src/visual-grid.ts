/** Pointer interactions only preview layout; persistence runs once on release. */
type Size = { width: 1 | 2 | 3; height: 160 | 240 | 320 };
type Gesture = {
  handle: HTMLElement;
  card: HTMLElement;
  pointer: number;
  kind: "move" | "resize";
  x: number;
  y: number;
  scroll: number;
  currentX: number;
  currentY: number;
  started: boolean;
  original: Size;
  size: Size;
  target?: HTMLElement;
  before: boolean;
  dockX: number;
  dockScroll: number;
  ghost?: HTMLElement;
};

export class VisualGridInteractions {
  private gesture: Gesture | null = null;
  private animation = 0;

  constructor(
    private root: HTMLElement,
    private move: (
      id: string,
      target: string,
      before: boolean,
      x?: number,
    ) => void,
    private resize: (id: string, size: Size) => void,
    private itemSelector = ".visual-widget",
    private scrollPage = true,
    private placement?: (
      id: string | null,
      target: string,
      before: boolean,
      x?: number,
    ) => void,
  ) {
    root.addEventListener("pointerdown", (event) => {
      const handle = (event.target as Element).closest<HTMLElement>(
        "[data-grid-handle]",
      );
      if (!handle || event.button !== 0 || !event.isPrimary) return;
      const card = handle.closest<HTMLElement>(this.itemSelector)!;
      const original = {
        width: Number(card.dataset.width ?? 1),
        height: Number(card.dataset.height ?? 160),
      } as Size;
      this.cancel();
      this.gesture = {
        handle,
        card,
        pointer: event.pointerId,
        kind: handle.dataset.gridHandle as Gesture["kind"],
        x: event.clientX,
        y: event.clientY,
        currentX: event.clientX,
        currentY: event.clientY,
        scroll: window.scrollY,
        started: false,
        original,
        size: { ...original },
        before: false,
        dockX:
          card.getBoundingClientRect().left -
          card.parentElement!.getBoundingClientRect().left -
          (parseFloat(getComputedStyle(card.parentElement!).paddingLeft) || 0) +
          card.parentElement!.scrollLeft,
        dockScroll: card.parentElement!.scrollLeft,
      };
      handle.setPointerCapture(event.pointerId);
      handle.focus({ preventScroll: true });
      event.preventDefault();
    });
    root.addEventListener("pointermove", (event) => {
      const gesture = this.gesture;
      if (!gesture || event.pointerId !== gesture.pointer) return;
      gesture.currentX = event.clientX;
      gesture.currentY = event.clientY;
      if (
        !gesture.started &&
        Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 5
      )
        return;
      if (!gesture.started) {
        gesture.started = true;
        this.root.classList.add("layout-reordering");
        gesture.card.classList.add("grid-editing");
        document.body.classList.add("grid-interacting");
        if (gesture.kind === "move" && this.scrollPage) {
          gesture.ghost = document.createElement("div");
          gesture.ghost.className = "visual-drag-ghost";
          gesture.ghost.textContent =
            gesture.card.querySelector("h3")!.textContent;
          gesture.ghost.setAttribute("aria-hidden", "true");
          document.body.append(gesture.ghost);
        }
        this.animation = requestAnimationFrame(() => this.tick());
      }
      this.preview();
    });
    root.addEventListener("pointerup", (event) => {
      if (event.pointerId === this.gesture?.pointer) this.finish(true);
    });
    for (const event of ["pointercancel", "lostpointercapture"])
      root.addEventListener(event, (event) => {
        if ((event as PointerEvent).pointerId === this.gesture?.pointer)
          this.cancel();
      });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.gesture) {
        event.preventDefault();
        this.cancel();
      }
    });
    root.addEventListener("keydown", (event) => {
      const handle = (event.target as Element).closest<HTMLElement>(
        "[data-grid-handle]",
      );
      if (
        !handle ||
        !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      const card = handle.closest<HTMLElement>(this.itemSelector)!;
      const id = card.dataset.widget!;
      const earlier = event.key === "ArrowUp" || event.key === "ArrowLeft";
      if (handle.dataset.gridHandle === "move") {
        const neighbor = earlier
          ? card.previousElementSibling
          : card.nextElementSibling;
        if (neighbor)
          this.move(id, (neighbor as HTMLElement).dataset.widget!, earlier);
      } else {
        const width = Number(card.dataset.width),
          height = Number(card.dataset.height);
        this.resize(id, {
          width: Math.max(
            1,
            Math.min(
              3,
              width +
                (event.key === "ArrowLeft"
                  ? -1
                  : event.key === "ArrowRight"
                    ? 1
                    : 0),
            ),
          ) as Size["width"],
          height: Math.max(
            160,
            Math.min(
              320,
              height +
                (event.key === "ArrowUp"
                  ? -80
                  : event.key === "ArrowDown"
                    ? 80
                    : 0),
            ),
          ) as Size["height"],
        });
      }
    });
    window.addEventListener("blur", () => this.cancel());
    window.addEventListener("resize", () => this.cancel());
  }

  cancel() {
    this.finish(false);
  }

  private tick() {
    const gesture = this.gesture;
    if (!gesture?.started) return;
    if (!this.scrollPage) {
      const container = gesture.card.parentElement!;
      const box = container.getBoundingClientRect();
      const speed =
        gesture.currentX < box.left + 32
          ? -10
          : gesture.currentX > box.right - 32
            ? 10
            : 0;
      if (speed) {
        container.scrollBy(speed, 0);
        this.preview();
      }
      this.animation = requestAnimationFrame(() => this.tick());
      return;
    }
    const bottom =
      document.querySelector(".bottom-dock")?.getBoundingClientRect().top ??
      innerHeight;
    const speed =
      gesture.currentY < 60 ? -12 : gesture.currentY > bottom - 40 ? 12 : 0;
    if (speed) {
      window.scrollBy(0, speed);
      this.preview();
    }
    this.animation = requestAnimationFrame(() => this.tick());
  }

  private preview() {
    const gesture = this.gesture!;
    const grid = gesture.card.parentElement!;
    const box = grid.getBoundingClientRect();
    if (gesture.kind === "resize") {
      const styles = getComputedStyle(grid);
      const columns = styles.gridTemplateColumns.split(" ").length;
      const gap = parseFloat(styles.columnGap) || 0;
      const column = (box.width + gap) / columns;
      gesture.size.width =
        columns === 1
          ? gesture.original.width
          : (Math.max(
              1,
              Math.min(
                3,
                Math.round(
                  gesture.original.width +
                    (gesture.currentX - gesture.x) / column,
                ),
              ),
            ) as Size["width"]);
      gesture.size.height = Math.max(
        160,
        Math.min(
          320,
          160 +
            Math.round(
              (gesture.original.height -
                160 +
                gesture.currentY -
                gesture.y +
                window.scrollY -
                gesture.scroll) /
                80,
            ) *
              80,
        ),
      ) as Size["height"];
      gesture.card.style.setProperty(
        "--visual-width",
        String(gesture.size.width),
      );
      gesture.card.style.setProperty(
        "--visual-height",
        `${gesture.size.height}px`,
      );
    } else {
      try {
        if (gesture.ghost)
          gesture.ghost.style.transform = `translate(${gesture.currentX + 12}px, ${gesture.currentY + 12}px)`;
        gesture.target?.removeAttribute("data-drop");
        gesture.target = undefined;
        if (
          gesture.currentX < box.left ||
          gesture.currentX > box.right ||
          gesture.currentY < box.top ||
          gesture.currentY > box.bottom
        )
          return;
        const own = gesture.card.getBoundingClientRect();
        if (
          gesture.currentX >= own.left &&
          gesture.currentX <= own.right &&
          gesture.currentY >= own.top &&
          gesture.currentY <= own.bottom
        )
          return;
        const cards = [
          ...grid.querySelectorAll<HTMLElement>(this.itemSelector),
        ].filter((card) => card !== gesture.card);
        let nearest = Infinity;
        for (const card of cards) {
          const rect = card.getBoundingClientRect();
          const distance = Math.hypot(
            Math.max(
              rect.left - gesture.currentX,
              0,
              gesture.currentX - rect.right,
            ),
            Math.max(
              rect.top - gesture.currentY,
              0,
              gesture.currentY - rect.bottom,
            ),
          );
          if (distance < nearest) {
            nearest = distance;
            gesture.target = card;
          }
        }
        if (gesture.target) {
          const target = gesture.target.getBoundingClientRect();
          const origin = gesture.card.getBoundingClientRect();
          gesture.before =
            Math.abs(target.top - origin.top) < 8
              ? gesture.currentX < target.left + target.width / 2
              : gesture.currentY < target.top + target.height / 2;
          if (this.scrollPage)
            gesture.target.dataset.drop = gesture.before ? "before" : "after";
        }
      } finally {
        if (this.placement) {
          const x = this.dropPosition(gesture);
          this.placement(
            gesture.card.dataset.widget!,
            gesture.target?.dataset.widget ?? "",
            gesture.before,
            x,
          );
        }
      }
    }
  }

  private dropPosition(gesture: Gesture) {
    const container = gesture.card.parentElement!;
    const bounds = container.getBoundingClientRect();
    if (
      gesture.currentY < bounds.top ||
      gesture.currentY > bounds.bottom ||
      gesture.currentX < bounds.left ||
      gesture.currentX > bounds.right
    )
      return undefined;
    const padding = parseFloat(getComputedStyle(container).paddingLeft) || 0;
    const width = gesture.card.getBoundingClientRect().width;
    const x = Math.max(
      container.scrollLeft,
      Math.min(
        container.scrollLeft + bounds.width - padding * 2 - width,
        gesture.dockX +
          gesture.currentX -
          gesture.x +
          container.scrollLeft -
          gesture.dockScroll,
      ),
    );
    return Math.min(16384, Math.round(x / 20) * 20);
  }

  private finish(commit: boolean) {
    const gesture = this.gesture;
    if (!gesture) return;
    const dropX = !this.scrollPage ? this.dropPosition(gesture) : undefined;
    this.gesture = null;
    this.placement?.(null, "", false);
    this.root.classList.remove("layout-reordering");
    cancelAnimationFrame(this.animation);
    gesture.ghost?.remove();
    gesture.target?.removeAttribute("data-drop");
    gesture.card.classList.remove("grid-editing");
    gesture.card.style.setProperty(
      "--visual-width",
      String(gesture.original.width),
    );
    gesture.card.style.setProperty(
      "--visual-height",
      `${gesture.original.height}px`,
    );
    document.body.classList.remove("grid-interacting");
    if (gesture.handle.hasPointerCapture(gesture.pointer))
      gesture.handle.releasePointerCapture(gesture.pointer);
    if (!commit || !gesture.started) return;
    const id = gesture.card.dataset.widget!;
    if (gesture.kind === "move") {
      if (!this.scrollPage) {
        if (dropX === undefined) return;
        this.move(
          id,
          gesture.target?.dataset.widget ?? "",
          gesture.before,
          dropX,
        );
      } else if (gesture.target)
        this.move(id, gesture.target.dataset.widget!, gesture.before);
    }
    if (
      gesture.kind === "resize" &&
      (gesture.size.width !== gesture.original.width ||
        gesture.size.height !== gesture.original.height)
    )
      this.resize(id, gesture.size);
  }
}
