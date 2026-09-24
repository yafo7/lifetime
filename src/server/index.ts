import { fileURLToPath } from "node:url";
import { Store } from "./store";
import { createServer } from "./http";
const root = fileURLToPath(new URL("../../", import.meta.url));
const port = Number(process.env.PORT || 5191);
createServer(new Store(`${root}/data`), `${root}/dist`).listen(
  port,
  "127.0.0.1",
  () => console.log(`Lifetime resources: http://127.0.0.1:${port}`),
);
