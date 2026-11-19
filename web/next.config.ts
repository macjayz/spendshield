import path from "node:path";
import type { NextConfig } from "next";

// The pnpm workspace root (one level up from web/). Next.js otherwise picks the highest lockfile it
// finds, which can be a folder far above this repo; it then watches that whole folder and rebuilds
// (and reloads every open page) whenever anything in it changes.
const workspaceRoot = path.resolve(__dirname, "..");

const config: NextConfig = {
  // The shared config package ships TypeScript source.
  transpilePackages: ["@aevum-kit/aevum"],
  turbopack: { root: workspaceRoot },
  outputFileTracingRoot: workspaceRoot,
};

export default config;
