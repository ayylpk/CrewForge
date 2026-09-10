# CrewForge Frontend Control Room Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the CrewForge frontend feel like a coherent engineering control room, with clearer hierarchy, safer action placement, and a consistent visual system across project, execution, architecture, team, agent, and login surfaces.

**Architecture:** Preserve the existing Vue 3 route/component structure. Centralize visual decisions in `src/style.css`, then make focused template/CSS adjustments in the application shell and highest-use views. Keep all data APIs, task semantics, and Agent workflows unchanged.

**Tech Stack:** Vue 3, TypeScript, Element Plus, existing scoped CSS, Vite.

## Global Constraints

- Preserve all existing routes, API calls, task status semantics, and Agent workflow behavior.
- Use the dark engineering control-room direction: ink navy base, slate panels, cold white text, cyan-green active state, amber attention state, coral failure state.
- Keep keyboard focus visible and respect `prefers-reduced-motion`.
- Primary actions must be visually distinct from secondary and destructive actions.
- Do not add a UI framework or external font dependency.
- Validate with `vue-tsc -b` and `npm run build`.

### Task 1: Establish the global design token system

**Files:**
- Modify: `fronted-CrewForge/src/style.css`
- Test: `fronted-CrewForge` production build

**Interfaces:**
- Produces shared CSS variables and base interaction styles consumed by existing views.

- [ ] Replace the current scattered color scale with named semantic tokens for canvas, panel, elevated panel, line, text, muted text, accent, success, warning, danger, focus, and shadows.
- [ ] Add consistent radius, spacing, typography, button focus, selection, scrollbar, and reduced-motion rules.
- [ ] Keep existing variable aliases (`--bg`, `--bg2`, `--bg3`, `--bg4`, `--text`, `--text2`, `--text3`, `--blue`, `--green`, `--yellow`, `--red`) so scoped legacy views do not break.
- [ ] Run `npm run build` and confirm no TypeScript or CSS build failure.
- [ ] Commit as `style: establish control room design tokens`.

### Task 2: Improve application shell and primary navigation

**Files:**
- Modify: `fronted-CrewForge/src/App.vue`
- Modify: `fronted-CrewForge/src/components/WorkspaceSwitcher.vue`
- Modify: `fronted-CrewForge/src/components/StatusDot.vue`

**Interfaces:**
- Consumes existing router and project state.
- Produces a stable navigation hierarchy without changing route behavior.

- [ ] Make the shell distinguish product navigation, workspace context, and user actions.
- [ ] Group primary actions in a single visual rail and use consistent active/focus states.
- [ ] Ensure compact screens retain a usable navigation path.
- [ ] Run `vue-tsc -b` and build.
- [ ] Commit as `style: clarify application navigation hierarchy`.

### Task 3: Redesign execution controls and action hierarchy

**Files:**
- Modify: `fronted-CrewForge/src/views/ExecutionView.vue`

**Interfaces:**
- Consumes existing task polling, execution store, confirmation, editor, and log state.
- Produces clearer execution status, task actions, quality summary, and failure recovery controls.

- [ ] Keep the editor as the primary work surface.
- [ ] Move status and quality information into a compact top control strip.
- [ ] Group task actions by intent: inspect, retry, open logs, and close; keep retry visually separate as a recovery action.
- [ ] Add clear labels/tooltips to icon-only controls and visible keyboard focus.
- [ ] Preserve the task quality summary already backed by `summarizeTaskQuality`.
- [ ] Run the existing zero-LLM verification, `vue-tsc -b`, and `npm run build`.
- [ ] Commit as `style: refine execution control room layout`.

### Task 4: Align project list, detail, architecture, and team surfaces

**Files:**
- Modify: `fronted-CrewForge/src/views/ProjectsView.vue`
- Modify: `fronted-CrewForge/src/views/ProjectDetailView.vue`
- Modify: `fronted-CrewForge/src/views/ArchitectView.vue`
- Modify: `fronted-CrewForge/src/views/TeamView.vue`
- Modify: `fronted-CrewForge/src/views/AgentRepositoryView.vue`
- Modify: `fronted-CrewForge/src/views/AgentFormView.vue`

**Interfaces:**
- Consumes existing page data and actions.
- Produces consistent page headers, section labels, table/card density, and primary/secondary button placement.

- [ ] Standardize each view on: page eyebrow, title, supporting context, primary action, secondary action, content region.
- [ ] Keep destructive actions away from primary actions and require existing confirmation flows.
- [ ] Use status colors semantically rather than decoratively.
- [ ] Avoid broad rewrites of business logic; change only templates and scoped styles.
- [ ] Run the frontend build and inspect changed views for overflow and empty-state regressions.
- [ ] Commit as `style: align project and agent workspace surfaces`.

### Task 5: Login and responsive/accessibility pass

**Files:**
- Modify: `fronted-CrewForge/src/views/LoginView.vue`
- Modify: `fronted-CrewForge/src/style.css`

**Interfaces:**
- Preserves login API behavior and route navigation.
- Produces a responsive, readable login surface with consistent focus and error states.

- [ ] Match login palette and typography to the control-room system.
- [ ] Ensure form controls, buttons, errors, and loading states have visible focus and readable contrast.
- [ ] Add mobile layout constraints for narrow screens.
- [ ] Respect reduced motion and avoid decorative animation that competes with the form.
- [ ] Run `vue-tsc -b`, `npm run build`, and `git diff --check`.
- [ ] Commit as `style: finish responsive frontend visual pass`.

## Verification Checklist

- `npm run build` exits 0 in `fronted-CrewForge`.
- `powershell.exe -ExecutionPolicy Bypass -File scripts\verify.ps1 -SkipBuilds` exits 0.
- `git diff --check` produces no errors.
- Existing route names and API paths are unchanged.
- No real LLM pipeline is run.
