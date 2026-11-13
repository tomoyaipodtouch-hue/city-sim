# Airport forecourt v3: design note for implementation

Status: implemented (src/sim/forecourt.ts, world.ts, render/airport/geometry.ts, carLayer curb stops). See docs/airport-requirements.md section 4 for the as-built behaviour; sections below are the original design. The current forecourt (committed in a0a5e0a) is described under "Current state" below.
Audience: a fresh agent implementing the forecourt for 空港（小・中・大）.
See also docs/airport-requirements.md (section 4 アクセス). That section describes the current loop and must be updated when this lands.

---

## 1. User requirements and decisions

The user tested the deployed build (a0a5e0a) and called the forecourt toy-like: "おもちゃのような周回路だな残念".
The guiding image: **"そのまま都市高速が繋がって不自然な様子がない道"**, a road that looks as if the player's urban highway simply continues into the airport, with nothing unnatural anywhere.

Reference: **Haneda Terminal 3 forecourt**. It has an elevated departures deck along the facade, an arrivals curb in its shade below, and expressway ramps that lead straight onto the departures level.

### Requirements

1. **Same construction as the player's urban highway.**
   - The cross-section, viaduct, barriers, piers, surface, markings and lighting must match.
   - The road material and shaders come from `roadLayer.ts` and `roadMaterials.ts`, including their wear/noise and their kerbs, gutters and sidewalks.
   - No custom flat quads with ad-hoc colours.
   - Only the airport-specific parts are added beside the road: curb lanes, sidewalks, canopy, island, bays and signs.
2. **Highway continues at its level ("高架も地上もだな").**
   - **Elevated** urban highway at the main gate: it continues at its level straight onto the departures deck. Arrivals traffic diverges down a ramp to the ground curb road. The return merges back up onto the highway.
   - **Ground** urban highway at the main gate: it continues at ground level straight into the arrivals curb road. Departures diverge up a smooth ramp onto the deck. The return merges back at ground.
   - In both cases there is no change of level at the gate, and the result is one continuous structure.
   - **Ordinary roads** (street, road, one-way, avenue) can also connect at the main gate. They join at ground level, the same way as a ground highway.
3. **Curves are the key ("カーブとかが肝かも").**
   - No 90° kinks anywhere: gate approach, diverge and merge ramps, turns onto the curb roads, U-turns, garage spurs, return.
   - Radii:
     - about 30–60 m on ramps and the approach;
     - curb roads run straight along the facade;
     - U-turns are generous semicircles, larger than 25 m radius where space allows. Reshape the layout so they fit (section 4).
   - Tangent entry and exit with transition easing, as in the JCT fairing (`src/render/jctCurve.ts`).
   - Markings, barriers, deck edges and kerbs follow the curves continuously. Cars follow the same curves.
   - Test: forecourt road centrelines never turn more than about **7°/m**, mirroring the JCT edge-continuity test.
4. **City cars drive the loop.**
   - Remove the hand-off model (`loopCars.ts`, where cars appear and vanish at the gate). It may stay only for taxis and buses parked in the bays.
   - Traffic comes from the `carLayer` city stream:
     1. Airport-bound cars take the departures deck and pull into the curb lane.
     2. They stop briefly to drop off.
     3. They leave via the U-turn and the return, then go back into the city or onto the highway.
     4. Pick-ups work the same way on the ground arrivals curb.
     5. Taxis queue at the taxi pool, and buses stop at the bays.
   - There are no deadlocks: the curb stop is intentional and short, and must not trigger axis-lock or stuck removal (STUCK = 30 s in `carLayer.ts`).
   - There are no extra per-frame allocations.
5. **Markings: minimal and realistic.**
   - Continuous edge lines and dashed lane dividers. Japanese standard: 5 m line / 5 m gap on urban roads, 8 m / 12 m on expressways. Reuse the road layer's marking code.
   - Correct lane widths (about 3.25 m).
   - Stop lines and crosswalks in the proper places: sidewalk to island, island to the car park or station.
   - Curb paint for no-stopping zones.
   - Arrows only near decision points.
6. **Curb details.**
   - Departures deck sidewalk about 6–8 m wide, with a paving pattern and bollards along the curb edge.
   - Benches, entrance doors with canopies at intervals, luggage carts, people, and the roof's columns.
   - The terminal roof cantilevers over the departures curb (the curb sits under the roof edge).
   - The island canopy is deep, with a timber soffit and a glazed edge, on columns.
   - The deck is about 8–10 m up, on substantial piers. It casts a deep shadow on the arrivals curb.
   - Overhead sign gantries (出発 / 到着 / 駐車場) are spaced realistically before the split. They use green and blue panels with simple glyphs.
7. **Gates.**
   - Main gate (正門): the public entry. It has no guardhouse.
   - Service gate (通用門): the cargo and maintenance entry, for ordinary roads only, with a guardhouse.
   - Roads touching the lot elsewhere do not connect. (This already holds.)
8. **Car parks.**
   - Multi-storey garages with real facades: spandrel panels, ramp, lit at night.
   - Reached from the return leg.
   - Connected to the terminal by a covered pedestrian bridge at the departures level.
9. **Trees.** Consistent rows on the medians and in the landscaped area inside the U; no random speckles.
10. **Elevated station.** Keep the existing elevated station showcase. Its glazed bridge lands on the deck sidewalk: the bridge runs over the deck lanes at about deck + 5.5 m, with an escalator box down to the deck sidewalk.
11. **Sizes.**
    - 小: compact, a short deck with 1 curb + 1 through lane.
    - 中: medium.
    - 大: the full Haneda-T3-like forecourt.
12. **Performance.** Batch the geometry and instance the props. Report the extra draw calls and triangles against the heavy city.

---

## 2. Architecture: the forecourt is made of real road cells

**Idea.** When the airport is placed, it lays real road cells on the landside band of its lot, using the game's own road types. These cells form the forecourt. The airport building no longer owns those cells.

What follows from this:
- **Rendering:** `roadLayer` draws them exactly like player roads: viaducts, parapets, piers, lights, markings, sidewalks and kerbs.
- **Simulation:** trips route physically over them; the road graph includes them.
- **Cars:** `carLayer` drives them like any other road. Curves use the JCT fairing, so cars follow the faired curves.

### 2.1 Building blocks (existing code)

Grid arrays (`src/sim/grid.ts`):

| Array | Meaning |
|---|---|
| `road` | ground road type |
| `up` | elevated road type |
| `conn`, `conn1` | 8-direction connection bits for ground and elevated |
| `flow`, `flow1` | one-way flow bits for ground and elevated |
| `upH` | elevated deck height |
| `jct` | 1 = ground JCT ramp, 2 = elevated JCT ramp (cells of type `RoadType.Ramp`) |
| `bldg` | building id; roads cannot be placed on a building cell |

Road types: `UrbanHighway` 8 (elevated, two-way), `UrbanGroundHighway` 9 (ground, two-way), `UrbanHighway1W` 10 (elevated, one-way, 2 lanes), `UrbanGroundHighway1W` 11 (ground, one-way, 2 lanes), `Ramp` 7.

Road planning (`src/sim/plan.ts`):
- `planLine(g,x0,y0,x1,y1)` returns a LinePath `{cells, dirs}`.
- `planRoad(g, path, type)` returns a `RoadPlan`; `applyRoad(g, plan)` applies it. A LinePath with arbitrary 8-connected cells can be passed.
- The private `link(g, a, la, b, lb, d, oneWay)` connects nodes across layers.
- `linkUrbanEnds(g)` turns an elevated urban dead end that sits over a ground road into a slope down to that road.
- `snapRoadEnds` snaps a drawn end to an adjacent dead end. Airport gate cells are exempt via `g.gateCells`.

JCT ramps (`src/sim/jct.ts`):
- `commit()` writes Ramp cells and sets `upH = ground + steps × JCT_HSTEP` (2 m per cell, at most one step per cell). It sets `g.jct` bits.
- `src/render/jctCurve.ts` `findJctChains(g, lift)` finds chains of jct Ramp cells between their end mains or forks and fairs them: 1 m points with Gaussian smoothing, roughly 30–40 m radii, tangent to the mains.
  - `roadLayer` (line about 2409) draws these chains.
  - `carLayer` (line about 821) has cars follow them through `jctSegs`.
- The tests in `tests/jct.test.ts` and `tests/jctFlow.test.ts` (headless car flow) are the models for the new tests.

### 2.2 Forecourt topology

Coordinates are the land frame (a = along the terminal, c = outward), as used by `landToLot` and `lotToLand` in `src/sim/airport.ts`.

```
            gate cell (player's road ends here; outside the lot)
                 │ approach (two-way, same type and level as the player's road)
                 ▼
           split (Y): inbound one-way ─────────────►┐
                       outbound one-way ◄───────────┤ merge
 ───────────────────────────────────────────────────────────────
 Row F  elevated 10: departures deck  ◄──── (curb on terminal side)
 Row F  ground   11: arrivals curb    ◄──── (in the deck's shade)
        landscape / tree rows / island crossings
 Row R  ground   11: return           ────►
 West end: ground U (F→R) and elevated U (F→R at deck level, then down-ramp merging into R)
 ───────────────────────────────────────────────────────────────
```

**Rows.**
- Row F (frontage) runs along the facade. It is two stacked one-way cells on the same cells: ground 11 (arrivals) and elevated 10 (departures). Traffic flows toward −a, so with right-hand driving the curb is on the terminal side.
- Row R (return) is ground one-way 11, flowing toward +a, on the outer side.

**U-turns.** Both U-turns are at the west end, made of JCT-style Ramp cells, so they are faired.
- The ground U runs F(ground) → R.
- The elevated U runs F(elevated) → an elevated return stub. The stub descends with jct height steps and merges into R (or becomes R).
- A U made of Ramp cells is one lane. If a two-lane U is wanted, use one-way urban cells for the arc and extend the fairing to them; this is risk 6 in section 8.

**Gate approach.**
- *Elevated highway at the gate:*
  - The approach continues elevated at the same level as the deck. The deck height is set to the approach height, about 9 m: the urban `lift`.
  - The inbound branch continues straight onto the deck, row F elevated.
  - A diverge Ramp chain goes down from the inbound branch to the start of row F ground (arrivals).
  - The return R merges into the outbound branch through an up Ramp chain.
- *Ground highway or ordinary road at the gate:*
  - The approach is ground.
  - The inbound branch continues into row F ground (arrivals).
  - A diverge Ramp chain goes up to row F elevated (departures).
  - R merges into the outbound branch at ground.

**Recommendation: build only the approach that matches the connection.**
- On plop, lay rows F and R, the U-turns and a short ground approach stub to the gate.
- When the gate connection's level changes (detected in `afterGridChange` or the monthly traffic pass), rebuild the approach and its diverge/merge ramps for that level.
- This avoids dead-end elevated stubs when nothing is connected.

**Split topology needs verifying.** A two-way urban cell joined to two one-way urban branches is an unverified case in the junction rules: `urbanTurnOk`, flow bits, and the junction controllers (`ictl`). If it does not work cleanly, make the approach a pair of one-way cells (inbound and outbound) from the gate cell inward. The player's two-way highway then meets the pair at the gate cell exactly as it meets a one-way pair drawn by hand. Test this first.

**Destinations.**
- Departing passengers: `assignTrips` only checks destinations on ground (layer 0) and walk nodes. Keep a hidden terminal node: a lot cell with no road, linked from the elevated curb nodes (N + cell) and the ground curb nodes with short car links of about 0.5 min. This is the existing `term` link in `World.airportAccess`, minus the virtual loop.
- The road graph itself now carries the loop: the virtual depRamp, depCurb, depU, arrCurb, arrU and ret nodes and their links are deleted.

**Car parks.**
- Short Ramp spurs from row R lead into the garages, faired the same way.
- In the sim, the garages can be destinations for park-and-fly. This is optional.

**Service gate.** Unchanged in the sim: an ordinary road to the cargo area. Its service road can also become real road cells for consistency (lower priority).

**Ownership.**
- Store the airport's road cells, so they can be removed with the airport and protected from player edits.
- The bulldoze tool should refuse them unless the airport itself is bulldozed.
- Option A: a new grid array `aport` (u8, saved). Add it to `GRID_U8`, and the save format follows automatically.
- Option B: derive the set from the building list on load (deterministic from the layout and frame). B avoids a format change.

### 2.3 Per-orientation rasterisation

Use the land-frame polylines for each row, U, ramp and approach: rows are straight lines; U-turns are semicircles with tangent entries; ramps are smooth S-curves.

To rasterise a polyline:
1. Sample every about 2 m.
2. Map each sample to a world cell with `toWorld(f, landToLot(...))`.
3. Remove duplicates.
4. Insert a bridging cell wherever two consecutive cells are not 8-neighbours.
5. Remove backtracks.

Each step must be one of the 8 directions; record it in `dirs` for `planRoad`.

The result by orientation:
- **Axis orientations (even rot):** rows are grid rows or columns, so a straight row is a straight cell line. Row spacing is 16 m.
- **Diagonal orientations (odd rot):** rows become pure diagonal cell lines (x+k, y+k), 45° paths that the road system supports. Adjacent diagonal rows are 11.31 m apart. Choose row offsets in multiples of the diagonal pitch, so the rows land exactly on diagonal cell lines without zig-zag.
- **U-turns and ramps:** the rasterised cells only define the graph and footprint. The visible shape comes from the JCT fairing, so the stair-stepped cells do not show. They must form a simple 8-connected chain, at most 45° per cell. The JCT rule is "向きは 1マスに 45° まで"; enforce it, and if the raster breaks it, smooth the sample polyline or enlarge the radius.

Cells must lie inside the lot, except the gate cell. The building's `g.bldg` marking must exclude them: `plopAirport` places the building over the lot cells minus the forecourt cells. The flattened ground (`applyAirportGround`) still covers the whole lot.

---

## 3. Cross-section per size (land frame, m)

Lane width is 3.25 m. Row F is one cell of urban 1W: 2 lanes (curb + through) per level, which matches "1 curb + 1 through" for 小. For 中 and 大, either:
- accept 2 lanes per level, which matches the user's "few lanes" wish; or
- lay two adjacent rows: an outer row of 1W for through traffic plus the island lane. This needs lane-change behaviour in `carLayer`.

Recommendation: one row (2 lanes) per level for all sizes. Put the extra realism in the curb features: the island and bays sit beside row F on the lot side of the road, as non-road geometry.

Deck height: the elevated approach carries the player's lift, about 9 m. Use the same `upH` for row F elevated, so the deck is level with the highway.

---

## 4. Layout reshaping and U radii

Constraint: a U with radius R needs 2R between the F and R centrelines. The landside depth (terminal facade to lot edge) is too small for R > 25 m alongside the terminal. So **the U bulges past the terminal end**, into an area freed by relocating the west car park, and R can run inward to an S-curve before the station. Radii below are targets for the faired centreline.

| | Lot landside | Terminal facade | Row F centre | Row R centre | U centre / radius | Notes |
|---|---|---|---|---|---|---|
| 小 (C = 192, edge c = 96) | c 38..96 | 56 (terminal c 46..56; was 62) | c ≈ 64 | c ≈ 80 along the terminal; S-curve out to c ≈ 92 past the station end | U at a ≈ −150, c ≈ 68, R ≈ 24–26 m; needs a clear area a −200..−100, c 40..96 | Move the west car park east of the gate (loop garage). The station stays at the edge (c 86..96, a ±66). R runs in front of it at c ≈ 80, so the station's glazed bridge crosses R and F. |
| 中 (C = 288, edge c = 144) | c 66..144 | 92 (terminal c 80..92; was 100) | c ≈ 100 | c ≈ 120 in front of the station; widens to c ≈ 140 west of a = −110 | U at a ≈ −210, c ≈ 118, R ≈ 25 m (spans c 93..143) | Move the west car park (a −340..−200) outside the U, or put it inside the U as Haneda P-garages are; the departures bridge goes from the garage to the terminal end. Tower at a −470..−400 is unaffected. Hotel and office stay east. |
| 大 (land frame: A ±240, edge c′ = 130; runway clearance requires \|a′\| < ~255) | c′ 44..130 | 44 | c′ ≈ 52 | c′ ≈ 90 | U at a′ ≈ −200, c′ ≈ 71, R ≈ 19 in-plane, ≈ 30 if R swings to c′ ≈ 110 at the west end | Garages, hotel, office and plaza move to c′ ≥ 98 (garages ±(150..200) → c′ 98..128; plaza c′ 98..114; station 118..129). Use the full depth for the U, with the hotel and garage kept clear of the west end. The gate stays at a′ ≈ 225, east. The deck spans about −200..+110. |

The diverge and merge ramps (approach ↔ rows) need about 30–60 m radii and a ≤ 8% grade: about 110 m for a 9 m rise. Room:
- 小: gate a 290 → deck east end 92: 190 m ✓.
- 中: 400 → 160: 240 m ✓.
- 大: 225 → 110: 115 m. Tight; use a ≤ 8–10% grade, or move the deck east end to about +80 (the terminal extends to 180).

For diagonal placements, the same land-frame numbers rasterise onto diagonal cells; re-check for no gaps.

---

## 5. Code touch points

| File | Change |
|---|---|
| `src/sim/airport.ts` | Replace `landLoop`, `loopRoute` and `loopNodes` with `forecourtPlan(n, f, L, gate: GateCell, level)`. It returns cell paths `[{cells, dirs, type, level, jct?, heights?}]`, the forecourt cell set, and the named nodes (curb, term, U, gate stub). Add the per-size forecourt spec to `AirportLayout` (row offsets, U centre and radius, ramp anchors). Keep `gatePoints`, `gateCellAt`, `airportPorts`, `gateLink` (the gate must still be the cell just outside the lot) and `airportGateCells`. Update the layouts (section 4). |
| `src/sim/world.ts` | `plopAirport`: mark `bldg` over lot minus forecourt; lay the forecourt roads (free, internal) via `planRoad`/`applyRoad` and the JCT-style writer; run `linkUrbanEnds` and the junction normalisers. `airportAccess`: drop the virtual loop links; keep `term` links from curb nodes; the gate link now reads the real road continuity. Rebuild the approach when the gate level changes (hook in `afterGridChange`). Bulldozing an airport removes its forecourt cells. Bulldozing a forecourt cell alone is refused, so the bulldoze code must check ownership. `migrateAirports`: see section 6. |
| `src/sim/plan.ts` | Export a helper that lays an arbitrary cell path (wrapping `finishRoadPlan`/`planRoad` with a given LinePath) and a Ramp-chain writer equivalent to `jct.ts` `commit` (jct bits, `upH` steps). Make sure `snapRoadEnds`, `unjoinAlongEnds`, `linkUrbanEnds` and `normalizeAvenueJunctions` do not disturb airport cells. |
| `src/sim/jct.ts` | Reuse or extract `commit` (the Ramp + jct + `upH` writer) for airport ramps. |
| `src/sim/traffic.ts` | No change expected: Ramp jct cells already get JCT capacity and speed. Check `urbanTurnOk` at the split and merge. |
| `src/render/jctCurve.ts` | Confirm that `findJctChains` accepts chains whose ends are 1W urban rows (airport) and U-chains that start and end on different rows of the same road; extend if not. The kink test uses its 1 m points. |
| `src/render/roadLayer.ts` | Nothing should be needed for the road surfaces. Optional: suppress city sidewalks or kerbs where the airport draws its own curb sidewalk, or reuse them. |
| `src/render/carLayer.ts` | Curb stop: a Set of curb nodes (ground row F and elevated row F, terminal stretch) from the airport list, like `setStations`. A fraction of cars entering a curb node stop 6–20 s in the right lane, with a timer below STUCK. They must not hold an axis lock. Taxi pool: parked taxis are instanced by the airport layer; city taxis are optional. Buses: airport coaches parked in bays (airport layer). |
| `src/render/airport/geometry.ts` | Delete the landside road drawing: `ribbon`, the bands, U, ramps, gate stub, gantries' roads, dashed lines and arrows. Rebuild the curb features along the row F and row R centrelines, using the faired chains for any curved stretch: sidewalks, bollards, entrances, roof cantilever, island and canopy, bays, taxi pool, crosswalks, curb paint, gantries, tree rows, garages, bridges. Keep `terminal()` with the roof edge over the curb lane and `station()` with the bridge landing on the deck sidewalk. Move the main guardhouse to the service gate only. |
| `src/render/airport/layer.ts` | Remove the `LoopCars` wiring, except parked taxis and buses if kept. Rebuild when the airport's road cells change. |
| `src/render/airport/loopCars.ts` | Delete, or reduce to parked taxis and buses at the bays. |
| `src/render/airport/gse.ts` | Keep `taxi` and `coach` for the parked vehicles; `car` and `car2` may go. |
| `src/ui/tools.ts` | The placement preview shows the forecourt road cells (they become roads) and the gate. Road drawing must refuse airport cells. |
| `src/ui/airportPanel.ts` | Gate rows stay; wording: "正門で都市高速がそのまま続きます". |
| `docs/airport-requirements.md` | Rewrite section 4 for the cell-based forecourt. |

---

## 6. Legacy-save migration

Saves have `Building.airGate` undefined (oldest) or 2 (gates with the virtual loop, a0a5e0a). The new version is 3.

On `World.load` → `migrateAirports()`, for each airfield building with `airGate < 3`:
1. Compute the forecourt cells from the layout and frame.
2. Unmark their `bldg` and clear any trees or zones.
3. Lay the forecourt roads (free).
4. Keep the existing gate connection:
   - The player's road ends at the gate cell (version 2), or reconnect it with the existing radius-6 search (version undefined).
   - Rebuild the approach for the detected level.
5. If the forecourt cannot be laid, because something unexpected occupies a cell, keep the airport working without it: stay on the old virtual-loop model behind a flag, and say so in the info panel.
6. Set `airGate = 3`.

Old saves on version 2 already have player roads ending at the gate cells. After migration those roads must connect seamlessly to the new approach stub at the same level.

---

## 7. Tests

1. **Gate and topology, all 8 orientations × 小/中/大.** Draw an elevated urban highway into the gate.
   - The elevated approach continues level onto the deck: no ground cell between the gate and the deck.
   - Routing: far highway → deck curb → elevated U → return → far highway. Also far highway → arrivals curb via the diverge ramp.
   - Repeat with a ground urban highway: it continues at ground into arrivals; the departures diverge goes up.
   - Repeat with an ordinary avenue or road at the gate.
   - A road touching the lot elsewhere does not connect (existing test).
   - Service gate (existing test).
2. **Kink test.** For every forecourt chain (`findJctChains` output for airport cells, plus the straight rows): the heading change per metre along the 1 m points is ≤ 7°/m, mirroring the JCT edge-continuity test. U radius ≥ 25 m where specified (中, 大); ≥ 20 m for 小.
3. **Headless car flow** (model: `tests/jctFlow.test.ts`). City with the airport connected by an elevated urban highway, plus a ground road. Run `carLayer` headless:
   - cars enter the forecourt, stop at the curb (curb-stop count > 0), complete the U-turn and leave;
   - zero stuck removals;
   - no per-frame allocations (follow the existing pattern if the jctFlow test checks this).
4. **Ownership.** Bulldozing a forecourt cell is refused. Bulldozing the airport removes the forecourt roads.
5. **Legacy migration.** A version-2 save with a highway at the gate loads with the forecourt laid and routing intact. An undefined-version save reconnects via the radius-6 search.
6. **Regression.** Existing `airport.test.ts`, `airportM.test.ts`, `airportL.test.ts`, `airportOps.test.ts`, `jct.test.ts` and `jctFlow.test.ts` all pass.
7. **Visual verification (manual, Playwright).**
   - Close-ups from the user's camera angle: oblique, from the gate looking along the forecourt (see the user's screenshot from a0a5e0a).
   - For each size and for 0° and 45°, save before/after shots to `scratchpad airport/fc_*.png`.
   - Judge every shot against the guiding image: does it look like a natural continuation of the highway?
8. **Performance.** Use `scratchpad airport/perf.cjs` with `ID=airport_N CLEAR=1` against the heavy city. Report the extra calls and triangles.

---

## 8. Risks

1. **Y split and merge of two-way and one-way urban cells.** The junction rules may not support it cleanly. Fallback: a one-way pair approach from the gate cell.
2. **The JCT fairing assumes JCT topology** (ends on mains or forks). Airport U-chains connect two rows of what is logically one loop; `findJctChains` may need small extensions. `mainLocal`, `jHalf` and the Y-fork width growth must behave.
3. **Grid limits.** 45° per cell, 2 m height steps per cell (about 12%). A 9 m deck needs at least 5 cells of ramp (80 m); fairing gives a smooth profile. Diagonal row pitch is 11.31 m.
4. **The road maintenance passes run on load and after edits:** `unjoinAlongEnds`, `linkUrbanEnds`, `pruneORamps`, `levelHighwaysOverRail`, `normalizeAvenueJunctions`. They may rewrite airport cells. Add guards, or run them before laying the forecourt.
5. **`carLayer`:** the curb stop must not trigger STUCK (30 s) or block junction axis locks. Cars on a 2-lane 1W row need to pass a stopped car (lane choice).
6. **Ramp cells are one lane.** A two-lane U would need 1W urban cells on curved chains, which the fairing does not cover yet.
7. **Elevated station and terminal roof** must follow the new deck position and height. The station's bridge supports must not land in lanes.
8. **Save format**, if a new grid array is added (option A in 2.2).
9. **The gate cell is outside the lot.** Other buildings or zones may occupy it; the preview shows it, and the panel explains.
10. **Performance:** more road cells are cheap. Curb features must be batched and instanced: bollards, people, carts, trees.

---

## 9. Current state (at a0a5e0a, committed; working tree clean)

Committed and working:
- **Gates** (`src/sim/airport.ts`): `gatePoints`, `gateCellAt`, `GateCell`, `gateLink` (main: urban highway or ordinary road; service: ordinary road), `airportGateCells`. `airportPorts` returns `gate` and `svc`. `planAirport` no longer requires an adjacent road.
- **Gate cells exempt from end-snapping:** `g.gateCells` (`grid.ts`), `snapRoadEnds` (`plan.ts`), `World.refreshGateCells`, and the `tools.ts` preview cache.
- **World** (`src/sim/world.ts`):
  - `airportAccess(b)` holds the virtual loop nodes and car links (depRamp/depCurb/depU/arrCurb/arrU/ret/term), plus the service gate ↔ cargo cell link.
  - `accessCells(b)` returns only the gate road cells.
  - `migrateAirports()` uses `airGate = 2` and the radius-6 reconnection, with the `airLegacy` flag.
  - The traffic pass uses gate-based destinations: `term` for passengers, ground gate cells for freight.
- **UI:** the placement preview shows the gates (blue and orange with approach cells); the info panel has 正門 and 通用門 rows with the compass direction.
- **Forecourt v2, the one the user rejected:**
  - `landLoop`, `loopRoute` and `loopNodes` in `airport.ts`;
  - custom ribbon and flat-quad roads, U-turns, ramps, gantries and the guardhouse in `geometry.ts` (the landside block after "通用門と構内道路");
  - `src/render/airport/loopCars.ts`, the animated hand-off cars;
  - `gse.ts` car, car2, taxi and coach;
  - the `layer.ts` `LoopCars` wiring;
  - layout bands in `roadC` and `viaduct`.
  - All of this is replaced by the cell-based forecourt.
- **Tests:** `tests/airportGate.test.ts` has 9 tests. They include the virtual-loop routing and `loopRoute` geometry tests, which must be rewritten for the physical forecourt.
- **Large airport (大):**
  - layout, ops (moving-block departures, queueing, waiting-time order, hub turnarounds 800–1,500 s), geometry (concourse, plaza, oriented stands, multi-runway markings), tests (`tests/airportL.test.ts`);
  - performance: +32 to +38 calls, about +50k triangles.
  - Departure capacity is about 21 per hour (single departure taxiway). That is acceptable for now.

Uncommitted: none. The working tree is clean; nothing from this redo was started in `src/`.
