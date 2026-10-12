/* Off-device memory probe for the AIC package — the "no board needed" twin
 * of the firmware's [PJS-DIAG] staged sampling (host/rtthread/README.md).
 *
 * The same portable components the firmware compiles (guest, ui_core,
 * ui_qjs, package, render_rgb565 and the vendored QuickJS) are linked into
 * a native binary, with malloc backing the heap_caps surface through the
 * port's 3-slot header and live/peak/block accounting. The load path runs
 * the same staged eval as the firmware (pocketjs_guest_eval_stages), so
 * S3-compile and S4-mount report separately, and samples print the same
 * field names as [PJS-DIAG] for side-by-side comparison.
 *
 * What it is NOT: this is not a board simulator. Pointers are 64-bit here
 * and rv32 on the board (JS objects with raw pointers skew larger), the
 * heap is plain malloc (no TLSF, no system threads/WiFi sharing it, no
 * fragmentation modelling), and there is no XIP cache cost. It answers
 * "roughly how much does this package live/peak at, and where" while
 * iterating on the board assembly — board numbers stay the acceptance.
 *
 * Usage: probe <package.pocket> [--heap N] [--limit N] [--turns N]
 *   --heap N   emulate a unified-heap budget: allocations beyond N bytes
 *              fail (approximate breakpoint hunt; failures are counted)
 *   --limit N  QuickJS quota for JS_SetMemoryLimit (default 5 MiB)
 *   --turns N  idle turns after mount, default 120
 */
#include "pocketjs/guest.h"
#include "pocketjs/guest_quickjs.h"
#include "pocketjs/package.h"
#include "pocketjs/ui_core.h"
#include "pocketjs/ui_qjs.h"

#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "quickjs.h"

#include "pocketjs_aic_contract.h"

/* --- heap_caps shim over malloc, port-header compatible ----------------- */

static size_t caps_live;
static size_t caps_peak;
static size_t caps_blocks;
static size_t caps_fails;
static size_t caps_budget; /* 0 = unlimited */

void heap_caps_free(void *ptr);

void *heap_caps_aligned_alloc(size_t alignment, size_t size, unsigned caps) {
  (void)caps;
  if (alignment < sizeof(void *) * 2) {
    alignment = sizeof(void *) * 2;
  }
  const size_t overhead = 3 * sizeof(size_t);
  if (size > SIZE_MAX - (alignment + overhead)) {
    return NULL;
  }
  const size_t charged = size + alignment + overhead;
  if (caps_budget != 0 && caps_live + charged > caps_budget) {
    caps_fails++;
    return NULL;
  }
  unsigned char *raw = malloc(charged);
  if (raw == NULL) {
    caps_fails++;
    return NULL;
  }
  uintptr_t address = (uintptr_t)(raw + overhead);
  address = (address + alignment - 1) & ~(uintptr_t)(alignment - 1);
  ((size_t *)address)[-1] = (size_t)(address - (uintptr_t)raw);
  ((size_t *)address)[-2] = charged;
  ((size_t *)address)[-3] = size;
  caps_live += charged;
  if (caps_live > caps_peak) {
    caps_peak = caps_live;
  }
  caps_blocks++;
  return (void *)address;
}

void *heap_caps_malloc(size_t size, unsigned caps) {
  return heap_caps_aligned_alloc(sizeof(void *) * 2, size, caps);
}

void *heap_caps_calloc(size_t count, size_t size, unsigned caps) {
  if (count != 0 && size > SIZE_MAX / count) {
    return NULL;
  }
  void *memory = heap_caps_malloc(count * size, caps);
  if (memory != NULL) {
    memset(memory, 0, count * size);
  }
  return memory;
}

void *heap_caps_realloc(void *ptr, size_t size, unsigned caps) {
  if (ptr == NULL) {
    return heap_caps_malloc(size, caps);
  }
  const size_t previous = ((size_t *)ptr)[-3];
  void *fresh = heap_caps_malloc(size, caps);
  if (fresh == NULL) {
    return NULL;
  }
  if (previous != 0) {
    memcpy(fresh, ptr, previous < size ? previous : size);
  }
  heap_caps_free(ptr);
  return fresh;
}

void heap_caps_free(void *ptr) {
  if (ptr == NULL) {
    return;
  }
  const size_t back = ((size_t *)ptr)[-1];
  caps_live -= ((size_t *)ptr)[-2];
  caps_blocks--;
  free((unsigned char *)ptr - back);
}

/* --- staged sampling, [PJS-DIAG]-style field names ----------------------- */

static pocketjs_guest_t *sample_guest;

static void sample(const char *stage) {
  printf("[PJS-PROBE] %s caps_live=%zu caps_peak=%zu caps_blocks=%zu "
         "caps_fails=%zu\n",
         stage, caps_live, caps_peak, caps_blocks, caps_fails);
  pocketjs_guest_memstats_t mem = {.struct_size = sizeof(mem)};
  pocketjs_guest_allocstats_t alloc = {.struct_size = sizeof(alloc)};
  pocketjs_guest_stats_t stats = {.struct_size = sizeof(stats)};
  pocketjs_guest_stats(sample_guest, &stats);
  if (pocketjs_guest_memstats(sample_guest, &mem) == 0) {
    printf("[PJS-PROBE] %s js=%zu/%zu atoms=%lld str=%lld obj=%lld "
           "shape=%lld\n",
           stage, mem.malloc_size, mem.malloc_limit,
           (long long)mem.atom_count, (long long)mem.str_count,
           (long long)mem.obj_count, (long long)mem.shape_count);
  }
  pocketjs_guest_allocstats(sample_guest, &alloc);
  printf("[PJS-PROBE] %s guest_live=%zu guest_peak=%zu rloc=%u/%u "
         "frames=%u/%u\n",
         stage, alloc.live, alloc.peak, (unsigned)alloc.reallocs,
         (unsigned)alloc.realloc_shrinks, stats.frames, stats.frame_errors);
}

static void eval_stage_cb(pocketjs_guest_t *guest,
                          pocketjs_guest_eval_stage_t stage, int result,
                          void *user) {
  (void)user;
  if (stage == POCKETJS_GUEST_EVAL_COMPILED) {
    sample("S3-compile");
  } else if (stage == POCKETJS_GUEST_EVAL_EXECUTED) {
    sample(result == 0 ? "S4-mount" : "S4-mount-failed");
  }
}

static unsigned char *read_file(const char *name, size_t *size) {
  FILE *file = fopen(name, "rb");
  if (file == NULL) {
    return NULL;
  }
  fseek(file, 0, SEEK_END);
  long length = ftell(file);
  rewind(file);
  if (length <= 0) {
    fclose(file);
    return NULL;
  }
  unsigned char *bytes = malloc((size_t)length);
  if (bytes == NULL || fread(bytes, 1, (size_t)length, file) != (size_t)length) {
    fclose(file);
    free(bytes);
    return NULL;
  }
  fclose(file);
  *size = (size_t)length;
  return bytes;
}

static size_t parse_size(const char *text) {
  char *end = NULL;
  unsigned long long value = strtoull(text, &end, 0);
  if (end == NULL || *end == '\0') {
    return (size_t)value; /* plain bytes */
  }
  if (*end == 'k' || *end == 'K') {
    return (size_t)(value * 1024);
  }
  if (*end == 'm' || *end == 'M') {
    return (size_t)(value * 1024 * 1024);
  }
  return (size_t)value;
}

#define CHECK(call)                                                           \
  do {                                                                        \
    int error = (call);                                                       \
    if (error != 0) {                                                         \
      fprintf(stderr, "probe: %s failed: %d (caps_live=%zu caps_peak=%zu "    \
              "caps_fails=%zu)\n",                                            \
              #call, error, caps_live, caps_peak, caps_fails);                \
      return 1;                                                               \
    }                                                                         \
  } while (0)

int main(int argc, char **argv) {
  const char *package_path = NULL;
  size_t heap_limit = 5U * 1024U * 1024U;
  long turns = 120;

  for (int index = 1; index < argc; index++) {
    const char *argument = argv[index];
    if (strcmp(argument, "--heap") == 0 && index + 1 < argc) {
      caps_budget = parse_size(argv[++index]);
    } else if (strcmp(argument, "--limit") == 0 && index + 1 < argc) {
      heap_limit = parse_size(argv[++index]);
    } else if (strcmp(argument, "--turns") == 0 && index + 1 < argc) {
      turns = strtol(argv[++index], NULL, 0);
    } else if (argument[0] != '-') {
      package_path = argument;
    }
  }
  if (package_path == NULL) {
    fprintf(stderr,
            "usage: probe <package.pocket> [--heap N] [--limit N] "
            "[--turns N]\n");
    return 2;
  }

  size_t package_size = 0;
  unsigned char *package_bytes = read_file(package_path, &package_size);
  if (package_bytes == NULL) {
    fprintf(stderr, "probe: cannot read %s (run \"npm run package:aic\"?)\n",
            package_path);
    return 2;
  }
  if (caps_budget != 0) {
    printf("[PJS-PROBE] budget caps_budget=%zu (allocation failures beyond "
           "this are injected)\n",
           caps_budget);
  }

  pocketjs_guest_config_t guest_config;
  pocketjs_guest_config_defaults(&guest_config);
  guest_config.heap_limit = heap_limit;
  guest_config.stack_limit = 256U * 1024U;
  guest_config.gc_threshold = 3U * 1024U * 1024U;
  pocketjs_guest_t *guest = NULL;
  CHECK(pocketjs_guest_create(&guest_config, &guest));
  sample_guest = guest;

  pocketjs_ui_core_config_t core_config;
  pocketjs_ui_core_config_defaults(&core_config);
  core_config.logical_width = POCKETJS_AIC_CONTRACT_LOGICAL_WIDTH;
  core_config.logical_height = POCKETJS_AIC_CONTRACT_LOGICAL_HEIGHT;
  core_config.raster_density = POCKETJS_AIC_CONTRACT_RASTER_DENSITY;
  core_config.tick_hz = POCKETJS_AIC_CONTRACT_TICK_HZ;
  pocketjs_ui_core_t *core = NULL;
  CHECK(pocketjs_ui_core_create(&core_config, &core));

  pocketjs_ui_qjs_config_t binding_config = {
      .struct_size = sizeof(binding_config),
      .target_id = POCKETJS_AIC_CONTRACT_TARGET_ID,
      .host_abi = POCKETJS_AIC_CONTRACT_HOST_ABI,
  };
  pocketjs_ui_qjs_t *binding = NULL;
  CHECK(pocketjs_ui_qjs_create(guest, core, &binding_config, &binding));

  pocketjs_package_t *package = NULL;
  CHECK(pocketjs_package_open(package_bytes, package_size, 0, &package));
  pocketjs_package_host_contract_t contract;
  contract.struct_size = sizeof(contract);
  contract.target_id = POCKETJS_AIC_CONTRACT_TARGET_ID;
  contract.host_abi = POCKETJS_AIC_CONTRACT_HOST_ABI;
  contract.tick_hz = POCKETJS_AIC_CONTRACT_TICK_HZ;
  contract.logical_width = POCKETJS_AIC_CONTRACT_LOGICAL_WIDTH;
  contract.logical_height = POCKETJS_AIC_CONTRACT_LOGICAL_HEIGHT;
  contract.physical_width = POCKETJS_AIC_CONTRACT_PHYSICAL_WIDTH;
  contract.physical_height = POCKETJS_AIC_CONTRACT_PHYSICAL_HEIGHT;
  contract.raster_density = POCKETJS_AIC_CONTRACT_RASTER_DENSITY;
  contract.presentation = POCKETJS_AIC_CONTRACT_PRESENTATION;
  memcpy(contract.profile_hash, pocketjs_aic_contract_profile_hash,
         POCKETJS_PACKAGE_HASH_BYTES);
  pocketjs_package_variant_t variant;
  variant.struct_size = sizeof(variant);
  CHECK(pocketjs_package_select(package, &contract, &variant));
  printf("[PJS-PROBE] package %s (%zu bytes, contract ok)\n", package_path,
         package_size);

  CHECK(pocketjs_ui_qjs_feed_pak(binding, variant.pak.data, variant.pak.size));
  CHECK(pocketjs_ui_qjs_mount(binding));
  sample("S2-uibind");

  /* App-level console noise should fail loudly, not vanish into stdout. */
  JSContext *context = pocketjs_guest_quickjs_context(guest);
  const char *logfix = "console.error=(e)=>{throw e};console.warn=console.log";
  JSValue patch = JS_Eval(context, logfix, strlen(logfix), "logfix",
                          JS_EVAL_TYPE_GLOBAL);
  JS_FreeValue(context, patch);

  CHECK(pocketjs_guest_eval_stages(guest, (const char *)variant.javascript.data,
                                   variant.javascript.size - 1U,
                                   POCKETJS_AIC_CONTRACT_TARGET_ID,
                                   eval_stage_cb, NULL));

  /* Idle turns: no renderer/targets here (the firmware's S5 renderer adds
   * a small, known delta), just the guest frame loop with empty input. */
  for (long turn = 1; turn <= turns; turn++) {
    pocketjs_ui_input_t input;
    memset(&input, 0, sizeof(input));
    input.struct_size = sizeof(input);
    pocketjs_ui_frame_view_t frame;
    memset(&frame, 0, sizeof(frame));
    frame.struct_size = sizeof(frame);
    CHECK(pocketjs_ui_turn(binding, &input, &frame));
    if (turn == 1) {
      sample("S5-frame1");
    } else if (turn == turns) {
      sample("S5-steady");
    }
  }
  printf("[PJS-PROBE] done turns=%ld caps_live=%zu caps_peak=%zu "
         "caps_fails=%zu\n",
         turns, caps_live, caps_peak, caps_fails);

  pocketjs_ui_qjs_destroy(binding);
  pocketjs_guest_destroy(guest);
  pocketjs_ui_core_destroy(core);
  pocketjs_package_close(package);
  free(package_bytes);
  return 0;
}

void rust_eh_personality(void) {
  abort();
}
