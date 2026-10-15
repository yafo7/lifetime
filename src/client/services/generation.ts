import {
  generateModel as model,
  generateAnimation as animation,
  type GenerationOptions,
} from "../../generation/client";
import type { Provider } from "../../shared/contracts";
const api = (
  import.meta.env.VITE_GENERATION_API ||
  "https://voxel-studio-backend.zeabur.app"
).replace(/\/$/, "");
type Options = Omit<GenerationOptions, "api">;
export const generateModel = (
  description: string,
  provider: Provider,
  mode: string,
  options: Options = {},
) => model(description, provider, mode, { ...options, api });
export const generateAnimation = (
  modelJson: unknown,
  description: string,
  provider: Provider,
  mode: "quick" | "pro",
  options: Options = {},
) => animation(modelJson, description, provider, mode, { ...options, api });
