This file provides guidance to Claude Code and other agents when working with code in this repository.

## Project overview

Flow Linear is an Obsidian plugin that adds chosen Linear tickets to the Focus
list of the Flow plugin (github.com/tavva/flow) and keeps a Linear label in step
with them. It works only through Flow's public Focus API.

Design: `docs/plans/2026-11-04-flow-linear-design.md`.

## Rules

- Follow Obsidian's developer policies, submission requirements and plugin
  guidelines; the design's "Guidelines compliance" section lists what applies.
- API keys live in Obsidian SecretStorage, never in `data.json`. Keep
  `docs/secrets.md` up to date.
- All network calls go through `requestUrl`, only to `api.linear.app`.
- All source files start with two `ABOUTME:` comment lines.
- British English in docs and comments; UI text in sentence case.
