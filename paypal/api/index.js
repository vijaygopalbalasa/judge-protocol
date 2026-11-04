// Vercel entry: every /api/* request is rewritten here (vercel.json); the pages in public/ are served as static files.
// Jobs live in a private Vercel Blob store, because a function's disk does not last between requests.
import * as blob from "@vercel/blob";
import { appFromEnv } from "../src/server.js";
import { blobStore } from "../src/store.js";

const publicUrl = (process.env.PUBLIC_URL ?? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`).replace(/\/$/, "");
const store = blobStore({ client: blob, isConflict: (e) => e instanceof blob.BlobPreconditionFailedError });
const { app } = appFromEnv(process.env, { store, publicUrl });

export default app;
