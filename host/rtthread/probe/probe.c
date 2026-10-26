/* Off-device memory probe for the AIC package — the "no board needed" twin
 * of the firmware's [PJS-DIAG] staged sampling (host/rtthread/README.md).
 *
 * The same portable components the firmware compiles (guest, ui_core,
 * ui_qjs, package, render_rgb565 and the vendored QuickJS) are linked into
 * a native binary, with one fixed SDK TLSF arena backing heap_caps through the
 * port's 3-slot header and live/peak/block accounting. The load path runs
 * the same staged eval as the firmware (pocketjs_guest_eval_stages), so
 * S3-compile and S4-mount report separately, and samples print the same
 * field names as [PJS-DIAG] for side-by-side comparison.
 *
 * What it is NOT: this is not a board simulator. Pointers are 64-bit here
 * and rv32 on the board (JS objects with raw pointers skew larger), the
 * TLSF arena has no system threads/WiFi sharing it, and there is no XIP
 * cache cost. Fragmentation is real but differs with pointer width/workload. It answers
 * "roughly how much does this package live/peak at, and where" while
 * iterating on the board assembly — board numbers stay the acceptance.
 *
 * Usage: probe <package.pocket> [--heap N] [--limit N] [--turns N]
 *              [--tap X,Y@TURN] [--sample TURN] [--collect TURN] [--aic-gc]
 *   --heap N   fixed contiguous TLSF arena size (default 7 MiB), no growth
 *              or malloc fallback; failures include fragmentation
 *   --limit N  QuickJS quota for JS_SetMemoryLimit (default 5 MiB)
 *   --turns N  idle turns after mount, default 120
 *   --tap     one touch-down at TURN, released on the following turn
 *   --sample  print an additional S6-turnN memory sample after TURN
 *   --collect run guest GC after TURN and print S7-gcN (explicit experiment)
 *   --aic-gc  firmware frame-boundary policy, virtual time at contract tick Hz
 *   --aic-gc-idle  old idle-only policy for comparison (raster revision idle)
 */
#include "pocketjs/guest.h"
#include "pocketjs/guest_quickjs.h"
#include "pocketjs/package.h"
#include "pocketjs/ui_core.h"
#include "pocketjs/ui_qjs.h"

#include "heap.h"
#include "pocketjs_gc.h"

#include <errno.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "quickjs.h"

#include "pocketjs_aic_contract.h"

/* --- staged sampling, [PJS-DIAG]-style field names ----------------------- */

static pocketjs_guest_t *sample_guest;

static void sample(const char *stage) {
  probe_heap_dump(stage);
  if (!sample_guest) return;
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
  errno = 0;
  unsigned long long value = strtoull(text, &end, 0);
  size_t factor = 1;
  if (end && (*end == 'k' || *end == 'K')) { factor = 1024; end++; }
  else if (end && (*end == 'm' || *end == 'M')) { factor = 1024 * 1024; end++; }
  if (errno || end == text || !end || *end || text[0] == '-' ||
      !value || value > SIZE_MAX / factor) return 0;
  return (size_t)value * factor;
}

#define CHECK(call) \
  do { \
    int error = (call); \
    if (error != 0) { \
      fprintf(stderr, "probe: %s failed: %d\n", #call, error); \
      sample("failed"); \
      probe_heap_print_fails(); \
      return 1; \
    } \
  } while (0)

#define PROBE_EVENT_LIMIT 512U
static struct { unsigned x, y; long turn; } taps[PROBE_EVENT_LIMIT];
static long sample_turns[PROBE_EVENT_LIMIT];
static long collect_turns[PROBE_EVENT_LIMIT];

int main(int argc, char **argv) {
  const char *package_path = NULL;
  size_t caps_budget = PROBE_HEAP_DEFAULT;
  size_t heap_limit = 5U * 1024U * 1024U;
  long turns = 120;
  int aic_gc = 0; /* 0 = none, 1 = firmware, 2 = old idle-only policy */
  size_t gc_count = 0;
  size_t tap_count = 0U;
  size_t sample_count = 0U;
  size_t collect_count = 0U;

  for (int index = 1; index < argc; index++) {
    const char *argument = argv[index];
    if (strcmp(argument, "--aic-gc") == 0 || strcmp(argument, "--aic-gc-idle") == 0) {
      const int mode = strcmp(argument, "--aic-gc") == 0 ? 1 : 2;
      if (aic_gc && aic_gc != mode) {
        fprintf(stderr, "probe: --aic-gc and --aic-gc-idle are mutually exclusive\n");
        return 2;
      }
      aic_gc = mode;
    } else if (strcmp(argument, "--heap") == 0 && index + 1 < argc) {
      caps_budget = parse_size(argv[++index]);
    } else if (strcmp(argument, "--limit") == 0 && index + 1 < argc) {
      heap_limit = parse_size(argv[++index]);
    } else if (strcmp(argument, "--turns") == 0 && index + 1 < argc) {
      turns = strtol(argv[++index], NULL, 0);
    } else if (strcmp(argument, "--tap") == 0 && index + 1 < argc) {
      char trailing;
      if (tap_count == PROBE_EVENT_LIMIT ||
          sscanf(argv[++index], "%u,%u@%ld%c", &taps[tap_count].x,
                 &taps[tap_count].y, &taps[tap_count].turn, &trailing) != 3 ||
          taps[tap_count].x >= POCKETJS_AIC_CONTRACT_LOGICAL_WIDTH ||
          taps[tap_count].y >= POCKETJS_AIC_CONTRACT_LOGICAL_HEIGHT ||
          taps[tap_count].turn < 1) {
        fprintf(stderr, "probe: --tap expects X,Y@TURN within the viewport (max 512)\n");
        return 2;
      }
      tap_count++;
    } else if (strcmp(argument, "--sample") == 0 && index + 1 < argc) {
      char *end = NULL;
      const long at = strtol(argv[++index], &end, 10);
      if (sample_count == PROBE_EVENT_LIMIT || *end != '\0' || at < 1) {
        fprintf(stderr, "probe: --sample expects a positive turn (max 512)\n");
        return 2;
      }
      sample_turns[sample_count++] = at;
    } else if (strcmp(argument, "--collect") == 0 && index + 1 < argc) {
      char *end = NULL;
      const long at = strtol(argv[++index], &end, 10);
      if (collect_count == PROBE_EVENT_LIMIT || *end != '\0' || at < 1) {
        fprintf(stderr, "probe: --collect expects a positive turn (max 512)\n");
        return 2;
      }
      collect_turns[collect_count++] = at;
    } else if (argument[0] != '-') {
      package_path = argument;
    } else {
      fprintf(stderr, "probe: unknown or incomplete option: %s\n", argument);
      return 2;
    }
  }
  if (package_path == NULL) {
    fprintf(stderr,
            "usage: probe <package.pocket> [--heap N] [--limit N] "
            "[--turns N] [--tap X,Y@TURN] [--sample TURN] [--collect TURN] "
            "[--aic-gc | --aic-gc-idle]\n");
    return 2;
  }
  if (aic_gc && collect_count) {
    fprintf(stderr, "probe: --collect cannot be combined with an AIC GC policy\n");
    return 2;
  }
  for (size_t i = 0; i < tap_count; i++) {
    if (taps[i].turn >= turns) {
      fprintf(stderr, "probe: tap turn must precede --turns so release is observed\n");
      return 2;
    }
  }
  for (size_t i = 0; i < sample_count; i++) {
    if (sample_turns[i] > turns) {
      fprintf(stderr, "probe: sample turn exceeds --turns\n");
      return 2;
    }
  }
  for (size_t i = 0; i < collect_count; i++) {
    if (collect_turns[i] > turns) {
      fprintf(stderr, "probe: collection turn exceeds --turns\n");
      return 2;
    }
  }

  if (!caps_budget || !heap_limit) {
    fprintf(stderr, "probe: --heap and --limit require positive sizes (bytes/k/m)\n");
    return 2;
  }
  if (probe_heap_init(caps_budget) != 0) {
    fprintf(stderr, "probe: cannot initialize %zu-byte TLSF arena\n", caps_budget);
    return 2;
  }
  printf("[PJS-PROBE] allocator=tlsf-sdk arena=%zu pointer_bits=%zu\n",
         caps_budget, 8 * sizeof(void *));

  size_t package_size = 0;
  unsigned char *package_bytes = read_file(package_path, &package_size);
  if (package_bytes == NULL) {
    fprintf(stderr, "probe: cannot read %s (run \"npm run package:aic\"?)\n",
            package_path);
    return 2;
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

  pocketjs_aic_gc_t gc = {0};
  if (aic_gc == 1) {
    pocketjs_guest_run_gc(guest);
    gc_count++;
    sample("S5-gc");
  }
  if (aic_gc) pocketjs_aic_gc_collected(&gc, 0U, probe_heap_usage().caps_live);
  uint64_t raster_revision = UINT64_MAX;

  /* Idle turns: no renderer/targets here (the firmware's S5 renderer adds
   * a small, known delta), just the guest frame loop with empty input. */
  for (long turn = 1; turn <= turns; turn++) {
    pocketjs_ui_input_t input;
    memset(&input, 0, sizeof(input));
    input.struct_size = sizeof(input);
    pocketjs_ui_touch_t touch = {0};
    for (size_t i = 0; i < tap_count; i++) {
      if (taps[i].turn == turn) {
        touch.x = (uint16_t)taps[i].x;
        touch.y = (uint16_t)taps[i].y;
        input.touches = &touch;
        input.touch_count = 1U;
        break;
      }
    }
    pocketjs_ui_frame_view_t frame;
    memset(&frame, 0, sizeof(frame));
    frame.struct_size = sizeof(frame);
    CHECK(pocketjs_ui_turn(binding, &input, &frame));
    if (aic_gc) {
      const uint32_t tick = (uint32_t)((uint64_t)turn * 1000U / POCKETJS_AIC_CONTRACT_TICK_HZ);
      const bool idle = frame.raster_revision == raster_revision;
      const probe_heap_stats_t heap = probe_heap_usage();
      const size_t available = heap.total > heap.used ? heap.total - heap.used : 0U;
      const bool due = aic_gc == 1
        ? pocketjs_aic_gc_due(&gc, tick, 1000U, heap.caps_live, available, idle)
        : idle && (uint32_t)(tick - gc.tick) >= 2000U;
      if (due) {
        pocketjs_guest_run_gc(guest);
        gc_count++;
        pocketjs_aic_gc_collected(&gc, tick, probe_heap_usage().caps_live);
      }
    }
    raster_revision = frame.raster_revision;
    if (turn == 1) {
      sample("S5-frame1");
    } else if (turn == turns) {
      sample("S5-steady");
    }
    for (size_t i = 0; i < sample_count; i++) {
      if (sample_turns[i] == turn) {
        char label[40];
        snprintf(label, sizeof(label), "S6-turn%ld", turn);
        sample(label);
      }
    }
    for (size_t i = 0; i < collect_count; i++) {
      if (collect_turns[i] == turn) {
        pocketjs_guest_run_gc(guest);
        char label[40];
        snprintf(label, sizeof(label), "S7-gc%ld", turn);
        sample(label);
      }
    }
  }
  const probe_heap_stats_t final_heap = probe_heap_stats();
  probe_heap_print_fails();
  printf("[PJS-PROBE] done turns=%ld caps_live=%zu caps_peak=%zu "
         "caps_fails=%zu aic_gc=%d gc_count=%zu\n",
         turns, final_heap.caps_live, final_heap.caps_peak, final_heap.caps_fails,
         aic_gc, gc_count);

  pocketjs_ui_qjs_destroy(binding);
  pocketjs_guest_destroy(guest);
  pocketjs_ui_core_destroy(core);
  pocketjs_package_close(package);
  free(package_bytes);
  const int result = final_heap.caps_fails || probe_heap_check() || probe_heap_stats().caps_blocks;
  probe_heap_destroy();
  return result ? 1 : 0;
}

void rust_eh_personality(void) {
  abort();
}
