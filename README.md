# Monopoly: Custom Edition

The game remains a static browser application. Vercel serves `index.html`, `game-engine.js`, `account-features.js`, and the files in `api/` as serverless Node.js functions. No always-running Node server is required. Neon persists accounts, profiles, preferences, friendships, and custom boards. PeerJS still transports live game actions.

## Services

- **Database:** Neon Postgres. `db/schema.sql` is the complete, idempotent schema for a fresh database. Existing account-only installations should apply `db/migrations/002_social_custom_boards.sql`, which adds presence, friend, and custom-board structures in a transaction without dropping account/session rows.
- **Profile pictures:** Vercel Blob, with public image URLs stored in Neon. Uploads are limited to JPEG, PNG, and WebP files of 2 MB or less. The Vercel function filesystem is never used for durable uploads.
- **Passwords and sessions:** bcryptjs hashes passwords. Opaque random session tokens are stored as HMAC hashes in Postgres, delivered in an HttpOnly, SameSite cookie, and expire after 30 days. Sign out revokes the database session.

## Vercel environment variables

Set these for the project in **Vercel > Settings > Environment Variables** (Production, Preview, and Development as needed):

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Neon pooled PostgreSQL connection string, preferably with TLS enabled |
| `SESSION_SECRET` | At least 32 random characters; generate with `openssl rand -base64 48` |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob read/write token for the project |

Do not put these values in `index.html` or commit them. Changing `SESSION_SECRET` invalidates existing sessions, requiring users to sign in again.

## Neon Setup and Migration

1. Create a Neon project and database. Copy its pooled connection string with TLS enabled.
2. For a fresh database, run `db/schema.sql` once in the Neon SQL Editor. For a database that already has the earlier account/session tables only, run `db/migrations/002_social_custom_boards.sql` instead. Do not run the upgrade migration on a fresh database as a separate setup step. If the complete schema has already been installed, no schema changes need to be applied.
3. The upgrade migration uses `BEGIN`/`COMMIT`, `ADD COLUMN IF NOT EXISTS`, and `CREATE ... IF NOT EXISTS`; it does not drop or rewrite account data. These statements are safe to re-run, but they do not repair an existing table whose columns or constraints have drifted. Back up the Neon database before production changes. If a migration errors, stop and inspect the reported schema rather than dropping tables.
4. To verify a Vercel project's actual Neon configuration locally, link the repository with `npx vercel link`, then pull Development variables into the ignored `.env.local` file with `npx vercel env pull .env.local`. Run `node --env-file=.env.local scripts/check-db.js` to load that file for this process only. Alternatively, export `DATABASE_URL` in your shell and run `npm run db:check`. The checker opens a read-only connection and verifies the database connection, expected columns, primary/unique indexes, foreign keys, and CHECK constraints. It never prints the connection string. The schema file being present does not prove it was applied; require this check to exit successfully before treating Neon as ready.
5. The checker needs `DATABASE_URL`; authentication APIs also need `SESSION_SECRET`; avatar operations need `BLOB_READ_WRITE_TOKEN`. Set these for Production, Preview, and Development in Vercel. No database credential belongs in browser code or committed files.

## Deploy

1. Create a Vercel Blob store and copy its read/write token.
2. Import this repository into Vercel. Use the default project settings; Vercel detects `api/**/*.js` as Node.js functions and serves `index.html` plus `account-features.js` as static assets.
3. Add `DATABASE_URL`, `SESSION_SECRET`, and `BLOB_READ_WRITE_TOKEN` to Vercel's environment variables, then deploy. Redeploy after changing environment variables.
4. Open the deployed URL over HTTPS. Account and social APIs use same-origin `/api` requests.

For local development, install dependencies with `npm install`, set the same environment variables in a local `.env` file (do not commit it), and use `npx vercel dev`. This emulates the Vercel function model; a permanent local server is not part of deployment.

## API and game integration

- `POST /api/auth/signup`, `POST /api/auth/signin`, `POST /api/auth/signout`, `GET /api/auth/session`
- `GET/PATCH /api/profile` changes the username; `POST /api/profile/password` requires the current password.
- `POST/DELETE /api/profile/avatar` uploads, replaces, or removes an image.
- `GET/PATCH /api/settings` loads and saves volume, game, interface, camera, and other account preferences.
- `GET /api/friends`, `GET /api/friends/search`, `GET/POST /api/friends/requests`, `PATCH /api/friends/requests/:id`, and `DELETE /api/friends/:id` manage account-owned friend relationships and recent online presence.
- `GET/POST /api/boards`, `GET/PATCH/DELETE /api/boards/:id`, and `POST /api/boards/:id/share` manage unlimited owner-scoped boards and friend-only independent copies.

The existing game calls these same-origin endpoints. Account data is loaded from Postgres after session restoration and is not cached in localStorage. Custom property labels are keyed by the existing fixed square indexes, and the selected map is included in the game state sent to PeerJS clients.

## Multiplayer Boundary

`game-engine.js` now owns serializable game-state creation, explicit starting order/dice/card inputs, movement and landing resolution, rent/tax payments, debt/liquidation/bankruptcy, property management, auctions, trades, turn transitions, and timestamped game timers. It has no DOM, browser, network, camera, or animation dependency; engine actions return state snapshots and typed events for the UI. `npm test` runs its focused Node test suite.

The current live game still uses the PeerJS host's browser to choose random dice/cards and dispatch actions, then synchronizes replays/snapshots to guests. The UI controller still owns card deck selection, offer-field editing, display logs, animation sequencing, and PeerJS action authorization. This is not a backend-authoritative model. Database-backed lobbies, server-validated game actions, friend invitations, cloud game saves/resume lobbies, and synchronized final results have not been implemented. The existing local game-save behavior is still browser-local. Backend-authoritative multiplayer should begin only after the remaining controller-owned state/workflows have been accounted for, and then requires a versioned transactional action API; storing host-submitted snapshots alone would not make the backend authoritative.

## Test after deployment

1. Open the Vercel deployment and create an account. A missing database or storage configuration is shown as an error, not replaced with a local account.
2. Refresh; the account should restore from the session cookie. Sign out and verify the signed-out state.
3. Sign back in from a second browser or device. Change the username and volume/preferences; reload the other device and verify that it receives the changes.
4. Upload an image, replace it, then remove it. Confirm each change on the second device.
5. Change the password using the current password, verify an incorrect current password is rejected, then sign in with the new password.
6. From Friends, search a second account, send/accept a request, remove it, and confirm presence changes while both sessions are active.
7. Create a custom board, rename a regular property, verify corners cannot be selected, share it with a friend, and verify edits to the owner's board do not alter the recipient's copy.
8. If an API request fails, inspect the corresponding Vercel Function logs. The UI reports backend failures and does not claim unsaved account data synchronized.