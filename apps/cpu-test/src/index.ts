const BURN_ITERATIONS = 10_000_000;

function burnCpu(iterations: number): number {
  let acc = 0;
  for (let i = 0; i < iterations; i++) {
    acc = Math.trunc(Math.imul(acc, 31) + i);
  }
  return acc;
}

export default {
  fetch(): Response {
    return new Response('cpu-test worker v2', { status: 200 });
  },

  scheduled(): void {
    const acc = burnCpu(BURN_ITERATIONS);
    console.log(`cpu-test done iterations=${BURN_ITERATIONS} acc=${acc}`);
  },
};
