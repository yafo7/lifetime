export function escape(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}
export function select<T extends Element = HTMLElement>(
  host: ParentNode,
  query: string,
): T {
  const element = host.querySelector<T>(query);
  if (!element) throw new Error(`Missing element: ${query}`);
  return element;
}
export function button(
  host: ParentNode,
  query: string,
  callback: () => void | Promise<void>,
  error: (e: unknown) => void,
): void {
  select(host, query).addEventListener("click", () => {
    Promise.resolve().then(callback).catch(error);
  });
}
