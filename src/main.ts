import { startApp } from "./client/app";
import "./client/styles.css";
void startApp(document.querySelector<HTMLElement>("#app")!).catch((error) => {
  const message = document.createElement("p");
  message.className = "startup-error";
  message.textContent = `Lifetime 启动失败：${error instanceof Error ? error.message : String(error)}`;
  document.body.append(message);
});
