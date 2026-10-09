import { parseNacosDocument } from "../server/config-format";
import { readFile } from "node:fs/promises";
import { validateConfigDocument } from "../server/config-validation";
const file = process.argv[2];
if (!file) { console.error("Usage: node --import tsx scripts/validate-nacos.ts <config.yaml>"); process.exit(2); }
try { validateConfigDocument(parseNacosDocument(await readFile(file, "utf8"))); console.log("Nacos configuration is valid"); }
catch { console.error("Nacos configuration is invalid: check schema, required values, placeholders and connection references; values are not logged."); process.exit(1); }
