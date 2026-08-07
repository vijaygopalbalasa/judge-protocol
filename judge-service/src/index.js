#!/usr/bin/env node
// Judge service entrypoint.
import { run } from "./engine.js";

run().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
