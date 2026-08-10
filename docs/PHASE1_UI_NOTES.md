# Phase 1 UI verification notes

Issue: #6  
Master: #1  
Phase: Phase 1 — mobile-first read-only UI

## Purpose

Record the concrete verification contract for the fixture-only mobile UI so later work does not mistake visual mock actions for live GitHub controls.

## Safety contract

- all project/task/PR data in Phase 1 is deterministic fixture data;
- every mock action changes only local React notice state;
- no mock action may call GitHub, Cloudflare, RPi5 or production APIs;
- the existing `/api/health` request is read-only and is not used as decision evidence;
- fixture mode must remain visually explicit;
- Phase 2 is responsible for live read-only GitHub reconciliation;
- Phase 3 is responsible for authenticated write actions.

## Mobile/accessibility checks

The Phase 1 UI is designed against:

- WCAG 2.2 as the web accessibility baseline;
- Android guidance recommending at least 48×48dp touch targets for interactive controls;
- Android adaptive-layout guidance: phone portrait layouts are treated by available viewport width, not by a hard-coded device model or physical pixel resolution.

### Samsung Galaxy A55 compact-phone baseline

Samsung's current official Galaxy A55 5G specification records a 6.6-inch 1080×2340 Full HD+ display (389 ppi). Those are physical display pixels and are **not** used as CSS breakpoints.

For the web UI, the A55 requirement is represented by a reusable compact portrait profile:

- default mobile-first layout remains active below the 640px enhancement breakpoint;
- an additional `max-width: 430px` compact refinement optimizes common A55-class portrait browser widths without user-agent/device sniffing;
- decision actions become one full-width control per row on the compact profile;
- `viewport-fit=cover` plus safe-area environment insets protect content in edge-to-edge/fullscreen contexts;
- `100dvh` is used when supported so browser chrome changes do not create a stale `100vh` floor;
- an extra `max-width: 350px` fallback stacks dense evidence/project statistics for narrower phones.

The goal is not to make the UI A55-only. It is to guarantee that an A55-class compact phone is a first-class target while preserving responsive behavior across other phones.

Implementation checks:

- primary action controls use a minimum height of 52 CSS px;
- skip-to-content navigation is present;
- keyboard focus uses a visible 3px outline;
- status meaning is written in text and is not color-only;
- headings and landmark sections preserve a meaningful reading order;
- the layout begins as a single-column phone layout and enhances at wider breakpoints;
- compact-phone safe-area/dynamic-viewport rules are loaded after the base stylesheet;
- `prefers-contrast: more` receives stronger card borders.

## Phase 1 exit evidence

Before Phase 1 is marked complete, CI must pass for the final branch head and the final PR must show that no live GitHub integration, production bindings, credentials or write paths were introduced.
