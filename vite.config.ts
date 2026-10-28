import { createReadStream, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize } from "node:path";
import { defineConfig, type Plugin } from "vite";
import { attachWisp } from "./server/wisp.ts";

// Guest images are thousands of small files. They live outside the (iCloud-synced)
// project folder and are served directly, never watched or bundled.
export const IMAGES_DIR = process.env.DBVM_IMAGES ?? join(homedir(), "Library/Caches/dbvm/images");

function serveImages(): Plugin {
  return {
    name: "dbvm-images",
    configureServer(server) {
      server.middlewares.use("/images", (req, res, next) => {
        const rel = normalize(decodeURIComponent((req.url ?? "/").split("?")[0]));
        if (rel.includes("..")) return next();
        const file = join(IMAGES_DIR, rel);
        let size: number;
        try {
          const st = statSync(file);
          if (!st.isFile()) return next();
          size = st.size;
        } catch {
          return next();
        }

        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Accept-Ranges", "bytes");
        const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
        if (range) {
          const start = Number(range[1]);
          const end = range[2] ? Number(range[2]) : size - 1;
          res.statusCode = 206;
          res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
          res.setHeader("Content-Length", end - start + 1);
          createReadStream(file, { start, end }).pipe(res);
        } else {
          res.setHeader("Content-Length", size);
          createReadStream(file).pipe(res);
        }
      });
    },
  };
}

// Guest networking for development: v86's wisp backend connects here.
function wispRelay(): Plugin {
  return {
    name: "dbvm-wisp",
    configureServer(server) {
      if (server.httpServer) {
        attachWisp(server.httpServer as import("node:http").Server, "/wisp/", (msg) =>
          server.config.logger.info(`[wisp] ${msg}`),
        );
      }
    },
  };
}

export default defineConfig({
  plugins: [serveImages(), wispRelay()],
  server: {
    watch: { ignored: ["**/refs/**", "**/refs.nosync/**", "**/build/**", "**/guest/**", "**/tools/**"] },
  },
});
