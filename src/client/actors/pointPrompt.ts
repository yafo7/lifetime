import type { ActionPoint, PromptPart } from "../../shared/motion";
import type { AnimationClip } from "../../shared/contracts";
import { POINT_MIME } from "./scenePoints";
export const ANIMATION_MIME = "application/x-lifetime-animation";

/** Stores text and stable point references, never persisted HTML. */
export class PointPrompt {
  private range: Range | null = null;
  private suggestion = document.createElement("div");
  private match: { node: Text; start: number; end: number } | null = null;
  constructor(
    private box: HTMLElement,
    doc: PromptPart[],
    private points: ActionPoint[],
    private changed: (doc: PromptPart[]) => void,
    private clips: AnimationClip[] = [],
    private error: (message: string) => void = () => {},
  ) {
    box.replaceChildren(
      ...doc.map((p) =>
        p.type === "text"
          ? document.createTextNode(p.text)
          : p.type === "point"
            ? this.chip(p.pointId)
            : this.animationChip(p),
      ),
    );
    this.suggestion.className = "point-suggestions";
    box.after(this.suggestion);
    box.oninput = (e) => {
      this.capture();
      this.changed(this.read());
      if (!(e as InputEvent).isComposing) this.suggest();
    };
    box.onkeyup = () => this.capture();
    box.onmouseup = () => this.capture();
    box.onblur = () => this.capture();
    box.onkeydown = (e) => {
      if (e.isComposing) return;
      if (e.key === "Enter") {
        e.preventDefault();
        this.insertText("\n");
      }
      if (e.key === "Escape") this.suggestion.replaceChildren();
    };
    box.onpaste = (e) => {
      e.preventDefault();
      this.insertText(e.clipboardData?.getData("text/plain") ?? "");
    };
    box.ondragenter = box.ondragover = (e) => {
      if (
        e.dataTransfer?.types.some((t) =>
          [POINT_MIME, ANIMATION_MIME].includes(t),
        )
      ) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }
    };
    box.ondrop = (e) => {
      e.preventDefault();
      const id = e.dataTransfer?.getData(POINT_MIME);
      const caret = (
        document as Document & {
          caretRangeFromPoint?: (x: number, y: number) => Range;
        }
      ).caretRangeFromPoint?.(e.clientX, e.clientY);
      if (caret && box.contains(caret.startContainer)) this.range = caret;
      const animation = e.dataTransfer?.getData(ANIMATION_MIME);
      if (animation) {
        try {
          const p = JSON.parse(animation);
          if (
            !this.clips.some(
              (c) =>
                c.id === p.clipId && c.modelRevisionId === p.modelRevisionId,
            )
          )
            throw new Error();
          this.insertNode(
            this.animationChip({
              type: "animation",
              clipId: p.clipId,
              modelRevisionId: p.modelRevisionId,
            }),
          );
        } catch {
          this.error("这个动画不属于当前模型版本，请从当前动画库重新拖入。");
        }
      } else if (id) this.insert(id);
    };
  }
  private animationChip(
    part: Extract<PromptPart, { type: "animation" }>,
  ): HTMLElement {
    const span = document.createElement("span");
    const clip = this.clips.find(
      (c) => c.id === part.clipId && c.modelRevisionId === part.modelRevisionId,
    );
    span.className = `point-token animation-token${clip ? "" : " invalid"}`;
    span.contentEditable = "false";
    span.dataset.clipId = part.clipId;
    span.dataset.modelRevisionId = part.modelRevisionId;
    span.textContent = clip?.name ?? "失效动画";
    span.title = clip
      ? `${clip.name} · ${clip.duration.toFixed(2)} 秒`
      : "请重新拖入当前版本的动画";
    span.draggable = true;
    span.ondragstart = (e) => {
      e.dataTransfer?.setData(ANIMATION_MIME, JSON.stringify(part));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
    };
    return span;
  }
  private chip(id: string): HTMLElement {
    const span = document.createElement("span");
    span.className = "point-token";
    span.contentEditable = "false";
    span.dataset.pointId = id;
    span.textContent = this.points.find((p) => p.id === id)?.name ?? "失效标点";
    span.draggable = true;
    span.ondragstart = (e) => {
      e.dataTransfer?.setData(POINT_MIME, id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "copyMove";
    };
    return span;
  }
  private capture(): void {
    const selection = window.getSelection();
    if (
      selection?.rangeCount &&
      this.box.contains(selection.anchorNode) &&
      this.box.contains(selection.focusNode)
    )
      this.range = selection.getRangeAt(0).cloneRange();
  }
  private insertNode(node: Node): void {
    this.box.focus();
    const range =
      this.range && this.box.contains(this.range.startContainer)
        ? this.range
        : document.createRange();
    if (!this.range || !this.box.contains(range.startContainer)) {
      range.selectNodeContents(this.box);
      range.collapse(false);
    }
    const parent =
      range.startContainer instanceof Element
        ? range.startContainer
        : range.startContainer.parentElement;
    const token = parent?.closest(".point-token");
    if (token && this.box.contains(token)) {
      range.setStartAfter(token);
      range.collapse(true);
    }
    range.deleteContents();
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    this.range = range.cloneRange();
    this.changed(this.read());
    this.suggestion.replaceChildren();
  }
  insert(id: string): void {
    if (this.points.some((p) => p.id === id)) this.insertNode(this.chip(id));
  }
  private insertText(text: string): void {
    this.insertNode(document.createTextNode(text));
  }
  private suggest(): void {
    this.suggestion.replaceChildren();
    this.match = null;
    const r = this.range;
    if (!r?.collapsed || r.startContainer.nodeType !== Node.TEXT_NODE) return;
    const text = r.startContainer.textContent!.slice(0, r.startOffset),
      match = text.match(/(?:@([p\d]*)|\b(p\d+))$/);
    if (!match) return;
    this.match = {
      node: r.startContainer as Text,
      start: r.startOffset - match[0].length,
      end: r.startOffset,
    };
    const query = match[1] ?? match[2];
    for (const p of this.points.filter((p) => p.name.startsWith(query))) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `插入 ${p.name}`;
      button.onmousedown = (e) => e.preventDefault();
      button.onclick = () => {
        const m = this.match;
        if (m) {
          const r = document.createRange();
          r.setStart(m.node, m.start);
          r.setEnd(m.node, m.end);
          this.range = r;
        }
        this.insert(p.id);
      };
      this.suggestion.append(button);
    }
  }
  read(): PromptPart[] {
    const parts: PromptPart[] = [];
    const text = (value: string) => {
      if (!value) return;
      const last = parts.at(-1);
      if (last?.type === "text") last.text += value;
      else parts.push({ type: "text", text: value });
    };
    const visit = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        text(node.textContent ?? "");
        return;
      }
      if (!(node instanceof HTMLElement)) return;
      if (node.dataset.clipId) {
        parts.push({
          type: "animation",
          clipId: node.dataset.clipId,
          modelRevisionId: node.dataset.modelRevisionId ?? "",
        });
        return;
      }
      if (node.dataset.pointId) {
        parts.push({ type: "point", pointId: node.dataset.pointId });
        return;
      }
      if (node.tagName === "BR") {
        text("\n");
        return;
      }
      if (["DIV", "P"].includes(node.tagName) && parts.length) text("\n");
      node.childNodes.forEach(visit);
    };
    this.box.childNodes.forEach(visit);
    return parts;
  }
}
