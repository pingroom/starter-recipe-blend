# Recipe blend with PingRoom

Turn declared ingredient fractions into a recipe that meets a target constituent band. A named operator supplies each ingredient's fraction through PingRoom; code checks every permitted combination of equal-mass integer parts. Among recipes that meet the target, it chooses the lowest cost and resolves ties deterministically.

The example blends three paper stocks with different recycled-fibre fractions. The demo finds a recipe, shows an unreachable target, and withholds analysis for Unknown. It performs no mixing, purchases or deployments.

## Run offline

Use Node.js 22 or newer and npm. Choose **Use this template**, clone your copy, then run:

```sh
npm ci
npm test
npm run demo
```

Tests and demo use the real pinned `@pingroom/sdk` with mock transports. After installation they need no network, account, credentials or phone. The lockfile is committed; `.npmrc` requests a 14-day minimum release age on npm versions supporting it.

## Define the blend

```sh
cp examples/model.json model.json
cp config.example.json config.json
npm run validate
```

Edit `model.json` before asking for fractions:

- `blendId`: lowercase identifier, at most 32 characters; `title`: 32; `context`: 60.
- `partDefinition`: up to 40 characters describing one equal-mass part, such as `one 10 g dry-paper portion`.
- `constituent`: up to 60 characters defining the mass fraction being measured, such as `recycled fibre mass fraction`.
- `costUnit`: up to 20 characters, shared by every ingredient's cost.
- `totalParts`: integer 1–24.
- `targetMinPermille`, `targetMaxPermille`: inclusive integers 0–1000, with minimum no greater than maximum.
- `ingredients`: 2–4 records containing `id`, `label`, `maxParts` and `costPerPart`. IDs start with a lowercase letter, use lowercase letters, digits, `_` or `-`, and allow 12 characters. Labels allow 40. `maxParts` is an integer from zero through `totalParts`; `costPerPart` is an integer from zero through 999999.

Displayed-text limits use UTF-16 code units. Extra fields, duplicate/reserved IDs, fractional numeric inputs, negative zero, malformed Unicode, control/format characters, line breaks and surrounding whitespace are rejected. Full measurement prompts must fit 500 characters.

All parts must have the same mass and basis. Use consistent cost units and scale, such as integer minor units for decimal prices. Availability and cost are fixed inputs; the operator supplies only the constituent fraction.

## Connect and collect fractions

Install [PingRoom](https://pingroom.io/i), create a private standard room containing the operator, then run:

```sh
npm run connect
npm run inspect
```

Open the printed pairing link, approve the connection and grant the room. Verify the person in the app, then put their exact member UUID and descriptive label in `config.json`. A name alone is insufficient. For an existing granted connection, copy `.env.example` to `.env` and set both `PINGROOM_TOKEN` and the 12-character `PINGROOM_ROOM`. Partial pairs are rejected.

```sh
npm start
```

Each invocation creates at most one direct, 15-minute Question or reads the existing one. After the operator answers, run `npm start` to record the response, then again for the next ingredient. Prompts include the ingredient, constituent meaning, context and equal-mass part definition.

Reply with an integer **0–1000**, where 1000 means entirely the constituent, or exactly **Unknown**. Use digits without signs, decimals, spaces or leading zeros. Zero is a known fraction. Validation checks the API's returned text and cannot detect whitespace trimmed by the server.

Every ingredient requires a known fraction, including ingredients with zero availability or zero eventual usage. Unknown, missing, expired, cancelled, malformed or misattributed answers withhold all analysis and proposals. Evidence is bound to the original request, operator, room, asking registration, timestamps and calculation policy.

## Read and export

```sh
npm run status
npm run report
npm run export-analysis
npm run export
```

These commands are local. `report` writes `.blend/report.json`. `export-analysis` requires complete known fractions and writes `.blend/analysis.json`, including `infeasible` results. `export` also requires feasibility and writes `.blend/proposal.json`. Infeasible means the declared model has no permitted recipe; Unknown means evidence is incomplete.

Inside `analysis`, inspect `recipe`, `feasibleCount`, `tiedOptimalCount` and `evaluatedCompositionCount`. The recipe contains sorted ingredient IDs, integer counts, availability usage, exact total cost as a decimal string, and two unreduced ratios:

- `weightedPermille`: numerator `Σ(parts × fractionPermille)` over denominator `totalParts`.
- `constituentMassFraction`: the same numerator over `1000 × totalParts`.

Code checks the inclusive target by comparing the numerator with `targetMinPermille × totalParts` and `targetMaxPermille × totalParts`, without rounding. Products and costs use integer arithmetic. It examines at most 2,925 compositions. Equal-cost recipes use the lexicographically smallest count vector over sorted ingredient IDs: the smaller count at the first difference wins.

The additive mass, composition and cost model follows [PuLP's blending case study](https://www.coin-or.org/pulp/CaseStudies/a_blending_problem.html). This starter enumerates bounded integer combinations without a solver library. Declared permille values are treated as exact; measurement uncertainty, process loss, reactions, moisture conversion and nonlinear mixing are outside the model. A valid calculation does not verify measurements or physical suitability.

To adapt it, map your inventory into the manifest and define the common mass basis and constituent. Review the proposal before using it in another process. Changing part size changes the available integer recipes; this is not continuous optimization.

## Resume safely

Root inputs, credentials, state and exports are ignored by Git. Keep `.blend/` and `.pingroom/` private and intact. Reordering ingredients is harmless; changed meanings, costs, availability, targets, identity or credentials cannot reuse a saved session. Input/config limits are 64/16 KiB. Writes are atomic under a local lock.

A lost create response leaves `create_unknown` and is never automatically resent:

```sh
npm run status
npm run find-id
npm run recover -- EXACT-QUESTION-UUID
```

Recover only the original Question. No match in the bounded search does not prove creation failed. Resolve or revoke uncertain/expired pairing in Connected Agents before archiving its pending file. Remove a stale `.lock` only after confirming its process stopped. Resolve the original session before archiving it for a revised model; never delete state to retry.

Run commands serially. Exit codes: `0` complete/local result, including complete infeasibility; `1` invalid setup/evidence or refused export; `2` incomplete/failed answer; `3` pending/ready/interrupted; `4` uncertain creation.

Tests cover independent composition enumeration, boundaries, SDK/CLI recovery and private exports. GitHub Actions runs tests and demo on Node.js 22 and 24. Live phone delivery is not tested. MIT licensed.
