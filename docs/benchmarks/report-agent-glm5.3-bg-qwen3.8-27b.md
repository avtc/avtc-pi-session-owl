# bench-compact — ae2d92c1 · run 2026-08-23-2

Started 2026-08-24T15:55:13.273Z · cfg cfg-680f35 · scenario ae2d92c1 · backup build
Config: eval=zai-proxy/glm-5.3 (xhigh) · judge=(default) (null) · K=3 · judge2=(default) (null) · judge3=(default) (null) · N=3 · compactionBoundary=140000 · arms A1,A2,A3,A4,A5
Tool versions: A1 bare-pi · A2 om-default@g0c42d9 · A3 session-owl-builder@gac8c7d · A4 session-owl-selector@gac8c7d · A5 om-full@g0c42d9

## Results   (rates in %; [95% CI]; ΔvsA1 = arm − A1 (raw; ⚠ = worse than A1); rank 1=best; ↑/↓ polarity)
| Metric | A1 bare-pi | A2 om-default | A3 session-owl-builder | A4 session-owl-selector | A5 om-full |
|---|---|---|---|---|---|
| E5.1 recall-accuracy-explicit (↑) | 100% [100%–100%] | 87% [73%–97%] [-13]⚠ | 100% [100%–100%] [+0] | 100% [100%–100%] [+0] | 90% [77%–100%] [-10]⚠ |
| E5.2 recall-accuracy-from-summary (↑) | 21% [4%–38%] | 23% [10%–40%] [+2] | 78% [56%–94%] [+57] | 77% [60%–90%] [+56] | 43% [27%–60%] [+23] |
| E5.3 recall-accuracy-absent-in-summary (↑) | 11% [0%–33%] | 22% [0%–56%] [+11] | 100% [100%–100%] [+89] | 56% [22%–89%] [+44] | 22% [0%–56%] [+11] |
| E6 abstention (↑) | 100% [100%–100%] | 100% [100%–100%] [+0] | 100% [100%–100%] [+0] | 100% [100%–100%] [+0] | 100% [100%–100%] [+0] |
| E8 supersession (↑) | 100% [100%–100%] | 100% [100%–100%] [+0] | 100% [100%–100%] [+0] | 100% [100%–100%] [+0] | 100% [100%–100%] [+0] |
| C1 footprint (↓) | 2.5K | 4.8K [+2.3K]⚠ | 3.1K [+675]⚠ | 1.3K [-1.1K] | 2.2K [-295] |
| C3 run-cost/answer (↓) | $0.011/11s | $0.018/16s [+$0.007]⚠ | $0.022/21s [+$0.011]⚠ | $0.029/19s [+$0.018]⚠ | $0.022/16s [+$0.010]⚠ |
| C3 run-cost total (↓) | $0.901/929s | $1.447/1275s | $1.215/1325s | $2.454/1760s | $1.860/1272s |
| C4 compaction-cost (↓) | $0.198/72s | $0.386/582s [+$0.188]⚠ | $0.634/941s [+$0.435]⚠ | $0.801/1036s [+$0.603]⚠ | $0.617/1398s [+$0.419]⚠ |

## C4 breakdown (per arm: tokens in/out/cacheR/cacheW + $ + wall + stages)
| Arm | in | out | cacheR | cacheW | $ | wall | stages |
|---|---|---|---|---|---|---|---|
| A1 bare-pi | 124.8K | 5.3K | 0 | 0 | $0.198 | 72s | native-summary |
| A2 om-default | 160.5K | 22.8K | 233.0K | 0 | $0.386 | 582s | observer+reflector+pruner |
| A3 session-owl-builder | 251.3K | 38.7K | 429.2K | 0 | $0.634 | 941s | observe+build+select |
| A4 session-owl-selector | 303.1K | 42.0K | 738.3K | 0 | $0.801 | 1036s | observe+build+select |
| A5 om-full | 188.8K | 61.3K | 318.1K | 0 | $0.617 | 1398s | observer+reflector+pruner |

## Probe breakdown — E5.1 recall-accuracy-explicit
| Probe | A1 | A2 | A3 | A4 | A5 |
|---|---|---|---|---|---|
| p1 · What does our single locked-in constraint on the whole game's... | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| p2 · How many consecutive turns at negative cash does a company ha... | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| p3 · A retired model keeps contributing legacy quality to its comp... | 3/3 | 2/3 | 3/3 | 3/3 | 3/3 |
| p4 · What are the point cost, dev time, and cash cost of each mode... | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| p5 · What's the current status of the smoke test suite and the aut... | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| p6 · What was the cause of the share-deflation bug the --play arc ... | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| p7 · Which parts of the game has the user explicitly locked in / s... | 3/3 | 0/3 | 3/3 | 3/3 | 0/3 |
| p10 · In the R&D pane, the Start Project button now disables with a... | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| p11 · What does a rival's persona `researchBudget` field drive in t... | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| p12 · When adding the cash dimension to R&D, are we allowed to chan... | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| **rate** | 100% | 87% | 100% | 100% | 90% |

## Probe breakdown — E5.2 recall-accuracy-from-summary (latent, cued)
| Probe | A1 | A2 | A3 | A4 | A5 |
|---|---|---|---|---|---|
| pl1 (A1) · Before the economy recalibration, at the original 0.05 take r... | 0/3 | — | — | — | — |
| pl10 (A1) · After the share-leak fix, the autopilot arc showed every firm... | 0/3 | — | — | — | — |
| pl2 (A1) · In the representative 40-turn playthrough (after the share-le... | 0/3 | — | — | — | — |
| pl3 (A1) · In the first broken playthrough (before the share-leak fix), ... | 0/3 | — | — | — | — |
| pl5 (A1) · In the observed pre-inflation playthroughs, which specific ri... | 1/3 | — | — | — | — |
| pl7 (A1) · When one edit in a multi-block edit batch failed to match its... | 3/3 | — | — | — | — |
| pl8 (A1) · When building the initial single-file skeleton, roughly how l... | 1/3 | — | — | — | — |
| pl9 (A1) · When the assistant headlessly exercised the player-bankruptcy... | 0/3 | — | — | — | — |
| pl1 (A2) · Besides making legacy decay faster or down-weighting legacy q... | — | 2/3 | — | — | — |
| pl10 (A2) · Did the agent worry that score-based share recomputation with... | — | 0/3 | — | — | — |
| pl11 (A2) · In the original skeleton plan, before the final five RIVAL_PE... | — | 3/3 | — | — | — |
| pl12 (A2) · When requesting persona-tied starting capital, the user state... | — | 0/3 | — | — | — |
| pl2 (A2) · The "(b) a rival moved meaningfully" assertion uses a movemen... | — | 1/3 | — | — | — |
| pl3 (A2) · While hunting for a way to make natural bankruptcies happen, ... | — | 0/3 | — | — | — |
| pl4 (A2) · In the first competition-phase smoke run, what was the state ... | — | 0/3 | — | — | — |
| pl5 (A2) · Before recommending cash costs for R&D projects, what other w... | — | 0/3 | — | — | — |
| pl6 (A2) · When approving the R&D cash-cost step, which specific existin... | — | 0/3 | — | — | — |
| pl9 (A2) · When diagnosing the broken first autopilot arc, besides the s... | — | 1/3 | — | — | — |
| pl1 (A3) · What did the user expect the cash trajectories to look like i... | — | — | 3/3 | — | — |
| pl2 (A3) · When recalibrating the competition economy after finding the ... | — | — | 3/3 | — | — |
| pl3 (A3) · Besides the R&D point economy math and the share-scoring form... | — | — | 2/3 | — | — |
| pl5 (A3) · In the one-shot headless verification of the player-bankruptc... | — | — | 3/3 | — | — |
| pl6 (A3) · Before deciding to keep the additive legacy-quality term as-i... | — | — | 2/3 | — | — |
| pl7 (A3) · When diagnosing the "no money tension" arc, what cost-structu... | — | — | 1/3 | — | — |
| pl1 (A4) · In the first clean `--play` arc (after the share-deflation fi... | — | — | — | 3/3 | — |
| pl10 (A4) · Before the cash-dimension step, what starting cash did the pl... | — | — | — | 2/3 | — |
| pl11 (A4) · When setting up the first headless smoke test, did the agent ... | — | — | — | 1/3 | — |
| pl2 (A4) · Why were the economy constants recalibrated during the compet... | — | — | — | 2/3 | — |
| pl3 (A4) · In the first clean `--play` run (pre-cash dimension), how muc... | — | — | — | 3/3 | — |
| pl4 (A4) · In the pre-cash `--play` runs, which rival tended to top the ... | — | — | — | 2/3 | — |
| pl5 (A4) · Besides tuning the legacy-decay constant, what alternative tr... | — | — | — | 3/3 | — |
| pl7 (A4) · After recalibrating the economy in the competition step, what... | — | — | — | 3/3 | — |
| pl8 (A4) · How many assertions did the smoke suite contain when the comp... | — | — | — | 3/3 | — |
| pl9 (A4) · When recalibrating the economy, what distinct options did the... | — | — | — | 1/3 | — |
| pl1 (A5) · Before the economy was recalibrated to TAKE_RATE 0.08 / OVERH... | — | — | — | — | 3/3 |
| pl11 (A5) · How did the agent verify the player game-over / overlay path ... | — | — | — | — | 0/3 |
| pl2 (A5) · When the user commissioned the R&D cash-cost step, which comp... | — | — | — | — | 0/3 |
| pl3 (A5) · Before settling on industry inflation (devCostNow/marketIndex... | — | — | — | — | 2/3 |
| pl4 (A5) · Besides a faster decay rate and weighting legacy below active... | — | — | — | — | 3/3 |
| pl5 (A5) · In the cash-cost step, what did the user explicitly say to ke... | — | — | — | — | 0/3 |
| pl6 (A5) · In the first autopilot --play run (before the share-leak fix)... | — | — | — | — | 3/3 |
| pl7 (A5) · In the representative post-leak-fix 40-turn arc (before cash ... | — | — | — | — | 0/3 |
| pl8 (A5) · MODEL_TIERS was first defined in the original skeleton. In th... | — | — | — | — | 1/3 |
| pl9 (A5) · When creating the headless smoke test, what approaches did th... | — | — | — | — | 1/3 |
| **rate** | 21% | 23% | 78% | 77% | 43% |

## Probe breakdown — E5.3 recall-accuracy-absent-in-summary (latent, uncued)
| Probe | A1 | A2 | A3 | A4 | A5 |
|---|---|---|---|---|---|
| pl11 (A1) · When the assistant first tried to headless-test the skeleton ... | 0/3 | — | — | — | — |
| pl4 (A1) · Before the full assertion-based smoke test existed, how did t... | 1/3 | — | — | — | — |
| pl6 (A1) · Besides the cash-cost recommendation, what unimplemented endg... | 0/3 | — | — | — | — |
| pl13 (A2) · What redundant ternary did the agent notice in its first ship... | — | 2/3 | — | — | — |
| pl7 (A2) · Why did several exact-text edits to smoke-test.js fail to mat... | — | 0/3 | — | — | — |
| pl8 (A2) · In the original skeleton design, what time period was one gam... | — | 0/3 | — | — | — |
| pl4 (A3) · Before the real competition/economy engine replaced it, what ... | — | — | 3/3 | — | — |
| pl12 (A4) · Did the original skeleton design include an in-game year/quar... | — | — | — | 0/3 | — |
| pl13 (A4) · At the end of the R&D-lifecycle step (before the competition ... | — | — | — | 3/3 | — |
| pl6 (A4) · While reviewing the pre-cash play arc, did the agent propose ... | — | — | — | 2/3 | — |
| pl10 (A5) · Why did the first attempt to syntax-check the extracted game ... | — | — | — | — | 0/3 |
| pl12 (A5) · Before the competition engine replaced the stubbed revenue ti... | — | — | — | — | 2/3 |
| pl13 (A5) · What did the skeleton's stubbed turn loop do for the AI rival... | — | — | — | — | 0/3 |
| **rate** | 11% | 22% | 100% | 56% | 22% |

## Probe breakdown — E6 abstention
| Probe | A1 | A2 | A3 | A4 | A5 |
|---|---|---|---|---|---|
| p9 · Is it still the case that every company (including the player... | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| p13 · Have we made a decision on whether to speed up the legacy-qua... | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| **rate** | 100% | 100% | 100% | 100% | 100% |

## Probe breakdown — E8 supersession
| Probe | A1 | A2 | A3 | A4 | A5 |
|---|---|---|---|---|---|
| p8 · How much starting capital does the player's company get? | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| **rate** | 100% | 100% | 100% | 100% | 100% |


answer cost per arm: A1 97.3Kin 46.4Kout $0.901 929s | A2 178.0Kin 66.5Kout $1.447 1275s | A3 223.9Kin 35.4Kout $1.215 1325s | A4 405.8Kin 62.9Kout $2.454 1760s | A5 361.4Kin 74.4Kout $1.860 1272s
recall cost per arm: A1 0 calls | A2 21 calls 47.9K tok 0.1s | A3 30 calls 98.7K tok 0.8s | A4 90 calls 228.2K tok 1.9s | A5 48 calls 176.3K tok 0.2s

## Reliability (per arm: completed/failed + notes)
- A1 bare-pi: 0/0 completed, 0 failed
- A2 om-default: 0/0 completed, 0 failed
- A3 session-owl-builder: 0/0 completed, 0 failed
- A4 session-owl-selector: 0/0 completed, 0 failed
- A5 om-full: 0/0 completed, 0 failed

## Artifacts
- scenario repo: C:\Users\ADMIN\.pi\bench-compact\scenarios\ae2d92c1\repo
- result-JSON: C:\Users\ADMIN\.pi\bench-compact\runs\2026-08-23-2\results.json
- judge outputs: C:\Users\ADMIN\.pi\bench-compact\runs\2026-08-23-2\judge
- config: C:\Users\ADMIN\.pi\bench-compact\configs\cfg-680f35.json