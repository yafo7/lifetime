import { ActorsWorkspace } from "./actors/workspace";
import { PlayWorkspace } from "./play/workspace";
import { Jobs, message } from "./services/jobs";
import { select } from "./ui";
export async function startApp(host: HTMLElement): Promise<void> {
  host.className = "lifetime-app";
  host.innerHTML = /* HTML */ `<main class="lifetime-shell">
    <header class="lifetime-topbar">
      <div class="lifetime-brand">
        <span class="lifetime-brand-mark">L</span
        ><span><strong>Lifetime</strong><small>ACTORS · PLAY</small></span>
      </div>
      <nav class="lifetime-nav" aria-label="Lifetime 工作区">
        <button data-workspace="actors" class="active" aria-current="page">
          <b>Actors</b><span>演员休息厅</span></button
        ><button data-workspace="play"><b>Play</b><span>演出区域</span></button>
      </nav>
      <div class="lifetime-task-indicator" data-task>无进行中的任务</div>
    </header>
    <div class="lifetime-workspaces">
      <section data-panel="actors" class="lifetime-workspace"></section>
      <section data-panel="play" class="lifetime-workspace" hidden></section>
    </div>
    <div
      class="notification"
      role="status"
      aria-live="polite"
      data-notification
      hidden
    >
      <span></span><button aria-label="关闭提示">×</button>
    </div>
  </main>`;
  const notify = (text: string) => {
    const box = select<HTMLElement>(host, "[data-notification]");
    box.hidden = false;
    select(box, "span").textContent = text;
  };
  select<HTMLButtonElement>(host, "[data-notification] button").onclick = () =>
    (select<HTMLElement>(host, "[data-notification]").hidden = true);
  const jobs = new Jobs(),
    actors = new ActorsWorkspace(
      select(host, '[data-panel="actors"]'),
      jobs,
      notify,
    ),
    play = new PlayWorkspace(select(host, '[data-panel="play"]'), notify);
  const update = () => {
    const active = jobs.items.filter(
      (j) => j.state === "running" || j.state === "saving",
    );
    const count = active.length + (play.busy ? 1 : 0);
    select(host, "[data-task]").textContent = count
      ? `${count} 个任务进行中`
      : jobs.items.some((j) => j.state === "save-failed")
        ? "有生成结果等待保存"
        : "无进行中的任务";
    actors.renderJobs();
  };
  let completedCount = 0;
  jobs.onChange = () => {
    update();
    const completed = jobs.items.filter((job) => job.state === "done").length;
    if (completed !== completedCount) {
      completedCount = completed;
      void play
        .resourcesChanged()
        .catch((error) =>
          notify(`资源已保存，演出列表刷新失败：${message(error)}`),
        );
    }
  };
  const timer = setInterval(update, 1000);
  host.querySelectorAll<HTMLButtonElement>("[data-workspace]").forEach(
    (b) =>
      (b.onclick = () => {
        const name = b.dataset.workspace;
        host
          .querySelectorAll<HTMLElement>("[data-panel]")
          .forEach((p) => (p.hidden = p.dataset.panel !== name));
        host.querySelectorAll("[data-workspace]").forEach((tab) => {
          tab.classList.toggle("active", tab === b);
          if (tab === b) tab.setAttribute("aria-current", "page");
          else tab.removeAttribute("aria-current");
        });
        actors.setActive(name === "actors");
        play.setActive(name === "play");
      }),
  );
  actors.setActive(true);
  window.addEventListener("beforeunload", (event) => {
    if (jobs.busy || play.busy || play.dirty) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  window.addEventListener(
    "pagehide",
    () => {
      clearInterval(timer);
      actors.dispose();
      play.dispose();
    },
    { once: true },
  );
  const results = await Promise.allSettled([actors.start(), play.start()]);
  for (const r of results)
    if (r.status === "rejected")
      notify(`加载资源失败：${message(r.reason)}。请确认本地资源服务已启动。`);
}
