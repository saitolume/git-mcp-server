#!/usr/bin/env node
import { PRODUCT } from "./product.js";

if (process.argv.slice(2).includes("--version")) {
  process.stdout.write(`${PRODUCT.version}\n`);
} else {
  const { runServer } = await import("./server.js");
  await runServer();
}
