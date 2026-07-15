const cloudflareWorkersStub = `data:text/javascript,${encodeURIComponent("export const env = {};")}`;

export function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") {
    return { url: cloudflareWorkersStub, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
