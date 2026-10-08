import type { SceneBuildCoordinator } from "../scene/buildCoordinator";
import { escape, select } from "../ui";

export class SceneRequestPanel {
  private enabled = false;
  constructor(
    private host: HTMLElement,
    private coordinator: SceneBuildCoordinator,
    private generate: (
      request: string,
      climb: number,
      retry: boolean,
    ) => Promise<void>,
    private open: (id: string) => Promise<void>,
    private notify: (text: string) => void,
  ) {
    host.innerHTML = `<div class="panel-heading"><h3>一句话构建场景</h3></div><label class="lifetime-field"><span>场景要求</span><textarea data-scene-request aria-label="场景要求" rows="4" placeholder="让蜘蛛鸭绕池塘跑步，每跑一圈去桥中央跳舞、后空翻，再返回继续跑。"></textarea></label><p class="lifetime-help">使用已有演员和动画，自动标点、绑定动作和状态。每次构建保存一个新的演出版本。</p><details><summary>新角色通行设置</summary><label class="lifetime-field"><span>允许台阶高度（世界单位）</span><input data-scene-climb aria-label="新角色台阶高度" type="number" min="0" max="5" step=".1" value=".3"/></label><p class="lifetime-help">已有角色保留原通行参数；不会为了上桥自动提高能力。</p></details><div class="toolbar-actions"><button data-scene-generate class="lifetime-primary">生成场景</button><button data-scene-cancel class="secondary small" hidden>停止等待</button><button data-scene-retry class="secondary small" hidden>继续构建</button></div><p data-scene-build-status class="lifetime-help" role="status"></p><div data-scene-build-details></div>`;
    const run = (retry: boolean) => {
      const climb = select<HTMLInputElement>(
        host,
        "[data-scene-climb]",
      ).valueAsNumber;
      if (!Number.isFinite(climb) || climb < 0 || climb > 5) {
        notify("台阶高度必须在0–5之间");
        return;
      }
      void generate(
        select<HTMLTextAreaElement>(host, "[data-scene-request]").value,
        climb,
        retry,
      ).catch((e) => notify(e instanceof Error ? e.message : String(e)));
    };
    select<HTMLButtonElement>(host, "[data-scene-generate]").onclick = () =>
      run(false);
    select<HTMLButtonElement>(host, "[data-scene-retry]").onclick = () =>
      run(true);
    select<HTMLButtonElement>(host, "[data-scene-cancel]").onclick = () =>
      coordinator.cancel();
    select<HTMLTextAreaElement>(host, "[data-scene-request]").value =
      coordinator.record?.request ?? "";
    this.render();
  }
  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    this.render();
  }
  render() {
    const { record, busy } = this.coordinator;
    select<HTMLButtonElement>(this.host, "[data-scene-generate]").disabled =
      !this.enabled || busy;
    select<HTMLTextAreaElement>(this.host, "[data-scene-request]").disabled =
      busy;
    select<HTMLInputElement>(this.host, "[data-scene-climb]").disabled = busy;
    select<HTMLElement>(this.host, "[data-scene-cancel]").hidden = !busy;
    const retry = select<HTMLButtonElement>(this.host, "[data-scene-retry]");
    retry.hidden = busy || !record?.plan || record.phase === "ready";
    retry.disabled = !this.enabled;
    select(this.host, "[data-scene-build-status]").textContent = record
      ? [record.status, record.warning].filter(Boolean).join("。 ")
      : this.enabled
        ? "输入要求后自动构建；不会生成缺失模型或动画。"
        : "先打开一张地图。";
    const details = select(this.host, "[data-scene-build-details]");
    details.innerHTML = record?.plan
      ? `<details><summary>规划结果 · ${record.plan.actors.length} 个角色</summary>${record.plan.actors.map((a) => `<p class="lifetime-help"><b>${escape(a.name)}</b>：${a.states.map((s) => escape(s.name)).join(" → ")}</p>`).join("")}</details>${record.performanceId ? '<button data-scene-result class="secondary small">打开已保存结果</button>' : ""}`
      : "";
    const result = details.querySelector<HTMLButtonElement>(
      "[data-scene-result]",
    );
    if (result)
      result.onclick = () =>
        void this.open(record!.performanceId!).catch((e) =>
          this.notify(String(e)),
        );
  }
}
