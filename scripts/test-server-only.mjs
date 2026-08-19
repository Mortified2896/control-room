import { registerHooks } from "node:module";

const TEST_SERVER_ONLY_URL = "control-room-test:server-only";

// Next.js replaces the `server-only` marker during bundling. Plain Node tests do
// not have that resolver, so load an inert marker without enabling the global
// `react-server` condition (which would also switch React to its server build).
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, url: TEST_SERVER_ONLY_URL };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === TEST_SERVER_ONLY_URL) {
      return {
        format: "commonjs",
        shortCircuit: true,
        source: "module.exports = {};",
      };
    }
    return nextLoad(url, context);
  },
});
