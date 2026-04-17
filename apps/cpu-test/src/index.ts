// Deliberately CPU-burning scheduled handler used to empirically verify which
// `usage_model` new Cloudflare Workers default to. The iteration count is
// calibrated to run well over 50ms of CPU — so under `bundled` (50ms cap) the
// cron should be killed with `exceededCpu`, and under `standard` it should
// complete with `outcome=ok`. Ground truth is the cron outcome in
// `wrangler tail --format json` (cpuTimeMs + outcome).
// bump to force a new version so `usage_model=standard` actually applies;
// terraform provider treats the deprecated attribute as "no diff" in-place.
const BURN_ITERATIONS = 200_000_001;

function burnCpu(iterations: number): number {
  let acc = 0;
  for (let i = 0; i < iterations; i++) {
    acc = Math.trunc(Math.imul(acc, 31) + i);
  }
  return acc;
}

export default {
  fetch(): Response {
    return new Response('cpu-test worker', { status: 200 });
  },

  scheduled(): void {
    const acc = burnCpu(BURN_ITERATIONS);
    console.log(`cpu-test done iterations=${BURN_ITERATIONS} acc=${acc}`);
  },
};
