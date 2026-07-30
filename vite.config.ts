import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      // Service worker lives in dist/public
      outDir: path.resolve(import.meta.dirname, "dist/public"),
      // Include these patterns in precache
      includeAssets: ["favicon.svg", "apple-touch-icon.png", "icons/icon-192.png", "icons/icon-512.png"],
      manifest: {
        name: "Golf Dash",
        short_name: "Golf Dash",
        description: "Track golf rounds, scores, handicap and game results",
        version: "1.3.0",
        theme_color: "#1d5c3a",
        background_color: "#f5f2ea",
        display: "standalone",
        orientation: "portrait",
        start_url: "./",
        icons: [
          {
            src: "icons/icon-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "icons/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "icons/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // Force new SW to take over immediately without waiting for tab close
        skipWaiting: true,
        clientsClaim: true,
        // Precache all built assets (JS, CSS, HTML)
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2}"],

        // Runtime caching strategies
        runtimeCaching: [
          // ── Google Fonts: cache-first (rarely changes) ──────────────────
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "google-fonts-stylesheets",
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "google-fonts-webfonts",
              expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/api\.fontshare\.com\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "fontshare",
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },

          // ── /api/courses — stale-while-revalidate (fast + stays fresh) ──
          {
            urlPattern: /\/api\/courses(\?.*)?$/,
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "api-courses",
              expiration: { maxEntries: 1, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [200] },
            },
          },

          // ── /api/settings — stale-while-revalidate ──────────────────────
          {
            urlPattern: /\/api\/settings\/.*/,
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "api-settings",
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [200] },
            },
          },

          // ── /api/rounds (list) — network-first, fall back to cache ──────
          {
            urlPattern: /\/api\/rounds(\?.*)?$/,
            handler: "NetworkFirst",
            options: {
              cacheName: "api-rounds",
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 * 24 * 7 },
              cacheableResponse: { statuses: [200] },
            },
          },

          // ── Individual round data — network-first ────────────────────────
          {
            urlPattern: /\/api\/rounds\/\d+.*/,
            handler: "NetworkFirst",
            options: {
              cacheName: "api-round-detail",
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 7 },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],

        // Skip waiting — update SW immediately on new deploy
        skipWaiting: true,
        clientsClaim: true,
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
  },
  root: path.resolve(import.meta.dirname, "client"),
  base: "./",
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
});
