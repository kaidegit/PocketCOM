#include "heap.h"
#include "esp_heap_caps.h"
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

int main(void) {
  assert(probe_heap_init(1) != 0);
  assert(probe_heap_init(64 * 1024) == 0);
  assert(probe_heap_init(64 * 1024) != 0);
  const probe_heap_stats_t empty = probe_heap_stats();
  assert(empty.total == 64 * 1024 && empty.walk_frags == 1);
  assert(empty.walk_free > 32 * 1024 && empty.walk_free < empty.total);

  unsigned char *aligned = heap_caps_aligned_alloc(256, 100, 0);
  assert(aligned && (uintptr_t)aligned % 256 == 0);
  memset(aligned, 0xa5, 100);
  assert(heap_caps_realloc(aligned, 64 * 1024, 0) == NULL);
  for (size_t i = 0; i < 100; i++) assert(aligned[i] == 0xa5);
  unsigned char *larger = heap_caps_realloc(aligned, 1000, 0);
  assert(larger);
  for (size_t i = 0; i < 100; i++) assert(larger[i] == 0xa5);
  heap_caps_free(larger);
  unsigned char *zero = heap_caps_calloc(64, 3, 0);
  assert(zero);
  for (size_t i = 0; i < 192; i++) assert(zero[i] == 0);
  heap_caps_free(zero);
  assert(!heap_caps_malloc(SIZE_MAX, 0));
  assert(!heap_caps_calloc(SIZE_MAX, 2, 0));
  assert(!heap_caps_aligned_alloc(33, 16, 0));
  puts("alignment, calloc, overflow and failed realloc preserve data: ok");

  void *blocks[64] = {0};
  size_t n = 0;
  while (n < 64 && (blocks[n] = heap_caps_malloc(4096, 0))) n++;
  assert(n > 4 && n < 64); /* Exhaustion must fail, never libc fallback. */
  for (size_t i = 0; i < n; i += 2) {
    heap_caps_free(blocks[i]); blocks[i] = NULL;
  }
  const probe_heap_stats_t fragmented = probe_heap_stats();
  assert(fragmented.walk_frags > 2);
  assert(fragmented.walk_free > 8192 && fragmented.walk_maxfree < 8192);
  assert(heap_caps_malloc(8192, 0) == NULL);
  assert(probe_heap_stats().caps_fails == fragmented.caps_fails + 1);
  assert(probe_heap_check() == 0);
  printf("fragmentation rejects 8192 bytes: free=%zu maxfree=%zu fragments=%zu\n",
         fragmented.walk_free, fragmented.walk_maxfree, fragmented.walk_frags);
  for (size_t i = 0; i < n; i++) heap_caps_free(blocks[i]);
  const probe_heap_stats_t freed = probe_heap_stats();
  assert(freed.caps_live == 0 && freed.caps_blocks == 0 && freed.used == 0);
  assert(freed.walk_free == empty.walk_free && freed.walk_frags == 1);
  assert(freed.peak > 0 && freed.caps_peak > 0);
  void *big = heap_caps_malloc(empty.walk_free / 2, 0);
  assert(big); heap_caps_free(big);
  assert(probe_heap_check() == 0);
  puts("adjacent free blocks coalesce and become allocatable again: ok");
  probe_heap_dump("test");
  probe_heap_print_fails();
  probe_heap_destroy();
  assert(probe_heap_init(128 * 1024) == 0);
  assert(probe_heap_stats().caps_fails == 0);
  probe_heap_destroy();
  return 0;
}
