#!/usr/bin/env node
// `n8n-to-claude` was renamed to `n8n-migrate`; this runs it with the same arguments and exit
// codes. start.mjs runs on its own only when it is the script node was given, so its main() is
// called here.
import { main } from "n8n-migrate/skills/n8n-migrate/scripts/start.mjs";

const code = await main();
if (code !== null) process.exit(code);
