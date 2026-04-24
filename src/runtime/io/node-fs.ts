// Adapter that maps our narrow `FsLike` onto node's fs/promises. Lives in
// its own module so tests never accidentally import node:fs — they always
// use an in-memory stub instead.

import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";

import type { FsLike } from "./data-dir.js";

export const nodeFs: FsLike = {
  readFile: (path) => readFile(path, "utf8"),
  writeFile: (path, data) => writeFile(path, data, "utf8"),
  readdir: async (path) => await readdir(path),
  mkdir: async (path, opts) => {
    await mkdir(path, opts);
  },
};
