import { TransferStation, roles } from "./Hub";
import { createCoreTeam } from "./projectRunner";

const team = createCoreTeam(new TransferStation({}, {}));
const counts = Object.values(team.station.status).reduce<Record<number, number>>((out, item) => {
  out[item.role] = (out[item.role] ?? 0) + 1;
  return out;
}, {});
const checks: [string, boolean][] = [
  ["one manager", team.managers.length === 1],
  ["one architect", counts[roles.architect] === 1],
  ["one backend station", counts[roles.backendEngineer] === 1],
  ["one frontend station", counts[roles.frontendEngineer] === 1],
  ["one test station", counts[roles.testEngineer] === 1],
  ["programmatic merger and maintainer", counts[roles.merger] === 1 && counts[roles.maintainer] === 1],
];
let failed = 0;
for (const [name, ok] of checks) { console.log(`${ok ? "PASS" : "FAIL"} ${name}`); if (!ok) failed++; }
console.log(`Core team smoke: ${checks.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
