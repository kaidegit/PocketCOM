/* Native probe adapter over the exact TLSF source used by RT-Thread's
 * rt_tlsf_heap.c. The single arena replaces PSRAM_SW; package/XIP bytes and
 * native process infrastructure remain outside it. No per-block libc malloc.
 * Keep heap_caps' three slots and allocate-copy-free realloc like the port. */
#include "heap.h"
#include "esp_heap_caps.h"
#include "tlsf.h"
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void *arena;
static tlsf_t heap;
static probe_heap_stats_t stats;
#define FAIL_RING 8U
static struct { size_t size, alignment, free, maxfree; } failures[FAIL_RING];

int probe_heap_init(size_t bytes) {
  if (arena || bytes < tlsf_size() + tlsf_pool_overhead() + tlsf_block_size_min() ||
      bytes - tlsf_size() - tlsf_pool_overhead() > tlsf_block_size_max()) return -1;
  arena = malloc(bytes);
  if (!arena) return -1;
  heap = tlsf_create_with_pool(arena, bytes);
  if (!heap) { free(arena); arena = NULL; return -1; }
  memset(&stats, 0, sizeof(stats));
  memset(failures, 0, sizeof(failures));
  stats.total = bytes;
  return 0;
}

void probe_heap_destroy(void) {
  if (heap) tlsf_destroy(heap);
  free(arena);
  arena = NULL;
  heap = NULL;
  memset(&stats, 0, sizeof(stats));
}

static void walk(void *ptr, size_t size, int used, void *user) {
  (void)ptr;
  probe_heap_stats_t *out = user;
  if (!used) {
    out->walk_free += size;
    out->walk_frags++;
    if (size > out->walk_maxfree) out->walk_maxfree = size;
  }
}

probe_heap_stats_t probe_heap_stats(void) {
  probe_heap_stats_t out = stats;
  if (heap) tlsf_walk_pool(tlsf_get_pool(heap), walk, &out);
  return out;
}

probe_heap_stats_t probe_heap_usage(void) { return stats; }

int probe_heap_check(void) {
  return heap ? tlsf_check(heap) || tlsf_check_pool(tlsf_get_pool(heap)) : -1;
}

void probe_heap_dump(const char *stage) {
  const probe_heap_stats_t s = probe_heap_stats();
  printf("[PJS-PROBE] %s sys=%zu/%zu sys_max=%zu\n", stage, s.used, s.total, s.peak);
  printf("[PJS-PROBE] %s walk_free=%zu walk_maxfree=%zu walk_frags=%zu\n",
         stage, s.walk_free, s.walk_maxfree, s.walk_frags);
  printf("[PJS-PROBE] %s caps_live=%zu caps_peak=%zu caps_blocks=%zu caps_fails=%zu\n",
         stage, s.caps_live, s.caps_peak, s.caps_blocks, s.caps_fails);
}

static void *failed(size_t size, size_t alignment) {
  const probe_heap_stats_t s = probe_heap_stats();
  const size_t i = stats.caps_fails++ % FAIL_RING;
  failures[i].size = size;
  failures[i].alignment = alignment;
  failures[i].free = s.walk_free;
  failures[i].maxfree = s.walk_maxfree;
  return NULL;
}

void probe_heap_print_fails(void) {
  const size_t count = stats.caps_fails < FAIL_RING ? stats.caps_fails : FAIL_RING;
  for (size_t n = stats.caps_fails - count; n < stats.caps_fails; n++) {
    const size_t i = n % FAIL_RING;
    printf("[PJS-PROBE] heap-fail #%zu charged=%zu align=%zu walk_free=%zu walk_maxfree=%zu\n",
           n + 1, failures[i].size, failures[i].alignment, failures[i].free, failures[i].maxfree);
  }
}

void *heap_caps_aligned_alloc(size_t alignment, size_t size, unsigned caps) {
  (void)caps;
  if (alignment < 2 * sizeof(void *)) alignment = 2 * sizeof(void *);
  const size_t overhead = 3 * sizeof(size_t);
  if ((alignment & (alignment - 1)) || alignment > SIZE_MAX - overhead ||
      size > SIZE_MAX - alignment - overhead) return failed(size, alignment);
  const size_t charged = size + alignment + overhead;
  unsigned char *raw = heap ? tlsf_malloc(heap, charged) : NULL;
  if (!raw) return failed(charged, alignment);
  stats.used += tlsf_block_size(raw);
  if (stats.used > stats.peak) stats.peak = stats.used;
  stats.caps_live += charged;
  if (stats.caps_live > stats.caps_peak) stats.caps_peak = stats.caps_live;
  stats.caps_blocks++;
  uintptr_t address = (uintptr_t)(raw + overhead);
  address = (address + alignment - 1) & ~(uintptr_t)(alignment - 1);
  ((size_t *)address)[-1] = address - (uintptr_t)raw;
  ((size_t *)address)[-2] = charged;
  ((size_t *)address)[-3] = size;
  return (void *)address;
}

void *heap_caps_malloc(size_t size, unsigned caps) {
  return heap_caps_aligned_alloc(2 * sizeof(void *), size, caps);
}
void *heap_caps_calloc(size_t count, size_t size, unsigned caps) {
  if (count && size > SIZE_MAX / count) return failed(SIZE_MAX, 2 * sizeof(void *));
  void *ptr = heap_caps_malloc(count * size, caps);
  if (ptr) memset(ptr, 0, count * size);
  return ptr;
}
void *heap_caps_realloc(void *ptr, size_t size, unsigned caps) {
  if (!ptr) return heap_caps_malloc(size, caps);
  const size_t previous = ((size_t *)ptr)[-3];
  void *fresh = heap_caps_malloc(size, caps);
  if (!fresh) return NULL;
  memcpy(fresh, ptr, previous < size ? previous : size);
  heap_caps_free(ptr);
  return fresh;
}
void heap_caps_free(void *ptr) {
  if (!ptr) return;
  unsigned char *raw = (unsigned char *)ptr - ((size_t *)ptr)[-1];
  stats.caps_live -= ((size_t *)ptr)[-2];
  stats.caps_blocks--;
  stats.used -= tlsf_block_size(raw);
  tlsf_free(heap, raw);
}
