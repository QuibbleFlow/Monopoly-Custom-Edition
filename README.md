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
- `GET/PATCH /api/settings` loads and saves sound, interface, and controller preferences.
- `GET /api/friends`, `GET /api/friends/search`, `GET/POST /api/friends/requests`, `PATCH /api/friends/requests/:id`, and `DELETE /api/friends/:id` manage account-owned friend relationships and recent online presence.
- `GET/POST /api/game/invitations` lists pending invitations or lets a host invite a friend; `PATCH /api/game/invitations/:id` accepts or declines for the invited account only.
- Server game status is `WAITING`, `ACTIVE`, `PAUSED`, or `FINISHED`. New API-created matches are invite-only by default.
- `GET/POST /api/game/connection` discovers active reserved seats and handles per-tab rejoin, heartbeat, disconnect, and permanent departure. Abandoning reserves the same seat for 120 seconds. Closing a live tab sends a disconnect beacon; a missing heartbeat is detected after a 30-second lease. Deadlines and tab sessions are persisted in the authoritative state and reconciled under the game lock. Closing one tab does not disconnect another live tab.
- `POST /api/game/pause` saves the authoritative checkpoint and marks the match PAUSED. The first Save & Quit creates a player-named file; later saves update that file. Each owner has two slots; creating a third removes the oldest by creation time. `PATCH/DELETE /api/game/saves` renames or deletes an owned file.
- The host loads a save and invites its remaining players again. Guests cannot independently load a save or return to a saved lobby without an invitation. Expired or permanently departed players are removed from both the live membership and the save's required roster. `POST /api/game/resume` restores the checkpoint only after the remaining players have returned.
- `POST /api/game/delete` is host-only and transactionally deletes invitations, results, action requests, state, memberships, and the game. FINISHED games are cleaned up after every original player reads results, with an expiry cleanup on server-game list refresh.
- `GET/POST /api/boards`, `GET/PATCH/DELETE /api/boards/:id`, and `POST /api/boards/:id/share` manage unlimited owner-scoped boards and friend-only independent copies.

The game calls these same-origin endpoints. Account data is loaded from Postgres after session restoration. Custom labels, rules, and card decks are included in the authoritative board snapshot sent to every participant.

## Multiplayer Boundary

`game-engine.js` now owns serializable game-state creation, explicit starting order/dice/card inputs, movement and landing resolution, rent/tax payments, debt/liquidation/bankruptcy, property management, auctions, trades, turn transitions, and timestamped game timers. It has no DOM, browser, network, camera, or animation dependency; engine actions return state snapshots and typed events for the UI. `npm test` runs its focused Node test suite.

Server-created matches use versioned transactions for legal game actions, server-selected dice/cards, membership, board snapshots, host ownership, saves, invitations, and final results. The browser presents animations and submits actions rather than choosing authoritative outcomes. Legacy PeerJS/local play remains separate.

When the current host disconnects, host permissions advance through the recorded join order to the next connected player. A returning former host keeps their original player state but does not reclaim host. A disconnected actor's turn or auction waits until they return or expire. Permanent departure releases their properties and repairs pending debt, trade, auction, and turn state while retaining stable player IDs.

Reopening the site prioritizes the reserved-seat screen with the board, players, server-derived countdown, Rejoin Match, and Leave Match. The Game Menu contains Players, Friends, Settings, Save & Quit for the host, and confirmed Abandon Match. Profile and Friends remain in the top corner.

## Controller

Controller interaction switches automatically, with no mode selector. The main board and browsing menus use the left stick as a bounded virtual cursor and the right stick to scroll. When the current player is ready to roll, A rolls and RT clicks the cursor. During that roll, A stays reserved and RT still selects. At other times, both A and RT click the cursor, including selecting End turn or inspecting properties while another player rolls. X opens Manage properties, Y opens Trade, LB opens View deeds, RB opens Friends, View opens Profile, and Menu opens the Game Menu. A large A TO ROLL prompt appears whenever the current player is allowed to roll, regardless of cursor position. Other browsing menus use A to click. Property management, purchase decisions, auctions, and the controller keyboard use focus navigation within their own controls. LB/RB cycle managed properties, X/Y sell/build houses, RT mortgages or unmortgages, and B exits. Auctions offer X/LB/RB preset bids, Y edits the custom amount, RT submits it, and B folds. The Game Menu has shortcuts for Players, Settings, Friends, pause, and Save & Quit. Connected controllers show inline button badges beside actions and fields, even while using a physical mouse. Xbox, PlayStation, and Nintendo labels match the connected controller and disappear on disconnect. Sensitivity and deadzone remain adjustable. Label updates batch visibility reads before DOM writes and reuse the current interaction scope between menu changes to avoid repeated board layouts when a menu opens.

`npm test` includes PostgreSQL integration tests through PGlite for persisted reconnect deadlines, final-second returns, multiple tabs, host succession, saved invitations, removals, and save-slot eviction. No additional database migration is needed for connection metadata, which is stored in the existing `game_states.state` JSON.

## Test after deployment

The responsive shell reserves space for its toolbar, board, action shelf and controller help. Phone/tablet layouts use a horizontal player strip. Wide and short landscape windows use scrollable sidebars. Dialogs, property management and keyboards scroll within the available height. Extreme split windows scroll the game instead of collapsing the board. Measured board dimensions and a container-unit fallback support console browsers, and connected controller badges retain the same bindings at every size.

Check portrait and landscape phones, eight-player lobbies, custom-board/card forms, 1280×720 and 1920×1080, including a connected controller. Verify purchases, auctions, property management, saved-match lists, populated friends menus and the keyboard remain reachable after resizing.

1. Open the Vercel deployment and create an account. A missing database or storage configuration is shown as an error, not replaced with a local account.
2. Refresh; the account should restore from the session cookie. Sign out and verify the signed-out state.
3. Sign back in from a second browser or device. Change the username and volume/preferences; reload the other device and verify that it receives the changes.
4. Upload an image, replace it, then remove it. Confirm each change on the second device.
5. Change the password using the current password, verify an incorrect current password is rejected, then sign in with the new password.
6. From Friends, search a second account, send/accept a request, remove it, and confirm presence changes while both sessions are active.
7. Create a custom board, edit labels and Chance/Community Chest actions, share it with a friend, and verify edits to the owner's board do not alter the recipient's copy. Start a match and verify every guest receives the selected board.
8. Abandon and refresh a match; verify the reserved-seat screen, timely rejoin, host transfer without a board reset, and permanent Leave Match. Test multiple tabs and a return after the deadline.
9. Save & Quit, load as the host, invite the remaining players, and resume. Confirm guests cannot load independently and a third save keeps only the newest two.
10. Check controller focus, cursor selection, scrolling, and mode switching in profile, friends, board editor, lobby, and game dialogs.
11. If an API request fails, inspect the corresponding Vercel Function logs. The UI reports backend failures and does not claim unsaved account data synchronized.

### Match house rules

Pass-and-play and fresh multiplayer lobbies offer a collapsible House rules section. The online host submits the selected rules when starting. Everyone receives the same authoritative rules. Restored saves retain their original rules, scaled board and Free Parking pot. No database migration is required.

- Free Parking Jackpot collects paid taxes, card fees, repair bills, jail fines and mortgage interest. Rent, purchases, auction purchases and construction costs do not fund it. Deferred debts enter the pot only when paid, and bankruptcy contributes only actual remaining cash. Landing collects and resets the pot.
- Double GO adds one extra GO salary when landing exactly on GO.
- Money scaling supports whole-number multipliers from 1 to 10,000, plus Classic, ×10, ×100 and Canadian-style ×1,000 presets. The Canadian-style preset is a game approximation, not a current housing-market estimate. Cash, prices, rents, construction, taxes, GO salary, fines, card cash effects, repair costs, mortgage values and interest scale together. Auction quick bids and trade cash input steps follow the scale. Percentage cards, movement distances and percentage-based rule multipliers do not scale again.
- Saved custom board decks remain unchanged. The engine scales fixed amounts when applying cards. Card messages replace matching complete numeric amounts, prefer explicitly marked money when present, preserve separators and leave other text intact. Bare matching amounts support custom messages without currency symbols. GO cards update their stated GO salary without changing destinations. The server emits the same match-specific message used for the applied effect.
