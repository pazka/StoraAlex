// Copy SQL migration files into the compiled server output so they ship with
// the build. tsc does not copy non-TS assets. Cross-platform (uses node fs).
import { cpSync } from 'node:fs';

cpSync('src/server/db/migrations', 'dist/server/db/migrations', { recursive: true });
console.log('Copied migrations -> dist/server/db/migrations');
