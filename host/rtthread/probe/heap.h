#ifndef POCKETCOM_PROBE_HEAP_H
#define POCKETCOM_PROBE_HEAP_H
#include <stddef.h>

#define PROBE_HEAP_DEFAULT (7U * 1024U * 1024U)
typedef struct {
  size_t total, used, peak;
  size_t caps_live, caps_peak, caps_blocks, caps_fails;
  size_t walk_free, walk_maxfree, walk_frags;
} probe_heap_stats_t;

/* One fixed arena; no fallback or growth. Init/destroy only outside guest life. */
int probe_heap_init(size_t bytes);
void probe_heap_destroy(void);
probe_heap_stats_t probe_heap_stats(void);
void probe_heap_dump(const char *stage);
void probe_heap_print_fails(void);
int probe_heap_check(void);
/* Not declared in the minimal esp_heap_caps.h shim. */
void *heap_caps_realloc(void *ptr, size_t size, unsigned caps);
#endif
