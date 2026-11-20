# UI / UX audit (14 Nov 2026)

How it was done: a seeded, isolated copy of the stack, driven by a real browser (Chromium) as a member and as the
owner, in four modes (desktop and phone, light and dark). Every page type was opened (login and its steps, 404,
invitation, workspace landing, documents with embedded databases, grid, board, calendar, linked databases, card detail,
AI chat, trash) as well as the dialogs and panels (search, share, page menu, comments, new-page/templates menu, card
history, every settings page including Agent access and its Activity tab). Each was screenshotted and checked with the
axe-core accessibility engine (WCAG A/AA), a horizontal-overflow check, and a list of failed requests and console errors.
Phones were tested with a real phone user agent, because the app switches to a separate mobile layout for those.

## Fixed

| # | Finding | Where it showed | Fix |
|---|---|---|---|
| 1 | Primary buttons ("Share", "New", "Continue", "Save") were white on bright cyan: contrast 2.3:1 (needs 4.5:1) | every page | deeper blue `#0078b4` (4.8:1); one file, `src/styles/accessible-contrast.css` |
| 2 | Links and "action" text 3.4:1; inactive tabs, hints and timestamps 2.7:1; dark-mode hints 3.4:1 | login links, tabs, comments, hints | secondary / tertiary / action text colours raised to AA in light and dark |
| 3 | Every icon announced as an unnamed image (60-150 per page) | every page | icons are decorative: `aria-hidden` set in the SVG build config |
| 4 | About 250 icon-only buttons with no accessible name | grid, board, sidebar, editor, chat | a tooltip's plain text now also names its icon-only button (central, in `ui/tooltip`); explicit labels on the sidebar arrows, header menu, add/drag block, chat send/stop, trash, quick note, board column menu |
| 5 | Every page load made two requests that 404 (Share details), and opening Settings > People threw an error toast ("We couldn't find this content") | all pages, People settings | the server answers the Share details requests and the group lists |
| 6 | Share popover offered an invite box and per-person permission menus that cannot work here (pages are not shared one by one) | Share | server says so (`enable_page_sharing: false`); the popover then only lists who has access |
| 7 | People settings showed a "Groups" tab for a feature this server does not have | Settings > People | hidden (`enable_workspace_groups: false`) |
| 8 | The floating "?" button was a clickable `div` with the tooltip "Get support"; it actually holds the light/dark switch | every page | real button, labelled "Appearance & help", keyboard reachable |
| 9 | AI chat greeted "Hi Dear" and suggested "Why use Rust" / "Recipe with what's in my kitchen" | AI chat | greeting "Hi there", suggestions about the workspace (open tasks, latest changes, due this week, risks) |
| 10 | Narrow desktop windows (under about 480 px) had no way to open the sidebar; at 480-768 px it pushed the page to a sliver | any narrow browser window | menu button always shown, sidebar overlays the page with a backdrop, closes when a page is chosen, path shows the current page |
| 11 | Card detail error close button unnamed | error dialog | labelled |

Also caught on the way: the first version of change 10 crashed the whole app (a missing import). It was found by this
audit's own run and fixed before anything else; all four modes were re-run afterwards.

## Result (axe violations, desktop light, per page, before -> after)

* colour contrast: 2-8 -> 0 on every page except one (the calendar's "today" badge, white on pink, 3.8:1)
* unnamed images: 60-150 -> 0
* unnamed buttons: 20-80 -> 0-16 (hover-only row and column buttons, see below)
* 404s and console errors on page load: 3 -> 0

## Not fixed (open, in order of value)

1. About 30 hover-only buttons in grid rows and board columns still have no accessible name (rare in normal use).
2. Radix menu triggers rendered on a `div` carry `aria-expanded` without a role (about 25-75 per page, no visible effect).
3. The calendar "today" badge is 3.8:1.
4. The rich-text editor box has no accessible name (one per page).
5. Phone layout: the audit covered every page, but not the dialogs (search, share, settings) on a phone; the
   automation drives the desktop layout. They need a pass by hand on a real phone.
6. The brand blue is now darker than the original cyan. If you prefer the original look for buttons, delete
   `src/styles/accessible-contrast.css` (or the `--fill-theme-thick` lines in it): you trade 2.3:1 text contrast for
   the brighter colour.
7. The agent's name in a comment ("Via Achal's Claude Code: ...") is plain text in the comment; a small "agent" badge
   would read better.
8. Sidebar names get long when templates with several linked databases are added ("HR Team Project Tracker - Grid").
