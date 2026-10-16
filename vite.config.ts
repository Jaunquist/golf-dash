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
      includeAssets: ["favicon.svg", "apple-touch-icon.png", "icons/icon-192.png",
                      "icons/icon-512.png", "icons/icon-192-maskable.png",
                      "icons/icon-512-maskable.png"],
      manifest: {
        name: "Golf Dash",
        short_name: "Golf Dash",
        description: "Track golf rounds, scores, handicap and game results",
        version: "1.7.0",
        theme_color: "#1d5c3a",
        background_color: "#f5f2ea",
        display: "standalone",
        // "any" lets the scorecard be read in landscape; "portrait" locks it
        orientation: "any",
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
          // Android crops installed icons to the device's mask shape, so these
          // carry extra padding to keep the arrow inside the safe zone.
          {
            src: "icons/icon-192-maskable.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "maskable",
          },
          {
            src: "icons/icon-512-maskable.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // Take over from the previous worker immediately rather than waiting
        // for every tab to close. Declared once — these were previously set
        // twice in this same object, which is what the build warned about.
        skipWaiting: true,
        clientsClaim: true,
        // Without this, precaches from superseded deploys are kept forever
        cleanupOutdatedCaches: true,

        // Precache all built assets (JS, CSS, HTML)
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2}"],

        /**
         * Runtime caching is only for things that genuinely cross the network.
         *
         * The /api/* rules that used to live here never matched anything: this
         * app has no HTTP API. queryClient intercepts every /api/* call and
         * answers it from IndexedDB, syncing to Apps Script as a POST to
         * script.google.com — a URL the service worker never sees, and a method
         * workbox does not cache in any case. One of those rules was also keyed
         * to a numeric round id, which could never match a UUID even in
         * principle.
         *
         * Fonts are the real network dependency, so fonts are what is cached.
         */
        runtimeCaching: [
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
        ],
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
    rollupOptions: {
      output: {
        // Recharts is large and only the dashboard uses it; keeping it in its
        // own chunk means a shared scorecard never downloads it.
        manualChunks: {
          charts: ["recharts"],
          vendor: ["react", "react-dom", "wouter", "@tanstack/react-query"],
        },
      },
    },
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
