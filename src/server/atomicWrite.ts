import { writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";

/** Windows readers/virus scanners may briefly hold a file across an atomic rename. */
export async function atomicWrite(file: string, json: string) {
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, json);
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temp, file);
        return;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (attempt >= 5 || !["EPERM", "EBUSY"].includes(code ?? "")) throw e;
        await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
      }
    }
  } catch (e) {
    await unlink(temp).catch(() => {});
    throw e;
  }
}
