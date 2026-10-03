# High Frontier mission planner

This is a ~cheating tool~ mission planner for the board game [High Frontier](https://boardgamegeek.com/boardgame/281655/high-frontier-4-all). It can help you to find the best route from one place in the solar system to another. It's built in the browser, so there's nothing to download or install.

[☞ **Open HF Mission Planner (4th Ed.)**](https://ranma42.github.io/hf-mission-planner)

[☞ **Open HF Mission Planner (3rd Ed.)**](https://ranma42.github.io/hf-mission-planner?ed=3)

For example, this trajectory from LEO to the Sol-Oort exit takes 18 burns, 32 turns, and takes your spacecraft through 2 hazard zone-equivalents (a Saturn ring crossing, and several radiation hazard zones)
![Example trajectory from LEO to the Sol-Oort exit](docs/example-trajectory.png)

## About this fork

The planner is [nornagon/hf-mission-planner](https://github.com/nornagon/hf-mission-planner), and almost all of it is still that: the map, the editor, the search and this README started there. Upstream's own deployment is at [nornagon.github.io/hf-mission-planner](https://nornagon.github.io/hf-mission-planner), and is the one to use if you want the tool without any of what follows.

Modelling fuel at all is an idea taken from [LaertesKrabs/hf-mission-planner](https://github.com/LaertesKrabs/hf-mission-planner), where [afrind](https://github.com/afrind) added a fuel model alongside free pivots and per-metric constraints in [#1](https://github.com/LaertesKrabs/hf-mission-planner/pull/1). What is here is a different design for the same idea. There, fuel joins burns as a fifth thing to minimise; here, thrust goes back to being the per-turn allowance it always was, fuel becomes the thing actually worth spending less of, and burns are reported rather than optimised.

On top of upstream, this fork adds:

- **Fuel**, as the quantity routes are chosen to save.
- **Pivots**, as a per-turn allowance of free direction changes.
- **Explore**, which finds every worthwhile compromise between two points in one search rather than the single route your current ranking happens to prefer.
- **Priorities you can drag**, and burns and pivots reported alongside them.
- **Offline use**, via a service worker, so the planner keeps working at a table with no signal.

## Usage

The tool will load with the view over Earth, where the air is free and the breathing is easy. You can zoom the view with the scroll wheel, and pan by clicking and dragging. To plan a path from one place to another, click the point you want to start from, and the point you wish to end up at. Information about the planned trajectory is shown in the top-right corner. Press <kbd>Esc</kbd> to clear the current trajectory (or just click on a new starting point to plan your next path).

Once you have picked a starting point, every site is labelled with what it costs to reach, so you can see where a vehicle can get before committing to a destination.

### Your vehicle

The **Vehicle Info** panel describes what is being routed. Changing any of it re-plans the current trajectory.

- **Thrust** — the most burns the drive can make in a single turn.
- **Fuel per Burn** — tanks drawn per burn, as a fraction. A part-used tank is spent in full, and the rounding happens once per turn rather than once per burn, so packing burns into fewer turns is worth doing: at 1/3, three burns in one turn cost one tank, but the same three spread over three turns cost three. Set the first field to 0 for a drive that burns nothing and is limited only by its thrust.
- **Pivots** — direction changes through a Hohmann the drive can make each turn without spending the 2 burns they normally cost.
- **Solar Season** — which sunspot phase it is, which decides which synodic sites are open and whether the Venus flyby is available.
- **Site Hydration** and **Spectral Type** — which sites are worth labelling on the map.

### Comparing routes

Routes are ranked by fuel, then turns, then hazards, then radiation hazards. Drag those rows into the order you care about, or use the arrows. Burns and pivots are listed below them as read-outs: they follow from a route rather than being things to trade off against one another, so they are counted and shown but never optimised.

**Explore alternatives** replaces that list with every route that is best under *some* ordering of the four, not just the one your current ranking picks — so you can see what a turn is worth in fuel before deciding. Hover a row to preview that route on the map, and click it to keep it.

### Rules

The 📖 button in the top-left corner opens the rulebooks: Core, Appendix, Module 1 and Module 2. For each one there is the edition ION Game Design publishes for download and the current living rules. M1 has no living-rules PDF yet. There is also a list of the text changes between the two editions. The viewer can search the whole book. The PDFs are stored for offline use when the app is opened, and the rules page has a button that downloads any that are still missing.

### Edit mode

If you're developing this tool you might want to edit the map data to fix errors or update the map to a new version. You're in luck, HF Mission Planner has an edit mode optimized for fast input (and certainly not for ease of learning or intuitiveness). If you find yourself in a position to use it, the best reference is probably the source code, but here's a list of keyboard shortcuts as of writing:

- <kbd>Tab</kbd> - toggle between edit mode and view mode.
- Click to place a new node. The default node type is Hohmann, indicated by a green circle.
- <kbd>X</kbd> - delete hovered node.
- <kbd>M</kbd> - move hovered node to the current cursor position.
- <kbd>H</kbd> - mark hovered node as Hohmann type.
- <kbd>L</kbd> - mark hovered node as Lagrange type.
- <kbd>B</kbd> - mark hovered node as Burn type. Pressing <kbd>B</kbd> again will cycle through Lander burn, Half-lander burn and regular burn.
- <kbd>R</kbd> - mark hovered node as Radhaz type.
- <kbd>S</kbd> - mark hovered node as Site type. You will be prompted in turn for the site's name, its size and type, its water rating, and which synodic season (`red`, `yellow` or `blue`) it belongs to, if any. Pressing <kbd>S</kbd> again will let you edit those.
- <kbd>D</kbd> - mark hovered node as decorative. Decorative nodes are used to make paths follow the underlying map, and have no semantic meaning.
- <kbd>V</kbd> - mark hovered node as the Venus flyby, which gives a (+2) boost and is only usable in the blue season.
- <kbd>Y</kbd> - cycle hovered node's flyby boost through (+1), (+2), (+3), (+4) and back to none. Most flyby nodes on the map are Lagrange-equivalents.
- <kbd>O</kbd> - set hovered node's flyby boost to the vehicle's thrust, which is how the Solar Oberth manoeuvre is modelled.
- <kbd>Z</kbd> - mark hovered node as containing a hazard. Works on any node type; hazardousness is orthogonal to node type. Aerobrake nodes are modeled as hazard nodes.
- <kbd>A</kbd> - link two nodes together. The first node which <kbd>A</kbd> is pressed on is stored, and no link is made until a second node is selected by pressing <kbd>A</kbd> on it.
- <kbd>J</kbd> - download a formatted JSON export of the current map data.
- <kbd>0</kbd>–<kbd>9</kbd> - set label of hovered exit. This operates on the hovered node _and_ the hovered edge, which will be highlighted green. It sets the edge label for that entry/exit on the current node. Note that this can be different at different ends of the same edge. Exit labels are used to indicate which directions can be coasted through in a Hohmann: entering on a path labeled '1' means you can coast out through an exit labeled '1', but switching to a path with a different label costs 2 burns. The edge label '0' is special, and is used to indicate 1-way edges: the planner will never enter a node through an edge marked '0'. This is used to model aerobrake paths, which can only be traversed in one direction.

## Development

```sh
npm install
npm run start:dev   # webpack-dev-server
npm run typecheck   # tsc --noEmit; the source is JavaScript checked by JSDoc types
npm run build       # production build into dist/
```

The rulebook PDFs are too big for git, so `assets/rules/sources.json` records the URL and SHA-256 of each one instead:

```sh
npm run rules:fetch  # download them into .cache/rules/, check them, and copy them into dist/rules/
npm run rules:delta  # regenerate the committed assets/rules/*-delta.json from the fetched PDFs
```

To update a rulebook, change its entry in `sources.json` (url, `bytes`, `sha256`, `date`), then run both commands. A deploy fails if a download does not match its digest, or if a delta was made from other files.

Pushing to `main` builds and publishes to GitHub Pages via [`.github/workflows/deploy-gh-pages.yml`](.github/workflows/deploy-gh-pages.yml). The first run turns Pages on and points it at Actions itself, so a fresh fork needs nothing set by hand beyond having Actions enabled.
