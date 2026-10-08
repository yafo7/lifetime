import type { Actor } from "../../shared/contracts";
import type { ActionTemplate } from "../../shared/actionTemplates";
import { escape, select } from "../ui";

export function mountActionTemplatePanel(
  host: HTMLElement,
  actor: Actor,
  revision: string,
  create: (kind: ActionTemplate, move: string, performances: string[]) => void,
) {
  const clips = actor.animations.filter((c) => c.modelRevisionId === revision);
  const options = clips
    .map((c) => `<option value="${escape(c.id)}">${escape(c.name)}</option>`)
    .join("");
  host.innerHTML = `<details><summary>用已有动画创建基础动作（本地）</summary><p class="lifetime-help">动作在演员层制作，预览标点在 Play 中绑定实际地图位置。</p>
    <label class="lifetime-field"><span>动作模板</span><select data-template-kind aria-label="基础动作模板"><option value="route">沿标点路线移动并返回入口</option><option value="visit">前往表演、面向目标并返回</option><option value="stationary">原地表演</option></select></label>
    <label class="lifetime-field"><span>移动动画</span><select data-template-move aria-label="模板移动动画">${options}</select></label>
    <label class="lifetime-field"><span>表演动画（按添加顺序播放）</span><select data-template-clip aria-label="模板表演动画">${options}</select></label><button data-template-add class="secondary small">＋ 添加表演动画</button><div data-template-performances></div>
    <button data-template-create class="secondary">创建动作草稿</button></details>`;
  const selected: string[] = [];
  const list = select(host, "[data-template-performances]");
  const render = () => {
    list.innerHTML = selected
      .map(
        (id, i) =>
          `<div class="toolbar-actions"><span>${i + 1} · ${escape(clips.find((c) => c.id === id)!.name)}</span><button class="small" data-remove-performance="${i}">移除</button></div>`,
      )
      .join("");
    list
      .querySelectorAll<HTMLButtonElement>("[data-remove-performance]")
      .forEach(
        (b) =>
          (b.onclick = () => {
            selected.splice(Number(b.dataset.removePerformance), 1);
            render();
          }),
      );
  };
  select<HTMLButtonElement>(host, "[data-template-add]").onclick = () => {
    if (selected.length < 90)
      selected.push(
        select<HTMLSelectElement>(host, "[data-template-clip]").value,
      );
    render();
  };
  select<HTMLButtonElement>(host, "[data-template-create]").onclick = () =>
    create(
      select<HTMLSelectElement>(host, "[data-template-kind]")
        .value as ActionTemplate,
      select<HTMLSelectElement>(host, "[data-template-move]").value,
      selected,
    );
}
