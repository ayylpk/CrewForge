// 核心团队装配冒烟（零 LLM、零 DB）。
// 9/15 名册换代：后端开发/前端开发/Merger 三个工位退役，developer 座位由
// startDeveloperLine（developerTeamRunner.ts）在真跑时预占，createCoreTeam 不碰它。
import { TransferStation, roles } from "./Hub";
import { createCoreTeam } from "./projectRunner";

const team = createCoreTeam(new TransferStation({}, {}));
const counts = Object.values(team.station.status).reduce<Record<number, number>>((out, item) => {
  out[item.role] = (out[item.role] ?? 0) + 1;
  return out;
}, {});
const has = (role: number): number => counts[role] ?? 0;
const checks: [string, boolean][] = [
  ["one manager", team.managers.length === 1],
  ["one architect", has(roles.architect) === 1],
  ["one test station", has(roles.testEngineer) === 1],
  ["one maintainer", has(roles.maintainer) === 1],
  ["legacy dev/merger stations retired",
    has(roles.backendEngineer) === 0 && has(roles.frontendEngineer) === 0 && has(roles.merger) === 0],
  ["developer seat left to startDeveloperLine", team.station.status["developer"] == null],
];
let failed = 0;
for (const [name, ok] of checks) { console.log(`${ok ? "PASS" : "FAIL"} ${name}`); if (!ok) failed++; }
console.log(`Core team smoke: ${checks.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
