const threshold = 0.85;
const lcov = await Bun.file("coverage/lcov.info").text();

let linesFound = 0;
let linesHit = 0;
let functionsFound = 0;
let functionsHit = 0;

for (const line of lcov.split("\n")) {
  if (line.startsWith("DA:")) {
    const hits = Number(line.slice(3).split(",")[1]);
    linesFound += 1;
    if (hits > 0) linesHit += 1;
  } else if (line.startsWith("FNF:")) {
    functionsFound += Number(line.slice(4));
  } else if (line.startsWith("FNH:")) {
    functionsHit += Number(line.slice(4));
  }
}

const lineCoverage = linesFound === 0 ? 0 : linesHit / linesFound;
const functionCoverage =
  functionsFound === 0 ? 0 : functionsHit / functionsFound;

const format = (value: number): string => `${(value * 100).toFixed(2)}%`;
console.log(
  `Coverage gate: ${format(lineCoverage)} lines, ${format(functionCoverage)} functions`,
);

if (lineCoverage < threshold || functionCoverage < threshold) {
  throw new Error(
    `Aggregate line and function coverage must both be at least ${format(threshold)}`,
  );
}
