#!/usr/bin/env node

import { logo, version } from "../index.js";

const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("-v")) {
  console.log(`${logo} v${version}`);
} else {
  console.log(`${logo} CLI foundation is installed. Runtime commands will be added in the CLI implementation slice.`);
}
