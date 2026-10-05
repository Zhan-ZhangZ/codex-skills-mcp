# Bits & Bolts

Bits & Bolts lets you organize CAD parts, inspect them in 3D, and show Codex what you want to change. It’s also a kitchen-sink example of the core MCP extensions available in Codex.

The bundled library includes 36 photo-referenced Codex Micro parts, including all 32 icon keycaps. See [model sources, estimated dimensions, and Blender rebuild instructions](assets/models/README.md). These are visual references, not fit-verified replacement parts.

Library previews and the viewer use GLB models with materials and textures. STL files remain available for CAD use.

## Build and package

Source builds require Node.js 22 or later, pnpm, and the MCP Extensions SDK. From the SDK repository root, install dependencies and build the SDK:

```sh
pnpm install --frozen-lockfile
pnpm build
```

From this example directory, build an installable plugin:

```sh
node scripts/build.mjs --plugin-dir /tmp/bits-and-bolts
```

The output contains the server, viewer, models, icon, and skills. It requires Node.js but no dependency installation, Python, Blender, or SDK checkout. Copy the complete output directory when distributing the plugin.

Omit `--plugin-dir` to build in this source directory. The build checks that all bundled STL and GLB files exist. If they are missing, follow the [model rebuild instructions](assets/models/README.md). Builds do not download assets or regenerate geometry.

## Extensions

| Extension              | Where it’s used                                                      |
| ---------------------- | -------------------------------------------------------------------- |
| Sidebar entrypoint     | Open the Parts Library from the Codex sidebar.                       |
| Settings entrypoint    | Open the custom viewer settings.                                     |
| Structured settings    | Set units, grid visibility, and default camera with native controls. |
| Form elicitation       | Pick parts and references, or complete a CAD review form.            |
| Plugin onboarding      | Choose measurement units and grid preferences during setup.          |
| File handlers          | Open STL, 3MF, STEP, and STP files in the 3D viewer.                 |
| Resource reads         | Load CAD files into the viewer.                                      |
| Resource writes        | Save reoriented STL files.                                           |
| Resource subscriptions | Refresh the viewer when its file changes.                            |
| Trusted file paths     | Add the open file to the library using its host-provided path.       |
| Model context          | Share a selected surface, screenshot, and comment with Codex.        |
| Shared styles          | Match the Codex theme across all views.                              |
| Composer mentions      | Find library parts by name or tag from the composer.                 |

Click a part in the library to rotate, pan, and zoom its 3D model. Use Library to return to the catalog.

## Viewer inspection controls

Both the library viewer and the workspace-file viewer provide seven camera presets, Fit, solid/edges/wireframe/X-ray modes, a grid control, model bounds in millimeters or inches, and PNG capture. Inspection actions do not modify the source file. STL and 3MF coordinates are assumed to be millimeters for dimension readouts. The importer converts STEP and GLB geometry to millimeters.

The `SceneApi` returned by `mountScene` is the shared action interface for the buttons and future model tool registration. It exposes `setView(preset)`, `fit()`, `setDisplay(mode)`, `setGrid(visible)`, `setUnits(units)`, `getViewerState()`, and `captureView()`. Setters use absolute values. `subscribe(listener)` updates UI consumers; unsubscribe before disposing the scene. `captureView()` returns a PNG data URL, pixel dimensions, and the corresponding viewer state. Mounted app tools let the model inspect the current view, open a part, change the camera or render mode, rotate geometry, and save a file.
