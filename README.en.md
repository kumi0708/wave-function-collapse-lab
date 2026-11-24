# Wave Function Collapse Lab

[日本語](README.md) | **English**

A browser demo that generates small villages with Wave Function Collapse (WFC). You can watch each step of the algorithm as it runs.
It is a JavaScript implementation of the socket-based, two-pass algorithm from [SpriteCook's “Wave Function Collapse Explained”](https://www.spritecook.ai/blog/wave-function-collapse-explained).

▶ **Play:** https://kumi0708.github.io/wave-function-collapse-lab/

- No dependencies: plain JavaScript and Canvas 2D.
- Every sprite is drawn in code. The project has no image files.
- Generation is deterministic. The same seed always gives the same village, and you can share one with a `#seed=…` URL.

---

## Controls

| Control | What it does |
|---|---|
| **▶ 生成を観察** (Watch) | Generates the village step by step, with animation |
| **⚡ 即時生成** (Instant) | Generates the whole village at once |
| **⏭ 1ステップ** / `→` | Advances one step |
| `Space` | Play / pause |
| `R` / 🎲 | Generates with a random seed |
| `N` | Switches between day and night |
| **候補 / エントロピー / なし** | Overlay for open cells: icons of the remaining options, an entropy heatmap, or nothing |
| **8px グリッド** | Shows the 4×4 spot grid of the detail pass and its open spots |
| **ディテール層** | Shows or hides the detail layer, so you can compare the result before and after the detail pass |
| **⤓ PNG** | Saves the current view as a PNG |

---

## How it works (technical)

### 0. Layout of the code

```
js/solver.js   Generic WFC solver (domains, entropy, propagation, RNG)
js/village.js  Village rules (modules, sockets, weights, both passes, restarts)
js/render.js   Rendering (noise ground, procedural sprites, lighting, ambient FX)
js/app.js      UI, animation loop, URL sharing
test/          Node test suite (200 seeds)
```

The solver has no village-specific logic. It takes a module count, a compatibility table, per-cell weights and initial domains, and solves the grid. Both passes run on the same solver.

### 1. Solver (`js/solver.js`)

**Domains are bitmasks.** Each cell's set of remaining modules is one `Int32Array` entry. Bit *m* is set while module *m* is still possible. Intersection is `&`, union is `|`, and the set size is a popcount. The solver supports up to 31 modules.

**Compatibility table.** `compat[dir][m]` is the mask of modules that may sit next to module *m* in direction *dir* (N/E/S/W). The table is precomputed from per-side socket labels and a list of allowed socket pairs.

**Shannon entropy** over the weights of the remaining options:

```
H = log(Σw) − (Σ w·log w) / Σw
```

A cell with one option has H = 0. The value is cached and recomputed only when the cell's domain changes.

**Observation (picking a cell):**
1. **Frontier first.** The solver only considers open cells next to a decided cell. This makes the village grow outward as one blob, not in scattered patches. If the frontier is empty, it considers all open cells.
2. **Lowest H plus noise.** It adds `rng() × noise` to break ties (0.05 in the layout pass, 0.3 in the detail pass). The noise is drawn again for each cell at each step.
3. **Weighted pick.** It picks a module for the cell at random, weighted by that cell's weights.

**Propagation (arc consistency).** Propagation is stack-based and starts from the collapsed cell:

```
pop c
for each direction d:
    support = OR{ compat[d][m] | m ∈ domain[c] }   ← memoized per (d, domain)
    new = domain[nb] & support
    if new changed:
        new == 0 → contradiction
        domain[nb] = new; push nb
```

A cell that propagation reduces to one option also counts as decided, and its neighbors join the frontier.

**Contradictions.** If a domain becomes empty, the pass **restarts with the next seed** (up to 50 attempts for the layout pass, 20 for the detail pass). There is no backtracking. As in the article, the rules are designed to rarely contradict. The 200-seed test suite needs 0 restarts.

**Determinism.** A single **Park–Miller** RNG (`state = state × 16807 mod (2³¹−1)`) drives the tie-break noise, the module picks and the forced first move.

### 2. Layout pass (`js/village.js`)

Each cell is the size of a 32 px tile. The pass uses 14 modules:

| Module | Sockets N E S W | Weight |
|---|---|---|
| Grass | G G G G | 2.2 |
| House | G G **D** G (door faces south) | 1.6 |
| Tree | G G G G | 1.4 |
| Road (11 pieces, 2–4 connected sides) | R on connected sides, s on the others | 0.3 × shape factor |

- **Shape factors:** straight 1.4, corner 0.7, T 0.3, crossing 0.08. Roads have 11 pieces, so each piece gets a small weight. Otherwise roads take over the map.
- **Allowed socket pairs:** `R–R`, `s–G`, `s–s`, `G–G`, `s–D`, `D–R`. The door socket `D` only touches `R` or `s`, so every house has a road piece below it. There are no dead-end pieces, so roads either loop or leave the map.
- **Unary rule:** no houses in the bottom row, because the door would have no room for a road.
- **Forced first move:** the solver places a house in one of the four middle cells. The village grows outward from there.

### 3. Detail pass

Each layout cell is split into **4×4 spots** (8 px each), and the same solver runs again with 10 modules:

`empty, flower, mushroom, tuft, pebble, bush, fence-left, fence-mid1, fence-mid2, fence-right`

- **Ground per spot.** The pass labels each spot as grass, dirt or covered, based on the layout:
  - Dirt: the center 2×2 spots of a road cell and its arms toward each connection, plus a 2-spot path in front of each door.
  - Covered: house cells, the top three rows of tree cells, and the bottom row of the cell directly above a house or tree, where the sprite overhangs. Covered spots can only be empty.
- **Per-cell weights tell a small story:**
  - Pebbles appear only on dirt.
  - Flowers get weight 2.2 within one spot of a house and 0.07 elsewhere.
  - Mushrooms cluster near trees.
  - Fences appear only in house yards (the cells around a house).
- **Fence sockets.** Fence-left has `Le` on its east side. Fence-mid1 has `M1w`/`M1e`, fence-mid2 has `M2w`/`M2e`, and fence-right has `Rw` on its west side. The allowed pairs are `Le–M1w`, `M1e–M2w`, `M2e–Rw` and `M2e–M1w`; the last pair lets a fence repeat its middle pieces and grow longer. Fence N/S sides use `x`, which only matches `o`, so fences never stack vertically. Together, these rules make **every fence start with a left end, finish with a right end, and span at least 4 spots**. Some fence pieces are banned in the edge columns, so no fence is cut off by the map edge.
- **Starting point.** The pass starts at the grass spot nearest the first house's door.

### 4. Rendering (`js/render.js`)

| Part | Technique |
|---|---|
| Ground | A scalar field from **smoothstep-bilinear interpolation** of the dirt spot centers, cut at 0.5. This rounds road corners, much like a dual grid. fBm value noise roughens the edges, and the result is written per pixel to `ImageData`. The grass uses three noise bands: low frequency for tint, mid frequency for clumps, and high frequency for speckles. Roads get a dark rim, and the grass beside them gets ambient occlusion. |
| Incremental updates | Only the area around newly decided cells is recomputed and uploaded with a dirty-rect `putImageData`. |
| Houses | Hip roofs with gradients, shingle rows, ridge lines and side shading. Also timber framing, a stone base, windows with flower boxes, an arched door and a chimney. Roof color, wall color, width and chimney side vary with a hash of the cell coordinates. |
| Trees | Broadleaf trees (layered radial-gradient leaf blobs with texture dots, some with fruit) and conifers. |
| Details | Petals, mushroom-cap spots, curved grass blades, pebble highlights, bushes with berries, and fence posts and rails. |
| Depth | All shadows are drawn first. Sprites are then **sorted by their bottom edge** and drawn in that order. |
| Atmosphere | Drifting cloud shadows and chimney smoke particles. At night, a multiply pass darkens the scene, additive window and door glows flicker, and fireflies appear. A vignette frames the map. |
| Visualization | Each open cell shows icons for its remaining options, with eliminated ones faded. Other overlays: an entropy heatmap, a frontier outline, a pulse on the last pick, and a red flash on a contradiction. |

The renderer keeps two layers. The **static layer** (ground, sprites and overlay) is redrawn only when the solver state changes. The **per-frame layer** (clouds, smoke, night and pulses) is redrawn every frame.

---

## Run locally

No build step is needed. The scripts are plain `<script>` tags, not ES modules, so opening `index.html` directly works. To serve the folder instead, run:

```bash
npx http-server . -p 8080
```

## Tests

```bash
node test/village.test.js
```

The suite generates 200 villages (18×12) and checks that:

- every seed finishes, with no contradictions or by restarting
- the same seed gives the same result
- no house is in the bottom row, and every house has a road below it
- every road connection meets a road, a door or the map edge
- pebbles appear only on dirt, and covered spots stay empty
- every fence starts with a left end, finishes with a right end, spans at least 4 spots and never stacks vertically
- every module is placed at least once, which catches rules that silently never fire

## Credits

- Algorithm design (modules, sockets, weights, two-pass structure): [SpriteCook — Wave Function Collapse Explained](https://www.spritecook.ai/blog/wave-function-collapse-explained)
- Original WFC: [mxgmn/WaveFunctionCollapse](https://github.com/mxgmn/WaveFunctionCollapse)
