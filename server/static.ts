import express, { type Express } from "express";
import fs from "fs";
import path from "path";

export function serveStatic(app: Express) {
  const distPath = path.resolve(__dirname, "public");
  if (!fs.existsSync(distPath)) {
    // In production (pplx.app), static files are served from S3 — not the Node server.
    // Skip static serving silently; the server only needs to handle /api routes.
    console.log(`[static] dist/public not found — running in API-only mode (static files served from CDN)`);
    return;
  }

  app.use(express.static(distPath));

  // fall through to index.html if the file doesn't exist
  app.use("/{*path}", (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
