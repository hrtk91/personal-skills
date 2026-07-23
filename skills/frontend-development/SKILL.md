---
name: frontend-development
description: Design and refactor React or TypeScript frontends around explicit business states, discriminated unions, reducers, component boundaries, and controlled side effects. Use when building or reviewing feature screens, async resource loading, URL-driven views, hooks, or state-management code.
---

# Frontend Development

Use this skill to make frontend behavior understandable as a set of business workflows. Start from state ownership and valid transitions, then implement rendering and effects at the boundary that owns them.

## Model business concerns

Split a screen into independent concerns before choosing hooks or components. Examples include:

- library selection and navigation
- audio loading and replay
- transcript loading and transcription requests
- editing a track label

Each concern should have one state owner. Prefer parallel, small state machines over one page-wide state object that combines unrelated flags.

## Define state and transitions

Represent mutually exclusive states with a discriminated union. Include the data required by each state so invalid combinations cannot be represented.

```ts
type TranscriptState =
  | { status: 'unavailable'; targetId: string }
  | { status: 'loading'; targetId: string }
  | { status: 'ready'; targetId: string; text: string }
  | { status: 'error'; targetId: string; message: string };
```

Define business actions and transition guards in a reducer:

```ts
type TranscriptAction =
  | { type: 'loadStarted'; targetId: string }
  | { type: 'loadSucceeded'; targetId: string; text: string }
  | { type: 'loadFailed'; targetId: string; message: string };
```

The reducer must reject responses or events for a different target. Convert DOM events into business events at the component boundary; do not make the reducer depend on DOM event names.

Compose a higher-level union only when the parent needs to decide which workflow or component applies:

```ts
type LibraryView =
  | { kind: 'none' }
  | { kind: 'selected'; recording: Recording; target: RecordingTarget };
```

Avoid a "god state machine" that owns every child detail. The parent should coordinate business concerns; each child should own its internal lifecycle.

## Keep rendering derived

Aim for `view = f(state)`:

- render mutually exclusive branches from the union discriminator
- do not infer one business state from several booleans
- do not use the same fact independently from both props and local state
- treat absence as an explicit parent state when the child should not exist
- pass non-null props to a child whose contract requires a target

Pure props-in/render-out components do not need a reducer or state machine. Simple draft values, such as an input map, can use `useState` when there are no meaningful lifecycle modes or transition guards.

## Own asynchronous work at the resource boundary

For network, desktop APIs, audio elements, Blob URLs, timers, storage, or other external systems:

1. Define the lifecycle states first: unavailable, loading, ready, error, or the domain-specific equivalent.
2. Put the effect in the component or hook that owns that external resource.
3. Make the effect depend on the external resource identity, not on incidental UI flags.
4. Guard stale responses and clean up subscriptions, object URLs, timers, and listeners.
5. Let the reducer describe the result; do not scatter loading/error setters through a parent.

`useEffect` is appropriate when synchronizing props or state with an external system. It is a smell when a parent watches a collection of child flags and starts an unrelated business procedure. Prefer an explicit business callback or action for that procedure.

## Respect state-source boundaries

- If URL state is authoritative, derive the view union from route data and URL parameters instead of copying it into local state.
- If a workflow spans multiple screens or components, let the workflow hook/reducer own it and expose semantic state and callbacks to the UI.
- Keep adapters for APIs and platform services behind typed boundaries. Translate external payloads and errors at the boundary.
- Do not make a child accept `null` merely to represent a parent state. Either render the child only in the applicable parent branch or define `hidden` as a genuine child state with an explicit contract.

## Organize features by business concern

Use business features as the first directory boundary, not technical layers across the whole application:

```text
src/features/
  recordings/
    components/
    hooks/
    recordingReducer.ts
    recordingRoute.ts
    *.test.ts
```

When a feature contains independent sub-features, split by business concern and keep their implementation together:

```text
src/features/
  recordings/
    recording-library/
      components/
      hooks/
      state/
      route.ts
    audio-replay/
      components/
      hooks/
      state/
    transcription/
      components/
      hooks/
      state/
```

Keep unions, reducers, state derivation, and their tests close to the concern that owns them. Do not create empty directories or split a one-file concern prematurely. Avoid importing another feature's internal files; expose only the types, events, and functions that form its boundary.

## Verify the model

Before considering a stateful feature complete, test:

- every meaningful reducer transition
- rejected transitions and stale async responses
- state derivation from props, route data, and URL parameters
- cleanup and error behavior at external boundaries
- the build and the feature's unit tests

During review, ask:

1. Who owns this state?
2. What are the valid states and events?
3. Can an impossible combination be represented?
4. Is the effect attached to the resource owner?
5. Can the UI be explained as `view = f(state)`?
