/* Minimal RT-Thread stand-in for the off-device probe: the reused esp_compat
 * headers expect an RT-Thread console macro, which maps onto stdout here. */
#ifndef PROBE_RTSTUB_RTTHREAD_H
#define PROBE_RTSTUB_RTTHREAD_H
#include <stdio.h>
#define rt_kprintf printf
#endif
