#include "pocketjs_gc.h"
#include <assert.h>
#include <stdio.h>

int main(void) {
  pocketjs_aic_gc_t gc = {0};
  const size_t m = 1024U * 1024U;
  assert(pocketjs_aic_gc_due(&gc, 0, 1000, 4*m, 2*m, false));
  pocketjs_aic_gc_collected(&gc, 0, 3*m);
  assert(!pocketjs_aic_gc_due(&gc, 16, 1000, 3*m, 2*m, false));
  assert(!pocketjs_aic_gc_due(&gc, 16, 1000, 3*m+128*1024-1, 2*m, false));
  assert(pocketjs_aic_gc_due(&gc, 16, 1000, 3*m+128*1024, 2*m, false));
  assert(!pocketjs_aic_gc_due(&gc, 16, 1000, 3*m+32*1024-1, m, false));
  assert(pocketjs_aic_gc_due(&gc, 16, 1000, 3*m+32*1024, m, false));
  assert(!pocketjs_aic_gc_due(&gc, 1999, 1000, 3*m, m, false));
  assert(pocketjs_aic_gc_due(&gc, 2000, 1000, 3*m, m, false));
  assert(!pocketjs_aic_gc_due(&gc, 2000, 1000, 3*m, m+1, false));
  assert(pocketjs_aic_gc_due(&gc, 2000, 1000, 3*m, m+1, true));
  /* A full, irreducible live set becomes the new baseline, not an every-frame
   * trigger. A drop below it must not underflow the growth calculation. */
  pocketjs_aic_gc_collected(&gc, 2000, 6*m);
  assert(!pocketjs_aic_gc_due(&gc, 2016, 1000, 6*m, 0, false));
  assert(!pocketjs_aic_gc_due(&gc, 2016, 1000, 2*m, 0, false));
  /* SDK starts near UINT32_MAX. Check both wrap and non-1000 Hz clocks. */
  pocketjs_aic_gc_collected(&gc, UINT32_MAX-99, 3*m);
  assert(!pocketjs_aic_gc_due(&gc, 99, 100, 3*m, 2*m, true));
  assert(pocketjs_aic_gc_due(&gc, 100, 100, 3*m, 2*m, true));
  puts("startup, growth, pressure, busy timeout, hysteresis and tick wrap: ok");
  return 0;
}
