import { runSmoke } from '../smoke.mjs';

const result = await runSmoke();
process.stdout.write(`${JSON.stringify(result)}\n`);
if (!result.ok) process.exitCode = 1;
