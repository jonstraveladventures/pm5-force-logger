#!/usr/bin/env node
// Turn a saved row into a FIT file from the command line, for rows recorded with the Python
// logger. The browser has a FIT button for rows it holds itself; this is the same encoder.
//
//   node web/tools/tofit.mjs row.json [out.fit]
import { readFileSync, writeFileSync } from "node:fs";
import { encode, fileName } from "../fit.js";

const [input, output] = process.argv.slice(2);
if (!input) { console.error("usage: node web/tools/tofit.mjs <session.json> [out.fit]"); process.exit(2); }
const session = JSON.parse(readFileSync(input, "utf8"));
const out = output || fileName(session);
const bytes = encode(session);
writeFileSync(out, bytes);
console.log(`${out}: ${bytes.length} bytes, ${(session.strokes || []).length} strokes`);
