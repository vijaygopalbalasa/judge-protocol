#!/usr/bin/env node
// Judge service entrypoint: chain watcher + HTTP integration API.
import { run, serviceState } from "./engine.js";
import { createJudgeApi } from "./http.js";
import { config } from "./config.js";

const api = createJudgeApi({ getState: () => ({ ...serviceState }) });
api.listen(config.httpPort, config.httpHost, () => {
  console.log(`HTTP API on http://${config.httpHost}:${config.httpPort}`);
});

run().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
