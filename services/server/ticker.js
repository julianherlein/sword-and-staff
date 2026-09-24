// Fixed-timestep clock. Timers are coarse (setInterval(16.7) fires every ~22ms on Windows), so
// running one tick per callback makes the game run slow. Instead, each call runs as many ticks as
// real time has elapsed. After a long stall (sleep, debugger) it drops the backlog instead of
// fast-forwarding the match.
export function createTicker(tick, rate, now = () => performance.now(), maxCatchUp = 5) {
  const stepMs = 1000 / rate;
  let last = now();
  let acc = 0;
  return function advance() {
    const t = now();
    acc += t - last;
    last = t;
    let ran = 0;
    while (acc >= stepMs && ran < maxCatchUp) {
      tick();
      acc -= stepMs;
      ran++;
    }
    if (ran === maxCatchUp && acc >= stepMs) acc = 0;
    return ran;
  };
}
