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
- Android guidance recommending at least 48×48dp touch targets for interactive controls.

Implementation checks:

- primary action controls use a minimum height of 52 CSS px;
- skip-to-content navigation is present;
- keyboard focus uses a visible 3px outline;
- status meaning is written in text and is not color-only;
- headings and landmark sections preserve a meaningful reading order;
- the layout begins as a single-column phone layout and enhances at wider breakpoints;
- `prefers-contrast: more` receives stronger card borders.

## Phase 1 exit evidence

Before Phase 1 is marked complete, CI must pass for the final branch head and the final PR must show that no live GitHub integration, production bindings, credentials or write paths were introduced.
