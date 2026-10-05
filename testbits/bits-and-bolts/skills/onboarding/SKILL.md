---
name: onboarding
description: Set measurement units and grid preferences, then open the Parts Library when the user chooses Set up for Bits & Bolts or asks for onboarding.
---

# Set up Bits & Bolts

Help the user choose how they want to view CAD parts. Call `settings.read` with
`{}` to read the current preferences. For Bits & Bolts Remote, briefly explain
that these settings apply to the shared demo library.

Ask these questions one at a time, using any preferences already stated:

1. "Do you prefer metric or imperial units?" Map metric to `units: "mm"` and
   imperial to `units: "in"`.
2. "Would you like a reference grid in the viewer?" Map the answer to `showGrid`.

Let the user keep the current settings or skip setup. After they answer, call
`settings.update` with a `set` object containing only their requested changes.
For example, metric with no grid is
`{"set":{"units":"mm","showGrid":false}}`. Leave `defaultView` unchanged unless
they ask to change it. If no changes are requested, skip the update. Confirm
saved preferences from the tool's returned values; do not claim they were saved
if the tool fails.

Call `cad.library` with `{}` to open the Parts Library and invite the user to
explore. If they installed the plugin during an existing task, continue that
task in the same conversation. Call `cad.pickFile` only if they ask to pick,
choose, or select a CAD file.
