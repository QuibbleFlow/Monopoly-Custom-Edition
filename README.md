# Monopoly: Custom Edition

The game remains a static browser application. Vercel serves `index.html` and one consolidated API router as a serverless function. No always-running Node server is required. Neon persists accounts, profiles, preferences, friendships, custom boards, invitations, and authoritative server games. Legacy PeerJS code remains in the client; server-created games use the authoritative API.

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
2. For an existing database containing user data, make a Neon snapshot/branch backup first. If it has not already been applied, use `db/migrations/006_production_schema_reconciliation.sql` to reconcile the older schema without dropping tables or deleting rows.
3. Before deploying current server multiplayer code, run `db/migrations/007_server_game_lifecycle_invitations.sql` in the Neon SQL Editor. This additive, re-runnable migration adds `games.invite_only`, `games.paused_at`, `games.finished_at`, `game_players.results_seen_at`, `game_invitations`, the PAUSED status check, and cascade foreign keys from `game_states`/`game_action_requests` to `games`. It retains existing rows, backfills existing FINISHED timestamps from `updated_at`, and aborts rather than removing data if it finds an unknown game status or invalid existing foreign-key references.
4. Migrations 002-006 are historical upgrades; do not rerun 006 when it has already been applied. Apply 007 after the current production schema is at 006. For a fresh database, `db/schema.sql` already includes both the current schema and these lifecycle/invitation objects.
5. To verify the exact production database before and after migration, link the repository with `npx vercel link`, pull the Production environment into a local ignored file with `npx vercel env pull .env.production --environment=production`, and run `node --env-file=.env.production scripts/check-db.js`. Alternatively, supply the production `DATABASE_URL` to `npm run db:check`. The checker opens a read-only connection and verifies current database/schema, expected application columns, indexes, foreign keys, and CHECK constraints. It never prints the connection string. Do not deploy the database-dependent application until the post-migration check exits successfully.
6. Deploy the existing Vercel project after the post-migration check. Test signed-in lobby, invitations, Save & Quit, and resume against separate production accounts; the SQL checker and local tests do not establish production multiplayer correctness.
7. `DATABASE_URL` is used by the app and checker; `SESSION_SECRET` is used for sessions; `BLOB_READ_WRITE_TOKEN` is only used by profile image upload/delete. Configure each variable for the applicable Vercel environments. No database credential belongs in browser code or committed files.

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
- `GET/POST /api/game/invitations` lists pending invitations or lets a host invite a friend; `PATCH /api/game/invitations/:id` accepts or declines for the invited account only.
- Server game status is `WAITING`, `ACTIVE`, `PAUSED`, or `FINISHED`. Leaving does not remove seats or delete unfinished games. New API-created matches are invite-only by default.
- `POST /api/game/pause` locks and validates the current authoritative version, then marks the same match PAUSED; `POST /api/game/resume` continues that same game only after every original account has returned to its original seat.
- `POST /api/game/delete` is host-only and transactionally deletes invitations, results, action requests, state, memberships, and the game. FINISHED games are cleaned up after every original player reads results, with an expiry cleanup on server-game list refresh.
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