# Adedonha development startup

Use the existing checkout at `/workspace/Adedonha`. Cloud tasks already run in
isolated environments; do not create a Git worktree unless the user requests one.

Node.js 24 or newer is required. Dependencies and the local D1 database are
retained in the prepared filesystem. If dependencies are missing or the lockfile
changed, run the saved install script. Keep tracked source and lockfiles unchanged
when only refreshing the environment.

From `/workspace/Adedonha`, use writable tool configuration and apply local
migrations (safe to repeat):

```bash
set -euo pipefail
export npm_config_cache=/tmp/adedonha-npm-cache
export XDG_CONFIG_HOME=/tmp/adedonha-config
export WRANGLER_SEND_METRICS=false
export CI=true
npm run db:migrate
```

Start the development server in a persistent command session:

```bash
npm run dev
```

The server must restart in each new machine; live processes are not retained.
Wait for Vite readiness and use an internal request to verify rendering:

```bash
curl --fail --silent --show-error --output /tmp/adedonha-readiness.html http://localhost:3001/
rg --quiet 'Adedonha/Stop!' /tmp/adedonha-readiness.html
```

For a meaningful functional check, keep that server running and execute
`npm run test:browser` from the same directory. It creates and cleans up its own
local rooms, verifies two hosts, rejects guest autofill, preserves typing during
generation, and checks that answers reach the actual local D1 database. Use the
system Chromium if available; otherwise install the pinned Playwright browser
with `npx playwright install chromium`. These tests never target the public site.

For code validation run `npm test`, `npm run typecheck`, and `npm run build`.
The normal local game and standard autofill examples work without credentials.
Groq is optional for AI validation and combinations lacking a local suggestion;
use an existing binding or ignored `.dev.vars` file when available. Never print
or commit credentials. Production publication and its existing D1 data are
separate from this local setup; `wrangler.jsonc` contains a local database ID.
Do not publish the site merely to start or test the environment.
